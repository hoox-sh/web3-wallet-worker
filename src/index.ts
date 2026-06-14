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
import { getQuote, executeSwap, checkAllowanceAndApprove } from "./dex";
import { storeTransaction, listTransactions } from "./transactions";
import { validateTransaction } from "./security";
import type {
  ChainName,
  WalletConfig,
  TransactionRecord,
  SwapRequest,
} from "./types";
import { DEFAULT_CHAIN_CONFIGS } from "./constants";

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
import { serviceFetch } from "@jango-blockchained/hoox-shared/service-bindings";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import type { InternalAuthEnv } from "@jango-blockchained/hoox-shared/middleware";
import type { KVNamespace, D1Database } from "@cloudflare/workers-types";

export interface Env extends Cloudflare.Env, AnalyticsEnv, InternalAuthEnv {
  INTERNAL_KEY_BINDING?: string;
  WALLET_CONFIG_KV: KVNamespace;
  TRANSACTIONS_DB: D1Database;
}

const router = createRouter<Env>();
const requireAuth = createInternalAuthMiddleware();
const logger = createLogger({ service: "web3-wallet-worker" });

// ── Helpers ──

/** Cache wallet instances by secret to avoid repeated secp256k1 key derivation */
const walletCache = new Map<string, ethers.Wallet>();

/**
 * Validate an Ethereum address format: must start with 0x, be 42 chars, valid hex.
 */
function isValidEthereumAddress(address: string): boolean {
  return /^(0x)[0-9a-fA-F]{40}$/.test(address);
}

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
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
    let wallet = walletCache.get(privateKey);
    if (!wallet) {
      wallet = new ethers.Wallet(privateKey);
      walletCache.set(privateKey, wallet);
    }
    return { wallet, source: "private_key" };
  }

  if (mnemonic) {
    if (mnemonic.split(" ").length < 12) {
      return Errors.badRequest("Configured mnemonic phrase secret is invalid.");
    }
    let wallet = walletCache.get(mnemonic);
    if (!wallet) {
      wallet = ethers.Wallet.fromPhrase(mnemonic) as unknown as ethers.Wallet;
      walletCache.set(mnemonic, wallet);
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
    logger.info("Calling TELEGRAM_SERVICE binding for notification");
    const resp = await serviceFetch(env.TELEGRAM_SERVICE, "/alert", {
      message,
    });
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

// ── Zod validation schemas (S-02 audit fix) ──
const WalletConfigUpdateSchema = z
  .object({
    chainId: z.number().optional(),
    rpcUrl: z.string().url().optional(),
    maxGasPrice: z.string().optional(),
  })
  .passthrough();

const SwapRequestSchema = z
  .object({
    chain: z.string().optional(),
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
  })
  .passthrough();

const TransactionRequestSchema = z.object({
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  value: z.string(),
  data: z.string().optional(),
  gasLimit: z.string().optional(),
});

const TransferTokenSchema = z.object({
  chain: z.string().optional(),
  tokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  to: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  amount: z.string().optional(),
});

const ApproveTokenSchema = z.object({
  chain: z.string().optional(),
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
      const config = await getConfig(env.WALLET_CONFIG_KV);

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
      const config = await getConfig(env.WALLET_CONFIG_KV);
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

      const current = await getConfig(env.WALLET_CONFIG_KV);
      const merged: WalletConfig = { ...current, ...body };
      await updateConfig(env.WALLET_CONFIG_KV, merged);

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
    env: Env,
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
      const wallet = connectWallet(baseWallet, body.chain);
      const amount = BigInt(body.amount);
      const config = await getConfig(env.WALLET_CONFIG_KV);

      const validation = await validateTransaction({
        config,
        to: body.tokenAddress,
        valueUsd: 0,
        chain: body.chain,
      });
      if (!validation.allowed) {
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

      const walletResult = createWalletFromEnv(env);
      if (walletResult instanceof Response) return walletResult;
      const baseWallet = walletResult.wallet;
      const wallet = connectWallet(baseWallet, body.chain);
      const amount = BigInt(body.amount);
      const txHash = await approveToken(
        wallet,
        body.tokenAddress,
        body.spender,
        amount
      );

      const record: TransactionRecord = {
        id: crypto.randomUUID(),
        chain: body.chain,
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
    env: Env,
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
      if (!body.tokenIn || !body.tokenOut || !body.amountIn) {
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
      const wallet = connectWallet(baseWallet, body.chain);
      const config = await getConfig(env.WALLET_CONFIG_KV);

      const chainConfig = DEFAULT_CHAIN_CONFIGS[body.chain];
      const routerAddr = chainConfig?.dexRouterAddress;
      if (!routerAddr) {
        return Errors.badRequest(
          `No DEX router configured for chain: ${body.chain}`
        );
      }

      const txHash = await executeSwap(wallet, body.chain, body, config);

      const record: TransactionRecord = {
        id: crypto.randomUUID(),
        chain: body.chain,
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
