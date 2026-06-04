// workers/web3-wallet-worker/src/types.ts

/* ── Chain Configuration ── */
export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  currency: string;
  explorerUrl: string;
  /** DEX router address for this chain (e.g., Uniswap V2 Router) */
  dexRouterAddress?: string;
  /** Native currency wrapped address (e.g., WETH, WBNB) */
  wrappedNativeAddress?: string;
  enabled: boolean;
}

export type ChainName =
  | "ethereum"
  | "bsc"
  | "polygon"
  | "arbitrum"
  | "optimism";

/* ── DEX Configuration ── */
export interface DexConfig {
  slippageTolerance: number; // 0.5 = 0.5%
  gasMultiplier: number; // 1.2 = 20% boost
  maxApprovalAmount: string; // in wei as string
}

/* ── Security Configuration ── */
export interface SecurityConfig {
  maxTransactionValueUsd: number;
  requireConfirmation: boolean;
  whitelistedContractsOnly: boolean;
  whitelistedContracts: string[]; // checksummed addresses
}

/* ── Wallet Configuration (top-level KV config object) ── */
export interface WalletConfig {
  enabled: boolean;
  defaultChain: ChainName;
  dex: DexConfig;
  security: SecurityConfig;
  updatedAt: number; // unix timestamp
}

/* ── Token Information ── */
export interface TokenInfo {
  address: string; // checksummed contract address
  chain: ChainName;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
}

/* ── Swap Request ── */
export interface SwapRequest {
  chain: ChainName;
  tokenIn: string; // token address (or "0x000...000" for native)
  tokenOut: string; // token address
  amountIn: string; // in wei as string
  minAmountOut?: string; // derived from slippage if not provided
  recipient?: string; // defaults to wallet address
  deadline?: number; // unix timestamp, defaults to 20 min from now
}

/* ── Transaction Record ── */
export interface TransactionRecord {
  id: string; // UUID
  chain: ChainName;
  txHash: string;
  type: "swap" | "approve" | "transfer" | "wallet_init";
  status: "pending" | "confirmed" | "failed";
  from: string;
  to: string;
  value: string; // in wei
  tokenAddress?: string;
  gasUsed?: string;
  gasPrice?: string;
  blockNumber?: number;
  error?: string;
  createdAt: number;
  confirmedAt?: number;
}

/* ── Balance Response ── */
export interface BalanceResult {
  chain: ChainName;
  token: TokenInfo;
  balance: string; // in wei as string
  balanceFormatted: string; // human-readable
}

/* ── Validation Result ── */
export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}
