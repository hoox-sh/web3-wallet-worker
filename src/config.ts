// workers/web3-wallet-worker/src/config.ts

import type { KVNamespace } from "@cloudflare/workers-types";
import { z } from "zod/v4";
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
 * Zod schema for the KV-stored wallet config.
 * All fields optional — merged with DEFAULT_WALLET_CONFIG on load.
 * Strict: rejects unknown keys so a typo doesn't silently break config.
 */
const ChainNameSchema = z.enum([
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "optimism",
]);

const DexConfigSchema = z
  .object({
    slippageTolerance: z.number().nonnegative().optional(),
    gasMultiplier: z.number().positive().optional(),
    maxApprovalAmount: z.string().optional(),
  })
  .strict();

const SecurityConfigSchema = z
  .object({
    maxTransactionValueUsd: z.number().nonnegative().optional(),
    requireConfirmation: z.boolean().optional(),
    whitelistedContractsOnly: z.boolean().optional(),
    whitelistedContracts: z.array(z.string()).optional(),
  })
  .strict();

const WalletConfigFileSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultChain: ChainNameSchema.optional(),
    dex: DexConfigSchema.optional(),
    security: SecurityConfigSchema.optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Load wallet configuration from KV, falling back to defaults.
 * Never fails — returns defaults on any error.
 */
export async function getConfig(kv: KVNamespace): Promise<WalletConfig> {
  try {
    const raw = await kv.get(KV_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_WALLET_CONFIG, updatedAt: Date.now() };
    const result = WalletConfigFileSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      // Malformed config in KV — fall back to defaults rather than crash
      return { ...DEFAULT_WALLET_CONFIG, updatedAt: Date.now() };
    }
    return {
      ...DEFAULT_WALLET_CONFIG,
      ...result.data,
      dex: { ...DEFAULT_WALLET_CONFIG.dex, ...result.data.dex },
      security: { ...DEFAULT_WALLET_CONFIG.security, ...result.data.security },
    };
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
