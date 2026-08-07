/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/constants.ts

import type { ChainConfig, ChainName, WalletConfig } from "./types";

export const SUPPORTED_CHAINS: ChainName[] = [
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "optimism",
];

/** Default chain configs (RPC URLs set via env/KV, these are placeholders) */
export const DEFAULT_CHAIN_CONFIGS: Record<ChainName, ChainConfig> = {
  ethereum: {
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "",
    currency: "ETH",
    explorerUrl: "https://etherscan.io",
    dexRouterAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    wrappedNativeAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    enabled: true,
  },
  bsc: {
    name: "BNB Smart Chain",
    chainId: 56,
    rpcUrl: "",
    currency: "BNB",
    explorerUrl: "https://bscscan.com",
    dexRouterAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    wrappedNativeAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    enabled: true,
  },
  polygon: {
    name: "Polygon",
    chainId: 137,
    rpcUrl: "",
    currency: "MATIC",
    explorerUrl: "https://polygonscan.com",
    dexRouterAddress: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    wrappedNativeAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    enabled: false,
  },
  arbitrum: {
    name: "Arbitrum",
    chainId: 42161,
    rpcUrl: "",
    currency: "ETH",
    explorerUrl: "https://arbiscan.io",
    dexRouterAddress: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    wrappedNativeAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    enabled: false,
  },
  optimism: {
    name: "Optimism",
    chainId: 10,
    rpcUrl: "",
    currency: "ETH",
    explorerUrl: "https://optimistic.etherscan.io",
    dexRouterAddress: "",
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006",
    enabled: false,
  },
};

/** Default wallet config */
export const DEFAULT_WALLET_CONFIG: WalletConfig = {
  enabled: true,
  defaultChain: "ethereum",
  dex: {
    slippageTolerance: 0.5,
    gasMultiplier: 1.2,
    maxApprovalAmount: "1000000000000000000000000",
  },
  security: {
    maxTransactionValueUsd: 10000,
    requireConfirmation: true,
    whitelistedContractsOnly: true,
    whitelistedContracts: [],
  },
  updatedAt: 0,
};

/** KV config key */
export const KV_CONFIG_KEY = "wallet:config";

/**
 * Optional max gas price (gwei) for the gas-price trap.
 * When set and current network gas exceeds this value, mutating txs are dropped
 * before signing. See docs/devops/workers/web3-wallet-worker.mdx.
 */
export const KV_MAX_GAS_PRICE_GWEI = "web3:max_gas_price_gwei";

/** Common ERC20 ABI (minimal) */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
] as const;

/** Standard DEX Router ABI (Uniswap V2 compatible) */
export const DEX_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function WETH() pure returns (address)",
] as const;
