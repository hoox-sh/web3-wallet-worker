// workers/web3-wallet-worker/src/config.ts

import type { KVNamespace } from "@cloudflare/workers-types";
import type {
  WalletConfig,
  ChainConfig,
  ChainName,
  DexConfig,
  SecurityConfig,
} from "./types";
import {
  KV_CONFIG_KEY,
  DEFAULT_WALLET_CONFIG,
  DEFAULT_CHAIN_CONFIGS,
} from "./constants";

/**
 * Load wallet configuration from KV, falling back to defaults.
 * Never fails — returns defaults on any error.
 */
export async function getConfig(kv: KVNamespace): Promise<WalletConfig> {
  try {
    const raw = await kv.get(KV_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_WALLET_CONFIG, updatedAt: Date.now() };
    const parsed = JSON.parse(raw) as Partial<WalletConfig>;
    return { ...DEFAULT_WALLET_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_WALLET_CONFIG, updatedAt: Date.now() };
  }
}

/**
 * Persist wallet configuration to KV.
 */
export async function updateConfig(
  kv: KVNamespace,
  config: WalletConfig
): Promise<void> {
  config.updatedAt = Date.now();
  await kv.put(KV_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Get chain configuration for a given chain name.
 * Throws if chain is unsupported.
 */
export function getChainConfig(chain: ChainName): ChainConfig {
  const config = DEFAULT_CHAIN_CONFIGS[chain];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain}`);
  }
  return { ...config };
}

/**
 * Extract DEX config from wallet config.
 */
export function getDexConfig(config: WalletConfig): DexConfig {
  return { ...config.dex };
}

/**
 * Extract security config from wallet config.
 */
export function getSecurityConfig(config: WalletConfig): SecurityConfig {
  return { ...config.security };
}
