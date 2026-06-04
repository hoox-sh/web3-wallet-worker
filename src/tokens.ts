// workers/web3-wallet-worker/src/tokens.ts

import { ethers } from "ethers";
import type { ChainName, TokenInfo, BalanceResult } from "./types";
import { ERC20_ABI } from "./constants";

/**
 * Fetch ERC20 token metadata (name, symbol, decimals) from on-chain.
 */
export async function getTokenInfo(
  provider: ethers.Provider,
  address: string
): Promise<TokenInfo> {
  const checksummed = ethers.getAddress(address);
  const contract = new ethers.Contract(checksummed, ERC20_ABI, provider);
  const [name, symbol, decimals] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.decimals(),
  ]);
  return {
    address: checksummed,
    chain: "" as ChainName, // filled by caller
    symbol: symbol as string,
    name: name as string,
    decimals: decimals as number,
  };
}

/**
 * Get native currency balance for an address (ETH, BNB, MATIC, etc.).
 */
export async function getNativeBalance(
  provider: ethers.Provider,
  address: string
): Promise<bigint> {
  const checksummed = ethers.getAddress(address);
  return await provider.getBalance(checksummed);
}

/**
 * Get ERC20 token balance for an address.
 */
export async function getTokenBalance(
  provider: ethers.Provider,
  tokenAddress: string,
  ownerAddress: string
): Promise<bigint> {
  const checksummedToken = ethers.getAddress(tokenAddress);
  const checksummedOwner = ethers.getAddress(ownerAddress);
  const contract = new ethers.Contract(checksummedToken, ERC20_ABI, provider);
  return await contract.balanceOf(checksummedOwner);
}

/**
 * Get ERC20 token allowance for a spender.
 */
export async function getAllowance(
  provider: ethers.Provider,
  tokenAddress: string,
  owner: string,
  spender: string
): Promise<bigint> {
  const checksummedToken = ethers.getAddress(tokenAddress);
  const checksummedOwner = ethers.getAddress(owner);
  const checksummedSpender = ethers.getAddress(spender);
  const contract = new ethers.Contract(checksummedToken, ERC20_ABI, provider);
  return await contract.allowance(checksummedOwner, checksummedSpender);
}

/**
 * Approve a spender to spend tokens on behalf of the wallet.
 * Returns the transaction hash.
 */
export async function approveToken(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spender: string,
  amount: bigint
): Promise<string> {
  const checksummedToken = ethers.getAddress(tokenAddress);
  const checksummedSpender = ethers.getAddress(spender);
  const contract = new ethers.Contract(checksummedToken, ERC20_ABI, wallet);
  const tx = await contract.approve(checksummedSpender, amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/**
 * Transfer tokens from the wallet to another address.
 * Returns the transaction hash.
 */
export async function transferToken(
  wallet: ethers.Wallet,
  tokenAddress: string,
  to: string,
  amount: bigint
): Promise<string> {
  const checksummedToken = ethers.getAddress(tokenAddress);
  const checksummedTo = ethers.getAddress(to);
  const contract = new ethers.Contract(checksummedToken, ERC20_ABI, wallet);
  const tx = await contract.transfer(checksummedTo, amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/**
 * Format a bigint balance into a BalanceResult with both wei and human-readable strings.
 */
export function formatBalance(
  chain: ChainName,
  token: TokenInfo,
  balance: bigint
): BalanceResult {
  return {
    chain,
    token,
    balance: balance.toString(),
    balanceFormatted: ethers.formatUnits(balance, token.decimals),
  };
}
