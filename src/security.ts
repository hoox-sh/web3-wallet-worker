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

  // Reject non-positive notional — a client cannot understate value to 0
  // to bypass maxTransactionValueUsd. Server-side price oracles should
  // eventually replace client-supplied valueUsd entirely (defense in depth).
  if (!(valueUsd > 0) || !Number.isFinite(valueUsd)) {
    return {
      allowed: false,
      reason: "valueUsd must be a positive finite number",
    };
  }

  // Confirmation gate is FAIL-CLOSED: high-value txs require an explicit
  // two-phase confirmation flow. Returning allowed:true here previously
  // made requireConfirmation a no-op (handlers only check .allowed).
  if (config.security.requireConfirmation && valueUsd > 1000) {
    return {
      allowed: false,
      reason: "Confirmation required",
    };
  }

  return { allowed: true };
}

/**
 * Validate an ERC-20 approve against security policy.
 * Approvals are often more dangerous than single transfers (spender can drain).
 */
export async function validateApproval(
  params: ValidationParams & {
    tokenAddress: string;
    spender: string;
    amount: string;
    maxApprovalAmount?: string;
  }
): Promise<ValidationResult> {
  const { config, tokenAddress, spender, amount } = params;

  if (!config.enabled) {
    return { allowed: false, reason: "Wallet is disabled" };
  }

  // Spender must pass the same contract policy as any other destination
  const spenderCheck = await validateTransaction({
    config,
    to: spender,
    // Approvals don't move funds directly — use a nominal positive value so
    // valueUsd positivity checks pass; amount caps handle size separately.
    valueUsd: 1,
    chain: params.chain,
  });
  if (!spenderCheck.allowed) {
    // Rephrase for approve context when the issue is confirmation/value —
    // whitelist/disabled messages already apply.
    return spenderCheck;
  }

  if (config.security.whitelistedContractsOnly) {
    if (!isContractWhitelisted(config, tokenAddress)) {
      const chainConfig = DEFAULT_CHAIN_CONFIGS[params.chain];
      const isDexRouter =
        chainConfig?.dexRouterAddress?.toLowerCase() ===
        tokenAddress.toLowerCase();
      if (!isDexRouter) {
        return {
          allowed: false,
          reason: "Token contract not in whitelist",
        };
      }
    }
  }

  // Cap approve amount against configured maxApprovalAmount when provided
  const maxApproval = params.maxApprovalAmount;
  if (maxApproval) {
    try {
      const amountBn = BigInt(amount);
      const maxBn = BigInt(maxApproval);
      if (amountBn > maxBn) {
        return {
          allowed: false,
          reason: `Approval amount exceeds maxApprovalAmount (${maxApproval})`,
        };
      }
    } catch {
      return {
        allowed: false,
        reason: "Invalid approval amount format",
      };
    }
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
    if (
      !isDexRouter &&
      !isContractWhitelisted(params.config, params.tokenAddress)
    ) {
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
