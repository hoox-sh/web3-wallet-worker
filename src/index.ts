// workers/web3-wallet-worker/src/index.ts
// ethers v6 works with nodejs_compat flag (enabled in wrangler.jsonc).
// nodejs_compat provides Node.js crypto polyfills that ethers v6 requires.

import { ethers } from "ethers";
import { z } from "zod/v4";
import { getConfig, updateConfig } from "./config";
import { getReadOnlyProvider, connectWallet } from "./providers";
import {
  getNativeBalance,
  getTokenBalance,
  getTokenInfo,
  formatBalance,
  approveToken,
  transferToken,
} from "./tokens";
import { getQuote, executeSwap } from "./dex";
import { storeTransaction, listTransactions } from "./transactions";
import {
  validateOutgoingTransfer,
  validateSwapTransaction,
  validateApproval,
} from "./security";
import { resolveEnforcedValueUsd } from "./pricing";
import type {
  ChainName,
  WalletConfig,
  TransactionRecord,
  SwapRequest,
} from "./types";
import { DEFAULT_CHAIN_CONFIGS, KV_CONFIG_KEY } from "./constants";

import {
  createJsonResponse,
  Errors,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
  createInternalAuthMiddleware,
} from "@jango-blockchained/hoox-shared/middleware";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";
import {
  authenticatedServiceFetch,
  TELEGRAM_ALERT_AUTH_KEY_FIELDS,
  WALLET_EXECUTE_AUTH_KEY_FIELDS,
  resolveInternalAuthKey,
  type AuthenticatedServiceEnv,
} from "@jango-blockchained/hoox-shared/service-bindings";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import type { InternalAuthEnv } from "@jango-blockchained/hoox-shared/middleware";
import type { KVNamespace, D1Database } from "@cloudflare/workers-types";

export interface Env extends AnalyticsEnv, InternalAuthEnv {
  // Worker bindings (declared in wrangler.jsonc, ids match shared CONFIG_KV
  // and legacy WALLET_CONFIG_KV; see src/config.ts for migration logic).
  CONFIG_KV: KVNamespace;
  WALLET_CONFIG_KV: KVNamespace;
  TRANSACTIONS_DB: D1Database;
  // Wrangler secret bindings (created via `wrangler secret put`).
  WALLET_PK_SECRET?: string;
  WALLET_MNEMONIC_SECRET?: string;
  // Service bindings (see wrangler.jsonc services block).
  TELEGRAM_SERVICE: Fetcher;
  ANALYTICS_SERVICE: Fetcher;
}

const router = createRouter<Env>();
const requireAuth = createInternalAuthMiddleware(WALLET_EXECUTE_AUTH_KEY_FIELDS);
const logger = createLogger({ service: "web3-wallet-worker" });

// ── Migration ──

/**
 * Sentinel key written to CONFIG_KV once the one-shot migration from the legacy
 * WALLET_CONFIG_KV namespace has completed. Prevents re-running on every request.
 */
const MIGRATION_MARKER_KEY = "migrated:v1";

/**
 * In-flight migration guard. Workers may handle many requests concurrently;
 * a module-scoped Promise ensures the migration runs at most once per isolate
 * (subsequent callers await the same Promise).
 */
let migrationPromise: Promise<void> | null = null;

/**
 * One-shot copy from the legacy WALLET_CONFIG_KV namespace to the shared
 * CONFIG_KV namespace. Runs only when CONFIG_KV is empty AND WALLET_CONFIG_KV
 * has data. Idempotent: the `migrated:v1` marker in CONFIG_KV makes repeat
 * calls a no-op.
 *
 * Failures are logged but do NOT throw — the route handlers must continue to
 * work even if the legacy KV is unreachable (e.g. namespace already deleted).
 */
