/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/providers.ts

import { ethers } from "ethers";
import type { ChainName } from "./types";
import { getChainConfig } from "./config";

/** Cache provider instances by RPC URL to avoid repeated DNS resolution */
const providerCache = new Map<string, ethers.JsonRpcProvider>();

/** Private key: optional 0x + exactly 64 hex chars. */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Validate RPC URL before constructing a provider.
 * - Require http(s)
 * - Block obvious SSRF targets (metadata, loopback) in production-style URLs
 * Local Anvil/Hardhat (`http://127.0.0.1:8545`) is allowed only for localhost hosts.
 */
export function isSafeRpcUrl(rpcUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  // Cloud metadata / link-local — never allow as RPC
  if (
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  ) {
    return false;
  }
  // Non-local http is discouraged (MITM); allow only localhost over http
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";
  if (url.protocol === "http:" && !isLocal) {
    return false;
  }
  return true;
}

/**
 * Get a read-only JsonRpcProvider for the given chain.
 * RPC URLs should be set in KV config per chain.
 * Providers are cached per RPC URL to avoid repeated DNS resolution.
 */
export function getReadOnlyProvider(chain: ChainName): ethers.JsonRpcProvider {
  const config = getChainConfig(chain);
  const rpcUrl = config.rpcUrl || "https://eth.llamarpc.com"; // fallback
  if (!isSafeRpcUrl(rpcUrl)) {
    throw new Error(`Unsafe or invalid RPC URL for chain: ${chain}`);
  }
  const cacheKey = `${rpcUrl}:${config.chainId}`;

  let provider = providerCache.get(cacheKey);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(rpcUrl, config.chainId, {
      staticNetwork: true,
    });
    providerCache.set(cacheKey, provider);
  }
  return provider;
}

/**
 * Get a signer-connected provider (wallet + provider) for the given chain.
 */
export function getProvider(chain: ChainName): ethers.JsonRpcProvider {
  return getReadOnlyProvider(chain);
}

/**
 * Create an ethers Wallet from a private key (hex) or mnemonic phrase.
 * Auto-detects format: hex with 64 chars = private key, else mnemonic.
 * Never logs the secret.
 */
export function getWallet(secret: string): ethers.Wallet {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Wallet secret is empty");
  }
  const isPrivateKey = PRIVATE_KEY_RE.test(secret.trim());
  if (isPrivateKey) {
    const raw = secret.trim();
    const key = raw.startsWith("0x") ? raw : `0x${raw}`;
    return new ethers.Wallet(key);
  }
  // fromPhrase returns HDNodeWallet which extends Wallet
  return ethers.Wallet.fromPhrase(secret.trim()) as unknown as ethers.Wallet;
}

/**
 * Connect a wallet to a provider for the given chain.
 */
export function connectWallet(
  wallet: ethers.Wallet,
  chain: ChainName
): ethers.Wallet {
  const provider = getProvider(chain);
  return wallet.connect(provider) as ethers.Wallet;
}
