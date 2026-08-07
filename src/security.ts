/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/security.ts

import type { WalletConfig, ChainName, ValidationResult } from "./types";
import { DEFAULT_CHAIN_CONFIGS } from "./constants";

/** Zero / burn address — never a valid transfer recipient or approve spender. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Minimal provider surface for gas checks (avoids hard ethers import in pure validation). */
export interface GasFeeProvider {
  getFeeData(): Promise<{
    maxFeePerGas?: bigint | null;
    gasPrice?: bigint | null;
  }>;
}

/** Convert wei → gwei as a number (1 gwei = 1e9 wei). */
function weiToGwei(wei: bigint): number {
  // Keep a few decimal places without floating-point bigint overflow
  const gweiInt = wei / 1_000_000_000n;
  const rem = wei % 1_000_000_000n;
  return Number(gweiInt) + Number(rem) / 1e9;
}

export interface ValidationParams {
  config: WalletConfig;
  to: string;
  valueUsd: number;
  chain: ChainName;
}

/**
 * Strict EVM address check: 0x + 40 hex chars (not EIP-55 checksum).
 * Rejects zero address by default.
 */
export function isValidEthereumAddress(
  address: string,
  opts: { allowZero?: boolean } = {}
): boolean {
  if (typeof address !== "string" || !/^(0x)[0-9a-fA-F]{40}$/.test(address)) {
    return false;
  }
  if (!opts.allowZero && address.toLowerCase() === ZERO_ADDRESS) {
    return false;
  }
  return true;
}

/**
 * Parse a non-negative integer amount string as bigint.
 * Rejects empty, hex with 0x prefix ambiguity for user amounts, negatives, decimals.
 */
export function parsePositiveAmount(
  amount: string
): { ok: true; value: bigint } | { ok: false; reason: string } {
  if (typeof amount !== "string" || amount.trim() === "") {
    return { ok: false, reason: "Amount is required" };
  }
  const s = amount.trim();
  // Reject scientific notation / decimals / signs — amounts are wei integers
  if (!/^(0|[1-9]\d*)$/.test(s)) {
    return {
      ok: false,
      reason: "Amount must be a non-negative integer string (wei)",
    };
  }
  try {
    const value = BigInt(s);
    if (value < 0n) {
      return { ok: false, reason: "Amount must be non-negative" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "Invalid amount format" };
  }
}

/**
 * Gas price trap: if current network fee data exceeds maxGwei, block signing.
 * When maxGwei is null/undefined/0, the trap is disabled.
 */
export async function checkGasPriceLimit(params: {
  provider: GasFeeProvider;
  maxGasPriceGwei: number | null | undefined;
}): Promise<ValidationResult> {
  const max = params.maxGasPriceGwei;
  if (
    max === null ||
    max === undefined ||
    !(max > 0) ||
    !Number.isFinite(max)
  ) {
    return { allowed: true };
  }

  try {
    const fee = await params.provider.getFeeData();
    // Prefer maxFeePerGas (EIP-1559); fall back to gasPrice
    const gasPriceWei = fee.maxFeePerGas ?? fee.gasPrice;
    if (gasPriceWei === null || gasPriceWei === undefined) {
      // Fail closed when we cannot read gas — avoid signing into unknown fee environment
      return {
        allowed: false,
        reason: "Unable to read network gas price; transaction blocked",
      };
    }
    const gwei = weiToGwei(gasPriceWei);
    if (!Number.isFinite(gwei)) {
      return {
        allowed: false,
        reason: "Unable to parse network gas price; transaction blocked",
      };
    }
    if (gwei > max) {
      return {
        allowed: false,
        reason: `Network gas price ${gwei.toFixed(2)} gwei exceeds max ${max} gwei`,
      };
    }
    return { allowed: true };
  } catch {
    return {
      allowed: false,
      reason: "Gas price check failed; transaction blocked (fail-closed)",
    };
  }
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