async function ensureConfigMigrated(env: Env): Promise<void> {
  if (migrationPromise) return migrationPromise;

  const run = async (): Promise<void> => {
    try {
      const [marker, existing, legacy] = await Promise.all([
        env.CONFIG_KV.get(MIGRATION_MARKER_KEY),
        env.CONFIG_KV.get(KV_CONFIG_KEY),
        env.WALLET_CONFIG_KV.get(KV_CONFIG_KEY),
      ]);

      // Already migrated or destination already populated — nothing to do.
      if (marker !== null) return;
      if (existing !== null) {
        // CONFIG_KV has data but no marker — write marker to prevent re-check.
        await env.CONFIG_KV.put(MIGRATION_MARKER_KEY, new Date().toISOString());
        return;
      }
      if (legacy === null) {
        // No source data — still mark so we don't keep checking.
        await env.CONFIG_KV.put(MIGRATION_MARKER_KEY, new Date().toISOString());
        return;
      }

      await env.CONFIG_KV.put(KV_CONFIG_KEY, legacy);
      await env.CONFIG_KV.put(MIGRATION_MARKER_KEY, new Date().toISOString());
      logger.info("Migrated wallet config from WALLET_CONFIG_KV to CONFIG_KV");
    } catch (err) {
      logger.error("ensureConfigMigrated failed", {
        error: toError(err, "Unknown"),
      });
    }
  };

  migrationPromise = run();
  return migrationPromise;
}

// ── Helpers ──

/** Opaque cache keys — never use secret material as Map keys (heap retention risk). */
const WALLET_CACHE_KEY_PK = "wallet:pk:v1";
const WALLET_CACHE_KEY_MNEMONIC = "wallet:mnemonic:v1";

/** Cache wallet instances per isolate to avoid repeated secp256k1 key derivation */
const walletCache = new Map<string, ethers.Wallet>();

/**
 * Validate an Ethereum address format: must start with 0x, be 42 chars, valid hex.
 */
