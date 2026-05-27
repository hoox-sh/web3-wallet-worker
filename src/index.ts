import { ethers } from "ethers";
// ExecutionContext and Fetcher are globally declared by worker-configuration.d.ts

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

export interface Env extends Cloudflare.Env, AnalyticsEnv {
  [key: string]: unknown;
  INTERNAL_KEY_BINDING?: string;
}

const router = createRouter<Env>();
const requireAuth = createInternalAuthMiddleware();
const logger = createLogger({ service: "web3-wallet-worker" });

/**
 * Sends a wallet initialization notification via the TELEGRAM_SERVICE binding.
 * Designed to be used with ctx.waitUntil() for fire-and-forget execution.
 */
async function sendNotification(
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  env: Env
): Promise<void> {
  try {
    const notificationMessage = `Web3 Wallet Worker initialized successfully. Address: ${wallet.address}`;

    if (!env.TELEGRAM_SERVICE) {
      logger.warn(
        "TELEGRAM_SERVICE binding not configured, skipping notification"
      );
    } else {
      logger.info("Calling TELEGRAM_SERVICE binding for notification");
      const notificationResponse = await serviceFetch(
        env.TELEGRAM_SERVICE,
        "/webhook",
        { message: notificationMessage }
      );

      if (!notificationResponse.ok) {
        const errorText = await notificationResponse.text();
        logger.error("Error calling TELEGRAM_SERVICE for notification", {
          status: notificationResponse.status,
          responseText: errorText,
        });
      } else {
        logger.info("Notification sent via TELEGRAM_SERVICE binding");
      }
    }
  } catch (notificationError: unknown) {
    const errorMsg = toError(notificationError, "Unknown notification error");
    logger.error("Exception calling TELEGRAM_SERVICE for notification", {
      errorMsg,
      notificationError,
    });
  }
}

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

    // Allow wallet to be either HDNodeWallet (fromPhrase) or Wallet (from private key)
    let wallet: ethers.HDNodeWallet | ethers.Wallet;

    try {
      // Attempt to get secrets from Secrets Store bindings
      const privateKey = env.WALLET_PK_SECRET;
      const mnemonic = env.WALLET_MNEMONIC_SECRET;

      if (privateKey) {
        // Prioritize Private Key if retrieved
        logger.info("Using WALLET_PK_SECRET from Secrets Store");
        // Basic validation for private key
        if (!/^0x?[0-9a-fA-F]{64}$/.test(privateKey)) {
          logger.error("Retrieved WALLET_PK_SECRET secret has invalid format");
          return Errors.badRequest("Configured private key secret is invalid.");
        }
        wallet = new ethers.Wallet(
          privateKey.startsWith("0x") ? privateKey : "0x" + privateKey
        );
      } else if (mnemonic) {
        // Use Mnemonic Phrase if retrieved and no private key was found
        logger.info("Using WALLET_MNEMONIC_SECRET from Secrets Store");
        // Basic validation - check if it looks like a mnemonic
        if (mnemonic.split(" ").length < 12) {
          logger.error(
            "Retrieved WALLET_MNEMONIC_SECRET secret has invalid format"
          );
          return Errors.badRequest(
            "Configured mnemonic phrase secret is invalid."
          );
        }
        wallet = ethers.Wallet.fromPhrase(mnemonic);
      } else {
        // Neither secret could be retrieved
        logger.error(
          "Could not retrieve WALLET_PK_SECRET or WALLET_MNEMONIC_SECRET from bindings"
        );
        return Errors.internal(
          "Required wallet secret binding not configured or accessible."
        );
      }

      // Wallet created successfully
      logger.info("Wallet address resolved", { address: wallet.address });

      // Track wallet operation analytics (non-blocking)
      ctx.waitUntil(
        trackAnalytics(env, "/track/api-call", {
          worker: "web3-wallet-worker",
          endpoint: "/",
          latencyMs: 0,
          success: true,
        })
      );

      // Send wallet initialization notification via TELEGRAM_SERVICE (non-blocking)
      ctx.waitUntil(sendNotification(wallet, env));

      // Return success response
      return createJsonResponse(
        {
          message: "Worker initialized successfully using Secrets Store.",
          walletAddress: wallet.address,
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

router.get(
  "/health",
  async (
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> => {
    return healthCheck({ worker: "web3-wallet-worker" });
  }
);

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) =>
      router.handle(request, env, ctx),
    { service: "web3-wallet-worker", module: "router" }
  ),
};
