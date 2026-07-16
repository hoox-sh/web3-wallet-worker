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
 * Validate an ERC-20 transfer: recipient limits + optional token contract whitelist.
 */
export async function validateOutgoingTransfer(
  params: ValidationParams & { tokenAddress: string }
): Promise<ValidationResult> {
  const recipientCheck = await validateTransaction({
    config: params.config,
    to: params.to,
    valueUsd: params.valueUsd,
    chain: params.chain,
  });
  if (!recipientCheck.allowed) {
    return recipientCheck;
  }

  if (params.config.security.whitelistedContractsOnly) {
    const chainConfig = DEFAULT_CHAIN_CONFIGS[params.chain];
    const isDexRouter =
      chainConfig?.dexRouterAddress?.toLowerCase() ===
      params.tokenAddress.toLowerCase();
    if (!isDexRouter && !isContractWhitelisted(params.config, params.tokenAddress)) {
      return {
        allowed: false,
        reason: "Token contract not in whitelist",
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate a DEX swap against security policy (router + token whitelist + value cap).
 */
export async function validateSwapTransaction(
  params: ValidationParams & { tokenIn: string; tokenOut: string }
): Promise<ValidationResult> {
  const chainConfig = DEFAULT_CHAIN_CONFIGS[params.chain];
  const routerAddr = chainConfig?.dexRouterAddress;
  if (!routerAddr) {
    return { allowed: false, reason: "No DEX router configured for chain" };
  }

  const routerCheck = await validateTransaction({
    config: params.config,
    to: routerAddr,
    valueUsd: params.valueUsd,
    chain: params.chain,
  });
  if (!routerCheck.allowed) {
    return routerCheck;
  }

  if (params.config.security.whitelistedContractsOnly) {
    const native = "0x0000000000000000000000000000000000000000";
    for (const token of [params.tokenIn, params.tokenOut]) {
      if (token.toLowerCase() === native) continue;
      const isRouter = routerAddr.toLowerCase() === token.toLowerCase();
      if (!isRouter && !isContractWhitelisted(params.config, token)) {
        return {
          allowed: false,
          reason: `Token ${token} not in whitelist`,
        };
      }
    }
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
