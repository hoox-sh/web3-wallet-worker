// workers/web3-wallet-worker/src/providers.ts

import { ethers } from "ethers";
import type { ChainName } from "./types";
import { getChainConfig } from "./config";

/**
 * Get a read-only JsonRpcProvider for the given chain.
 * RPC URLs should be set in KV config per chain.
 */
export function getReadOnlyProvider(chain: ChainName): ethers.JsonRpcProvider {
  const config = getChainConfig(chain);
  const rpcUrl = config.rpcUrl || "https://eth.llamarpc.com"; // fallback
  return new ethers.JsonRpcProvider(rpcUrl, config.chainId, {
    staticNetwork: true,
  });
}

/**
 * Get a signer-connected provider (wallet + provider) for the given chain.
 */
export function getProvider(chain: ChainName): ethers.JsonRpcProvider {
  return getReadOnlyProvider(chain);
}

/**
 * Create an ethers Wallet from a private key (hex) or mnemonic phrase.
 * Auto-detects format: hex with 64+ chars = private key, else mnemonic.
 */
export function getWallet(secret: string): ethers.Wallet {
  const isPrivateKey = /^(0x)?[0-9a-fA-F]{64}$/.test(secret);
  if (isPrivateKey) {
    const key = secret.startsWith("0x") ? secret : `0x${secret}`;
    return new ethers.Wallet(key);
  }
  // fromPhrase returns HDNodeWallet which extends Wallet
  return ethers.Wallet.fromPhrase(secret) as unknown as ethers.Wallet;
}

/**
 * Connect a wallet to a provider for the given chain.
 */
export function connectWallet(
  wallet: ethers.Wallet,
  chain: ChainName
): ethers.Wallet {
  const provider = getProvider(chain);
  return wallet.connect(provider);
}