function isValidEthereumAddress(address: string): boolean {
  return /^(0x)[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Parse and validate request body against a Zod schema.
 * Returns null on validation failure (caller should return 400).
 */
async function parseValidatedBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<z.infer<T> | null> {
  try {
    const raw = await request.json();
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function createWalletFromEnv(
  env: Env
): { wallet: ethers.Wallet; source: string } | Response {
  const privateKey = env.WALLET_PK_SECRET;
  const mnemonic = env.WALLET_MNEMONIC_SECRET;

  if (privateKey) {
    if (!/^(0x)[0-9a-fA-F]{64}$/.test(privateKey)) {
      return Errors.badRequest("Configured private key secret is invalid.");
    }
    let wallet = walletCache.get(WALLET_CACHE_KEY_PK);
    if (!wallet) {
      wallet = new ethers.Wallet(privateKey);
      walletCache.set(WALLET_CACHE_KEY_PK, wallet);
    }
    return { wallet, source: "private_key" };
  }

  if (mnemonic) {
    if (mnemonic.split(" ").length < 12) {
      return Errors.badRequest("Configured mnemonic phrase secret is invalid.");
    }
    let wallet = walletCache.get(WALLET_CACHE_KEY_MNEMONIC);
    if (!wallet) {
      wallet = ethers.Wallet.fromPhrase(mnemonic) as unknown as ethers.Wallet;
      walletCache.set(WALLET_CACHE_KEY_MNEMONIC, wallet);
    }
    return { wallet, source: "mnemonic" };
  }

  return Errors.internal(
    "Required wallet secret binding not configured or accessible."
  );
}

function trackApiCall(
  env: Env,
  ctx: ExecutionContext,
  route: string,
  status: number
) {
  ctx.waitUntil(
    trackAnalytics(env, "/track/api-call", {
      worker: "web3-wallet-worker",
      endpoint: route,
      latencyMs: 0,
      success: status < 500,
    }).catch((err) =>
      logger.error("trackAnalytics failed", { error: String(err) })
    )
  );
}

async function sendNotification(
  wallet: ethers.Wallet,
  env: Env,
  message: string
): Promise<void> {
  try {
    if (!env.TELEGRAM_SERVICE) {
      logger.warn(
        "TELEGRAM_SERVICE binding not configured, skipping notification"
      );
      return;
    }
    if (!resolveInternalAuthKey(env, TELEGRAM_ALERT_AUTH_KEY_FIELDS)) {
      logger.error(
        "Telegram alert auth key not configured — cannot notify telegram (fail-closed)"
      );
      return;
    }
    logger.info("Calling TELEGRAM_SERVICE binding for notification");
    const resp = await authenticatedServiceFetch(
      env.TELEGRAM_SERVICE,
      env as AuthenticatedServiceEnv,
      "/alert",
      { message },
      { internalKeyFields: TELEGRAM_ALERT_AUTH_KEY_FIELDS }
    );
    if (!resp.ok) {
      const text = await resp.text();
      logger.error("Error from TELEGRAM_SERVICE", {
        status: resp.status,
        text,
      });
    } else {
      logger.info("Notification sent via TELEGRAM_SERVICE binding");
    }
  } catch (err: unknown) {
    logger.error("Exception calling TELEGRAM_SERVICE", {
      error: toError(err, "Unknown"),
    });
  }
}

// ── Zod validation schemas (S-02 audit fix + C-5 fix) ──
//
// C-5 fix (2026-06-27 worker audit): the previous schema was
// `.passthrough()` and only accepted 3 chain-level fields, but the
// route handler did a SHALLOW merge (`{ ...current, ...body }`). An
// attacker could submit `{ security: { whitelistedContractsOnly:
// false }, dex: { maxApprovalAmount: "999999999999" } }` and replace
// the entire security/dex sub-objects with attacker-controlled
// values. The fix:
// 1. Use `.strict()` so unknown fields are rejected (typos, junk,
//   injection).
// 2. Cover the full WalletConfig shape with nested object schemas
//   that mirror config.ts.
// 3. The route handler does a DEEP merge of `dex` and `security`
//   sub-objects (see PUT /config below).
const DexConfigUpdateSchema = z
  .object({
    slippageTolerance: z.number().nonnegative().optional(),
    gasMultiplier: z.number().positive().optional(),
    maxApprovalAmount: z.string().optional(),
  })
  .strict();

const SecurityConfigUpdateSchema = z
  .object({
    maxTransactionValueUsd: z.number().nonnegative().optional(),
    requireConfirmation: z.boolean().optional(),
    whitelistedContractsOnly: z.boolean().optional(),
    whitelistedContracts: z.array(z.string()).optional(),
  })
  .strict();

const WalletConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultChain: z
      .enum(["ethereum", "bsc", "polygon", "arbitrum", "optimism"])
      .optional(),
    dex: DexConfigUpdateSchema.optional(),
    security: SecurityConfigUpdateSchema.optional(),
  })
  .strict();

const SwapRequestSchema = z.object({
  chain: z
    .enum(["ethereum", "bsc", "polygon", "arbitrum", "optimism"])
    .optional(),
  tokenIn: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  tokenOut: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  amountIn: z.string().optional(),
  amountOutMin: z.string().optional(),
  slippage: z.number().min(0).max(50).optional(),
  recipient: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  deadline: z.number().int().positive().optional(),
  /** USD notional for security limit enforcement (required on mutating routes). */
  valueUsd: z.number().nonnegative().optional(),
});

const TransferTokenSchema = z.object({
  chain: z
    .enum(["ethereum", "bsc", "polygon", "arbitrum", "optimism"])
    .optional(),
  tokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  to: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  amount: z.string().optional(),
  /** USD notional for security limit enforcement (required on mutating routes). */
  valueUsd: z.number().nonnegative().optional(),
});

const ApproveTokenSchema = z.object({
  chain: z
    .enum(["ethereum", "bsc", "polygon", "arbitrum", "optimism"])
    .optional(),
  tokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  spender: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  amount: z.string().optional(),
});

// ── Route: GET / — Wallet init ──

router.get(
  "/",
  async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    logger.info("Handling request", {
      method: request.method,
      url: request.url,
    });

    try {
      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const { wallet, source } = walletResult;
      logger.info("Wallet address resolved", { address: wallet.address });

      ctx.waitUntil(
        trackAnalytics(env, "/track/api-call", {
          worker: "web3-wallet-worker",
          endpoint: "/",
          latencyMs: 0,
          success: true,
        }).catch((err) =>
          logger.error("trackAnalytics failed", { error: String(err) })
        )
      );
      ctx.waitUntil(
        sendNotification(
          wallet,
          env,
          `Web3 Wallet Worker initialized. Address: ${wallet.address} (${source})`
        ).catch((err) =>
          logger.error("sendNotification failed", { error: String(err) })
        )
      );

      return createJsonResponse(
        {
          message: "Worker initialized successfully using Secrets Store.",
          walletAddress: wallet.address,
          source,
        },
        200
      );
    } catch (error: unknown) {
      logger.error("Error processing request", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: GET /health — Health check ──

router.get("/health", async (): Promise<Response> => {
  return healthCheck({ worker: "web3-wallet-worker" });
});

// ── Route: GET /status — Wallet status ──

router.get(
  "/status",
  async (
    _request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const { wallet, source } = walletResult;
      await ensureConfigMigrated(env);
      const config = await getConfig(env.CONFIG_KV);

      return createJsonResponse(
        {
          address: wallet.address,
          source,
          enabled: config.enabled,
          defaultChain: config.defaultChain,
          availableChains: Object.entries(DEFAULT_CHAIN_CONFIGS)
            .filter(([_, c]) => c.enabled)
            .map(([name, c]) => ({
              name,
              chainId: c.chainId,
              currency: c.currency,
            })),
          security: {
            maxTransactionValueUsd: config.security.maxTransactionValueUsd,
            whitelistedContractsOnly: config.security.whitelistedContractsOnly,
          },
          updatedAt: config.updatedAt,
        },
        200
      );
    } catch (error: unknown) {
      logger.error("Error in /status", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: GET /config — Read config ──

router.get(
  "/config",
  async (
    _request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      await ensureConfigMigrated(env);
      const config = await getConfig(env.CONFIG_KV);
      return createJsonResponse(config, 200);
    } catch (error: unknown) {
      logger.error("Error in GET /config", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: PUT /config — Update config ──

router.put(
  "/config",
  async (
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const body = await parseValidatedBody(request, WalletConfigUpdateSchema);
      if (!body) return Errors.badRequest("Invalid JSON body");

      await ensureConfigMigrated(env);
      const current = await getConfig(env.CONFIG_KV);

      // Deep merge: shallow `{ ...current, ...body }` would replace
      // the entire `security` and `dex` sub-objects with whatever
      // the caller sent. Instead, merge each sub-object individually
      // so partial updates (e.g. only flipping whitelistedContractsOnly)
      // don't clobber unrelated fields. (C-5 from the 2026-06-27
      // worker audit.)
      const merged: WalletConfig = {
        ...current,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.defaultChain !== undefined
          ? { defaultChain: body.defaultChain }
          : {}),
        dex: { ...current.dex, ...(body.dex ?? {}) },
        security: { ...current.security, ...(body.security ?? {}) },
      };
      await updateConfig(env.CONFIG_KV, merged);

      return createJsonResponse(
        { message: "Configuration updated", config: merged },
        200
      );
    } catch (error: unknown) {
      logger.error("Error in PUT /config", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: GET /balance — Native or token balance ──

router.get(
  "/balance",
  async (
    request: Request,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const chain = url.searchParams.get("chain") as ChainName | null;
      const tokenAddress = url.searchParams.get("token");
      const address = url.searchParams.get("address");

      if (!chain) return Errors.badRequest("Missing required param: chain");
      if (!address) return Errors.badRequest("Missing required param: address");
      if (!DEFAULT_CHAIN_CONFIGS[chain]) {
        return Errors.badRequest(`Unsupported chain: ${chain}`);
      }

      const provider = getReadOnlyProvider(chain);

      if (tokenAddress) {
        if (!isValidEthereumAddress(tokenAddress)) {
          return Errors.badRequest("Invalid token address format.");
        }
        const tokenInfo = await getTokenInfo(provider, tokenAddress);
        tokenInfo.chain = chain;
        const balance = await getTokenBalance(provider, tokenAddress, address);
        const result = formatBalance(chain, tokenInfo, balance);
        return createJsonResponse(result, 200);
      }

      const rawBalance = await getNativeBalance(provider, address);
      const nativeToken = {
        address: ethers.ZeroAddress,
        chain,
        symbol: DEFAULT_CHAIN_CONFIGS[chain].currency,
        name: DEFAULT_CHAIN_CONFIGS[chain].currency,
        decimals: 18,
      };
      const result = formatBalance(chain, nativeToken, rawBalance);
      return createJsonResponse(result, 200);
    } catch (error: unknown) {
      logger.error("Error in GET /balance", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: POST /transfer — Transfer tokens ──

router.post(
  "/transfer",
  async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const body = await parseValidatedBody(request, TransferTokenSchema);
      if (!body) return Errors.badRequest("Invalid JSON body");
      if (!body.chain || !body.tokenAddress || !body.to || !body.amount) {
        return Errors.badRequest(
          "Missing required fields: chain, tokenAddress, to, amount"
        );
      }
      if (!isValidEthereumAddress(body.tokenAddress)) {
        return Errors.badRequest("Invalid token address format.");
      }

      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const baseWallet = walletResult.wallet;
      // body.chain is validated non-undefined by guard above
      const chain = body.chain!;
      const wallet = connectWallet(baseWallet, chain);
      const amount = BigInt(body.amount);
      await ensureConfigMigrated(env);
      const config = await getConfig(env.CONFIG_KV);

      if (!isValidEthereumAddress(body.to)) {
        return Errors.badRequest("Invalid recipient address format.");
      }

      // Server-side USD pricing — ignore client valueUsd for enforcement
      const priced = await resolveEnforcedValueUsd({
        chain,
        tokenAddress: body.tokenAddress,
        amountRaw: amount,
      });
      if (!priced.ok) {
        return Errors.forbidden(priced.reason);
      }
      const valueUsd = priced.valueUsd;

      const validation = await validateOutgoingTransfer({
        config,
        to: body.to,
        tokenAddress: body.tokenAddress,
        valueUsd,
        chain: body.chain,
      });
      if (!validation.allowed) {
        // 403 for policy denies; 409 for confirmation-required so clients can
        // distinguish "forbidden" from "needs second step".
        if (validation.reason === "Confirmation required") {
          return createJsonResponse(
            {
              success: false,
              error: validation.reason,
              code: "CONFIRMATION_REQUIRED",
              valueUsd,
            },
            409
          );
        }
        return Errors.forbidden(validation.reason || "Transaction not allowed");
      }

      const txHash = await transferToken(
        wallet,
        body.tokenAddress,
        body.to,
        amount
      );

      const record: TransactionRecord = {
        id: crypto.randomUUID(),
        chain: body.chain,
        txHash,
        type: "transfer",
        status: "pending",
        from: wallet.address,
        to: body.to,
        value: body.amount,
        tokenAddress: body.tokenAddress,
        createdAt: Date.now(),
      };
      await storeTransaction(env.TRANSACTIONS_DB, record);

      trackApiCall(env, ctx, "/transfer", 200);
      return createJsonResponse({ txHash, id: record.id }, 200);
    } catch (error: unknown) {
      logger.error("Error in POST /transfer", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: POST /approve — Approve token spending ──

router.post(
  "/approve",
  async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const body = await parseValidatedBody(request, ApproveTokenSchema);
      if (!body) return Errors.badRequest("Invalid JSON body");
      if (!body.chain || !body.tokenAddress || !body.spender || !body.amount) {
        return Errors.badRequest(
          "Missing required fields: chain, tokenAddress, spender, amount"
        );
      }
      if (!isValidEthereumAddress(body.tokenAddress)) {
        return Errors.badRequest("Invalid token address format.");
      }
      if (!isValidEthereumAddress(body.spender)) {
        return Errors.badRequest("Invalid spender address format.");
      }

      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const baseWallet = walletResult.wallet;
      // body.chain is validated non-undefined by guard above
      const chain = body.chain!;
      const wallet = connectWallet(baseWallet, chain);
      await ensureConfigMigrated(env);
      const config = await getConfig(env.CONFIG_KV);

      // C5: approvals previously skipped all security policy checks.
      const approvalCheck = await validateApproval({
        config,
        to: body.spender,
        tokenAddress: body.tokenAddress,
        spender: body.spender,
        amount: body.amount,
        valueUsd: 1,
        chain,
        maxApprovalAmount: config.dex.maxApprovalAmount,
      });
      if (!approvalCheck.allowed) {
        return Errors.forbidden(
          approvalCheck.reason || "Approval not allowed by security policy"
        );
      }

      const amount = BigInt(body.amount);
      const txHash = await approveToken(
        wallet,
        body.tokenAddress,
        body.spender,
        amount
      );

      const record: TransactionRecord = {
        id: crypto.randomUUID(),
        chain,
        txHash,
        type: "approve",
        status: "pending",
        from: wallet.address,
        to: body.spender,
        value: "0",
        tokenAddress: body.tokenAddress,
        createdAt: Date.now(),
      };
      await storeTransaction(env.TRANSACTIONS_DB, record);

      trackApiCall(env, ctx, "/approve", 200);
      return createJsonResponse({ txHash, id: record.id }, 200);
    } catch (error: unknown) {
      logger.error("Error in POST /approve", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: GET /quote — DEX swap quote ──

router.get(
  "/quote",
  async (
    request: Request,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const chain = url.searchParams.get("chain") as ChainName | null;
      const tokenIn = url.searchParams.get("tokenIn");
      const tokenOut = url.searchParams.get("tokenOut");
      const amountIn = url.searchParams.get("amountIn");

      if (!chain || !tokenIn || !tokenOut || !amountIn) {
        return Errors.badRequest(
          "Missing required params: chain, tokenIn, tokenOut, amountIn"
        );
      }
      if (!DEFAULT_CHAIN_CONFIGS[chain]) {
        return Errors.badRequest(`Unsupported chain: ${chain}`);
      }
      if (
        !isValidEthereumAddress(tokenIn) ||
        !isValidEthereumAddress(tokenOut)
      ) {
        return Errors.badRequest("Invalid token address format.");
      }

      const provider = getReadOnlyProvider(chain);
      const quote = await getQuote(
        provider,
        chain,
        tokenIn,
        tokenOut,
        BigInt(amountIn)
      );

      const tokenInfo = await getTokenInfo(provider, tokenOut);
      const formatted = formatBalance(chain, tokenInfo, quote);

      return createJsonResponse(
        {
          amountIn,
          amountOut: quote.toString(),
          amountOutFormatted: formatted.balanceFormatted,
          tokenOut,
          chain,
        },
        200
      );
    } catch (error: unknown) {
      logger.error("Error in GET /quote", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: POST /swap — Execute DEX swap ──

router.post(
  "/swap",
  async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const body = await parseValidatedBody(request, SwapRequestSchema);
      if (!body) return Errors.badRequest("Invalid JSON body");
      if (!body.chain || !body.tokenIn || !body.tokenOut || !body.amountIn) {
        return Errors.badRequest(
          "Missing required fields: chain, tokenIn, tokenOut, amountIn"
        );
      }
      if (
        !isValidEthereumAddress(body.tokenIn) ||
        !isValidEthereumAddress(body.tokenOut)
      ) {
        return Errors.badRequest("Invalid token address format.");
      }

      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const baseWallet = walletResult.wallet;
      // body.chain is validated non-undefined by guard above
      const chain = body.chain!;
      const wallet = connectWallet(baseWallet, chain);
      await ensureConfigMigrated(env);
      const config = await getConfig(env.CONFIG_KV);

      const chainConfig = DEFAULT_CHAIN_CONFIGS[chain];
      const routerAddr = chainConfig?.dexRouterAddress;
      if (!routerAddr) {
        return Errors.badRequest(
          `No DEX router configured for chain: ${chain}`
        );
      }

      // Server-side USD pricing of the input amount (ignore client valueUsd)
      let amountInRaw: bigint;
      try {
        amountInRaw = BigInt(body.amountIn);
      } catch {
        return Errors.badRequest("Invalid amountIn");
      }
      const priced = await resolveEnforcedValueUsd({
        chain,
        tokenAddress: body.tokenIn,
        amountRaw: amountInRaw,
      });
      if (!priced.ok) {
        return Errors.forbidden(priced.reason);
      }
      const valueUsd = priced.valueUsd;

      const swapValidation = await validateSwapTransaction({
        config,
        to: routerAddr,
        tokenIn: body.tokenIn,
        tokenOut: body.tokenOut,
        valueUsd,
        chain: body.chain,
      });
      if (!swapValidation.allowed) {
        if (swapValidation.reason === "Confirmation required") {
          return createJsonResponse(
            {
              success: false,
              error: swapValidation.reason,
              code: "CONFIRMATION_REQUIRED",
              valueUsd,
            },
            409
          );
        }
        return Errors.forbidden(
          swapValidation.reason || "Swap not allowed by security policy"
        );
      }

      const txHash = await executeSwap(
        wallet,
        chain,
        body as SwapRequest,
        config
      );

      const record: TransactionRecord = {
        id: crypto.randomUUID(),
        chain,
        txHash,
        type: "swap",
        status: "pending",
        from: wallet.address,
        to: routerAddr,
        value: body.amountIn,
        tokenAddress:
          body.tokenIn === ethers.ZeroAddress ? undefined : body.tokenIn,
        createdAt: Date.now(),
      };
      await storeTransaction(env.TRANSACTIONS_DB, record);

      ctx.waitUntil(
        sendNotification(
          wallet,
          env,
          `Swap executed: ${body.amountIn} → ${txHash.slice(0, 10)}...`
        ).catch((err) =>
          logger.error("sendNotification failed", { error: String(err) })
        )
      );

      trackApiCall(env, ctx, "/swap", 200);
      return createJsonResponse({ txHash, id: record.id }, 200);
    } catch (error: unknown) {
      logger.error("Error in POST /swap", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Route: GET /transactions — List transactions ──

router.get(
  "/transactions",
  async (
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const chain = url.searchParams.get("chain") ?? undefined;
      const type = url.searchParams.get("type") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const limit = url.searchParams.get("limit")
        ? parseInt(url.searchParams.get("limit")!, 10)
        : 50;
      const offset = url.searchParams.get("offset")
        ? parseInt(url.searchParams.get("offset")!, 10)
        : 0;

      const txs = await listTransactions(env.TRANSACTIONS_DB, {
        chain,
        type,
        status,
        limit,
        offset,
      });

      return createJsonResponse({ transactions: txs, count: txs.length }, 200);
    } catch (error: unknown) {
      logger.error("Error in GET /transactions", { error });
      return Errors.internal(error);
    }
  },
  [requireAuth]
);

// ── Export ──

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) =>
      router.handle(request, env, ctx),
    { service: "web3-wallet-worker", module: "router" }
  ),
};
