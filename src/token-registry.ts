/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/token-registry.ts
// Curated symbols + raw-address/mint passthrough. Unknown human names throw.

import type { ChainName } from "./types";

export interface CuratedToken {
  symbol: string;
  /** EVM contract or native sentinel. */
  address?: string;
  /** Solana mint. */
  mint?: string;
  decimals: number;
}

export interface ResolvedToken {
  symbol?: string;
  address?: string;
  mint?: string;
  /** `-1` means unknown; caller should fetch on-chain / RPC decimals. */
  decimals: number;
}

const ETHEREUM: Record<string, CuratedToken> = {
  ETH: {
    symbol: "ETH",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
  },
  WETH: {
    symbol: "WETH",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
  },
  DAI: {
    symbol: "DAI",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
  },
  WBTC: {
    symbol: "WBTC",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 8,
  },
};

const ARBITRUM: Record<string, CuratedToken> = {
  ETH: {
    symbol: "ETH",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
  },
  WETH: {
    symbol: "WETH",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18,
  },
  USDC: {
    symbol: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    address: "0xFd086bC7CD5c481DCC9C85ebE478A1C0b69FCbb9",
    decimals: 6,
  },
};

const SOLANA: Record<string, CuratedToken> = {
  SOL: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  USDC: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
};

const BY_CHAIN: Partial<Record<ChainName, Record<string, CuratedToken>>> = {
  ethereum: ETHEREUM,
  arbitrum: ARBITRUM,
  solana: SOLANA,
};

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
/** Solana base58 pubkeys/mints are 32–44 chars (no 0/O/I/l). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Resolve a human symbol, 0x address, or Solana mint.
 *
 * Curated symbols return known decimals. Well-formed raw mints/addresses
 * that are not in the catalog return `{ decimals: -1 }` so the caller can
 * fetch decimals (e.g. `getSolanaMintDecimals`). Unknown human names throw.
 */
export function resolveToken(chain: ChainName, token: string): ResolvedToken {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("Token is required");
  }
  const trimmed = token.trim();
  const catalog = BY_CHAIN[chain];

  const bySymbol = catalog?.[trimmed.toUpperCase()];
  if (bySymbol) return { ...bySymbol };

  if (catalog) {
    const lower = trimmed.toLowerCase();
    for (const entry of Object.values(catalog)) {
      if (entry.address && entry.address.toLowerCase() === lower) {
        return { ...entry };
      }
      if (entry.mint && entry.mint === trimmed) {
        return { ...entry };
      }
    }
  }

  if (EVM_ADDR_RE.test(trimmed)) {
    return { address: trimmed, decimals: -1 };
  }
  if (BASE58_RE.test(trimmed)) {
    return { mint: trimmed, decimals: -1 };
  }

  throw new Error(`Unknown token symbol: ${trimmed}`);
}
