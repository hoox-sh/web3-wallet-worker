import { ethers } from "ethers";
import type { Fetcher } from "@cloudflare/workers-types";

export interface Web3TransactionPayload {
  to: string;
  value: string;
  data?: string;
}

import { ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  // Define bindings here
  // KVNamespace: MY_KV_NAMESPACE;
  // DurableObjectNamespace: MY_DURABLE_OBJECT;
  // R2Bucket: MY_BUCKET;
  // D1Database: DB;

  // Secrets Store Bindings (names match wrangler.toml)
  WALLET_PK_SECRET?: string;
  WALLET_MNEMONIC_SECRET?: string;

  // Service bindings
  TELEGRAM_SERVICE: Fetcher;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    console.log(`Handling request: ${request.method} ${request.url}`);

    // Allow wallet to be either HDNodeWallet (fromPhrase) or Wallet (from private key)
    let wallet: ethers.HDNodeWallet | ethers.Wallet;

    try {
      // Attempt to get secrets from Secrets Store bindings
      const privateKey = env.WALLET_PK_SECRET;
      const mnemonic = env.WALLET_MNEMONIC_SECRET;

      if (privateKey) {
        // Prioritize Private Key if retrieved
        console.log("Using WALLET_PK_SECRET from Secrets Store.");
        // Basic validation for private key
        if (!/^0x?[0-9a-fA-F]{64}$/.test(privateKey)) {
          console.error(
            "Retrieved WALLET_PK_SECRET secret has invalid format."
          );
          return new Response("Configured private key secret is invalid.", {
            status: 500,
          });
        }
        wallet = new ethers.Wallet(
          privateKey.startsWith("0x") ? privateKey : "0x" + privateKey
        );
      } else if (mnemonic) {
        // Use Mnemonic Phrase if retrieved and no private key was found
        console.log("Using WALLET_MNEMONIC_SECRET from Secrets Store.");
        // Basic validation - check if it looks like a mnemonic
        if (mnemonic.split(" ").length < 12) {
          console.error(
            "Retrieved WALLET_MNEMONIC_SECRET secret has invalid format."
          );
          return new Response("Configured mnemonic phrase secret is invalid.", {
            status: 500,
          });
        }
        wallet = ethers.Wallet.fromPhrase(mnemonic);
      } else {
        // Neither secret could be retrieved
        console.error(
          "Could not retrieve WALLET_PK_SECRET or WALLET_MNEMONIC_SECRET from bindings."
        );
        return new Response(
          "Required wallet secret binding not configured or accessible.",
          { status: 500 }
        );
      }

      // Wallet created successfully
      console.log(`Wallet Address: ${wallet.address}`);

      // --- Task 10.5: Example Inter-Worker Communication ---
      // Example: Send notification via telegram-worker after wallet initialization
      try {
        const notificationMessage = `Web3 Wallet Worker initialized successfully. Address: ${wallet.address}`;

        // Use TELEGRAM_SERVICE binding - no URL needed
        console.log(`Calling TELEGRAM_SERVICE binding for notification...`);
        const notificationResponse = await env.TELEGRAM_SERVICE.fetch('/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: notificationMessage }),
        });
        
        if (!notificationResponse.ok) {
          console.error(
            `Error calling TELEGRAM_SERVICE for notification: ${notificationResponse.status} ${await notificationResponse.text()}`
          );
        } else {
          console.log(`Notification sent via TELEGRAM_SERVICE binding.`);
        }
      } catch (notificationError: unknown) {
        const errorMsg =
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError || "Unknown notification error");
        console.error(
          `Exception calling TELEGRAM_SERVICE for notification:`,
          errorMsg,
          notificationError
        );
      }
      // --- End Task 10.5 ---

      // Example: Return the wallet address
      const responseBody = JSON.stringify({
        message: "Worker initialized successfully using Secrets Store.",
        walletAddress: wallet.address,
      });

      return new Response(responseBody, {
        headers: { "Content-Type": "application/json" },
        // status defaults to 200
      });
    } catch (error) {
      console.error("Error processing request:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
      });
    }
  },
};
