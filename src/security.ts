// workers/web3-wallet-worker/src/security.ts

import type { WalletConfig, ChainName, ValidationResult } from "./types";
import { DEFAULT_CHAIN_CONFIGS } from "./constants";

export interface ValidationParams {
  config: WalletConfig;
  to: string;
  valueUsd: number;
  chain: ChainName;
}

/**
 * Validate a transaction against security configuration.
 * Checks: max value, whitelist, wallet enabled state.
 */
export async function validateTransaction(
  params: ValidationParams
): Promise<ValidationResult> {
  const { config, to, valueUsd } = params;

  if (!config.enabled) {
    return { allowed: false, reason: "Wallet is disabled" };
  }

  if (valueUsd > config.security.maxTransactionValueUsd) {
    return {
      allowed: false,
      reason: `Transaction value $${valueUsd} exceeds max $${config.security.maxTransactionValueUsd}`,
    };
  }

  if (config.security.whitelistedContractsOnly) {
    const chainConfig = DEFAULT_CHAIN_CONFIGS[params.chain];
    const isDexRouter =
      chainConfig?.dexRouterAddress?.toLowerCase() === to.toLowerCase();

    if (!isDexRouter && !isContractWhitelisted(config, to)) {
      return {
        allowed: false,
        reason: "Contract not in whitelist",
      };
    }
  }

  if (config.security.requireConfirmation && valueUsd > 1000) {
    return {
      allowed: true,
      reason: "Confirmation required",
    };
  }

  return { allowed: true };
}

/**
 * Check if an address is in the whitelist.
 */
export function isContractWhitelisted(
  config: WalletConfig,
  address: string
): boolean {
  return config.security.whitelistedContracts.some(
    (c) => c.toLowerCase() === address.toLowerCase()
  );
}
