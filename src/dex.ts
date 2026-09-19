/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/dex.ts

import { ethers } from "ethers";
import type { ChainName, SwapRequest, WalletConfig } from "./types";
import {
  ERC20_ABI,
  DEX_ROUTER_ABI,
  UNISWAP_V3_FEE_TIERS,
  UNISWAP_V3_SWAP_ROUTER_02,
  UNISWAP_V3_QUOTER_V2,
  UNISWAP_V3_CHAINS,
  UNISWAP_V3_QUOTER_V2_ABI,
  UNISWAP_V3_SWAP_ROUTER_02_ABI,
} from "./constants";
import { getChainConfig } from "./config";

/** Native token sentinel address (router replaces with WETH/WBNB internally) */
const NATIVE_TOKEN = ethers.ZeroAddress;

/**
 * Scale current network fees by the configured gas multiplier (default 1.2).
 * Returns EIP-1559 overrides, or `{}` when fees are unreadable or the
 * multiplier is <= 1 (node defaults apply). Never throws.
 */
export async function buildGasOverrides(
  provider: ethers.Provider,
  multiplier: number
): Promise<ethers.TransactionRequest> {
  if (!(multiplier > 1) || !Number.isFinite(multiplier)) return {};
  try {
    const fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas;
    if (maxFee === null || maxFee === undefined) return {};
    const factor = BigInt(Math.round(multiplier * 100));
    const scale = (v: bigint) => (v * factor) / 100n;
    const overrides: ethers.TransactionRequest = {
      maxFeePerGas: scale(maxFee),
    };
    const prio = fee.maxPriorityFeePerGas;
    if (prio !== null && prio !== undefined) {
      overrides.maxPriorityFeePerGas = scale(prio);
    }
    return overrides;
  } catch {
    return {};
  }
}

/**
 * Get a swap quote from the DEX router.
 * Returns the expected output amount in wei.
 */
export async function getQuote(
  provider: ethers.Provider,
  chain: ChainName,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<bigint> {
  const chainConfig = getChainConfig(chain);
  const routerAddr = chainConfig.dexRouterAddress;
  if (!routerAddr) {
    throw new Error(`No DEX router configured for chain: ${chain}`);
  }

  const router = new ethers.Contract(routerAddr, DEX_ROUTER_ABI, provider);
  const path = buildPath(chain, tokenIn, tokenOut);

  const getAmountsOut = router.getAmountsOut;
  if (!getAmountsOut)
    throw new Error("Router getAmountsOut method unavailable");
  const amounts: bigint[] = await getAmountsOut(amountIn, path);
  const out = amounts[amounts.length - 1];
  if (out === undefined) throw new Error("Empty amounts from getAmountsOut");
  return out;
}

export interface V3Quote {
  amountOut: bigint;
  fee: number;
}

/**
 * Quote Uniswap V3 exact-input across fee tiers; pick the best amountOut.
 * QuoterV2.quoteExactInputSingle is non-view — must use `.staticCall`.
 * Native (ZeroAddress) is wrapped before quoting.
 */
export async function getV3Quote(
  provider: ethers.Provider,
  chain: ChainName,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<V3Quote> {
  if (!UNISWAP_V3_CHAINS.includes(chain)) {
    throw new Error(`Uniswap V3 not supported on chain: ${chain}`);
  }

  const chainConfig = getChainConfig(chain);
  const wNative = chainConfig.wrappedNativeAddress;
  if (!wNative) {
    throw new Error(`No wrapped native for chain: ${chain}`);
  }

  const native = ethers.ZeroAddress;
  const resolvedIn =
    tokenIn.toLowerCase() === native.toLowerCase() ? wNative : tokenIn;
  const resolvedOut =
    tokenOut.toLowerCase() === native.toLowerCase() ? wNative : tokenOut;

  const quoter = new ethers.Contract(
    UNISWAP_V3_QUOTER_V2,
    UNISWAP_V3_QUOTER_V2_ABI,
    provider
  );
  const quoteFn = quoter.quoteExactInputSingle;
  if (!quoteFn?.staticCall) {
    throw new Error("QuoterV2 quoteExactInputSingle method unavailable");
  }

  let best: V3Quote | null = null;
  for (const fee of UNISWAP_V3_FEE_TIERS) {
    try {
      const result = await quoteFn.staticCall({
        tokenIn: resolvedIn,
        tokenOut: resolvedOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0,
      });
      const amountOut = BigInt(
        Array.isArray(result) ? result[0] : (result?.amountOut ?? result)
      );
      if (amountOut > 0n && (best === null || amountOut > best.amountOut)) {
        best = { amountOut, fee };
      }
    } catch {
      // no pool at this fee tier
    }
  }
  if (!best) {
    throw new Error("No Uniswap V3 quote available for this pair");
  }
  return best;
}

/**
 * Execute a Uniswap V3 exactInputSingle swap via SwapRouter02.
 *
 * Native in: tokenIn=WETH, send `value: amountIn`.
 * Native out: tokenOut=WETH, recipient=router, then unwrapWETH9 to the user
 * via multicall (matches V2 swapExactTokensForETH).
 */
export async function executeV3Swap(
  wallet: ethers.Wallet,
  chain: ChainName,
  request: SwapRequest,
  config: WalletConfig,
  fee: number,
  minAmountOut: bigint
): Promise<string> {
  if (!UNISWAP_V3_CHAINS.includes(chain)) {
    throw new Error(`Uniswap V3 not supported on chain: ${chain}`);
  }

  const chainConfig = getChainConfig(chain);
  const wNative = chainConfig.wrappedNativeAddress;
  if (!wNative) {
    throw new Error(`No wrapped native for chain: ${chain}`);
  }

  const provider = wallet.provider!;
  const native = ethers.ZeroAddress;
  const isNativeIn = request.tokenIn.toLowerCase() === native.toLowerCase();
  const isNativeOut = request.tokenOut.toLowerCase() === native.toLowerCase();
  const tokenIn = isNativeIn ? wNative : request.tokenIn;
  const tokenOut = isNativeOut ? wNative : request.tokenOut;
  const amountIn = BigInt(request.amountIn);
  const userRecipient = request.recipient || wallet.address;

  if (!isNativeIn) {
    await checkAllowanceAndApprove(
      wallet,
      provider,
      request.tokenIn,
      UNISWAP_V3_SWAP_ROUTER_02,
      amountIn
    );
  }

  const router = new ethers.Contract(
    UNISWAP_V3_SWAP_ROUTER_02,
    UNISWAP_V3_SWAP_ROUTER_02_ABI,
    wallet
  );
  const gasOverrides = await buildGasOverrides(
    provider,
    config.dex.gasMultiplier
  );
  const valueOverrides = isNativeIn
    ? { value: amountIn, ...gasOverrides }
    : gasOverrides;

  let tx: ethers.TransactionResponse;

  if (isNativeOut) {
    const encode = router.interface?.encodeFunctionData;
    if (!encode) {
      throw new Error("SwapRouter02 interface.encodeFunctionData unavailable");
    }
    const swapData = encode("exactInputSingle", [
      {
        tokenIn,
        tokenOut,
        fee,
        recipient: UNISWAP_V3_SWAP_ROUTER_02,
        amountIn,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0,
      },
    ]);
    const unwrapData = encode("unwrapWETH9", [minAmountOut, userRecipient]);
    const multicall = router.multicall;
    if (!multicall) {
      throw new Error("SwapRouter02 multicall method unavailable");
    }
    tx = await multicall([swapData, unwrapData], valueOverrides);
  } else {
    const exactInputSingle = router.exactInputSingle;
    if (!exactInputSingle) {
      throw new Error("SwapRouter02 exactInputSingle method unavailable");
    }
    tx = await exactInputSingle(
      {
        tokenIn,
        tokenOut,
        fee,
        recipient: userRecipient,
        amountIn,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0,
      },
      valueOverrides
    );
  }

  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/**
 * Execute a swap via the DEX router.
 *
 * Steps:
 * 1. Validate the swap request against security config
 * 2. Check and request token approval if needed (for non-native input)
 * 3. Compute minAmountOut from slippage tolerance
 * 4. Execute the swap and return the tx hash
 */
export async function executeSwap(
  wallet: ethers.Wallet,
  chain: ChainName,
  request: SwapRequest,
  config: WalletConfig
): Promise<string> {
  const provider = wallet.provider!;
  const dexVersion = request.dexVersion ?? "v2";
  if (dexVersion === "v3") {
    const chainConfig = getChainConfig(chain);
    const wNative = chainConfig.wrappedNativeAddress;
    if (!wNative) throw new Error(`No wrapped native for chain: ${chain}`);
    const native = ethers.ZeroAddress;
    const tokenIn =
      request.tokenIn.toLowerCase() === native.toLowerCase()
        ? wNative
        : request.tokenIn;
    const tokenOut =
      request.tokenOut.toLowerCase() === native.toLowerCase()
        ? wNative
        : request.tokenOut;
    const best = await getV3Quote(
      provider,
      chain,
      tokenIn,
      tokenOut,
      BigInt(request.amountIn)
    );
    // slippageBps wins when set; else config.dex.slippageTolerance
    const bps =
      request.slippageBps ?? Math.floor(config.dex.slippageTolerance * 100);
    const v3Min =
      request.minAmountOut ??
      ((best.amountOut * BigInt(10000 - bps)) / 10000n).toString();
    return executeV3Swap(
      wallet,
      chain,
      request,
      config,
      best.fee,
      BigInt(v3Min)
    );
  }

  const chainConfig = getChainConfig(chain);
  const routerAddr = chainConfig.dexRouterAddress;
  if (!routerAddr) {
    throw new Error(`No DEX router configured for chain: ${chain}`);
  }

  const isNativeIn = request.tokenIn === NATIVE_TOKEN;
  const isNativeOut = request.tokenOut === NATIVE_TOKEN;

  // Build the swap path
  const path = buildPath(chain, request.tokenIn, request.tokenOut);

  // Compute minAmountOut from slippage
  const quote = await getQuote(
    provider,
    chain,
    request.tokenIn,
    request.tokenOut,
    BigInt(request.amountIn)
  );
  // slippageBps wins when set; else config.dex.slippageTolerance
  const slippageBasis =
    request.slippageBps ?? Math.floor(config.dex.slippageTolerance * 100);
  const minAmountOut =
    request.minAmountOut ?? (quote * BigInt(10000 - slippageBasis)) / 10000n;

  const recipient = request.recipient || wallet.address;
  const deadline = request.deadline ?? Math.floor(Date.now() / 1000) + 1200; // 20 min

  const router = new ethers.Contract(routerAddr, DEX_ROUTER_ABI, wallet);
  const gasOverrides = await buildGasOverrides(
    provider,
    config.dex.gasMultiplier
  );

  let tx: ethers.TransactionResponse;

  if (isNativeIn) {
    // Native → Token: swapExactETHForTokens (payable)
    const swapExactETHForTokens = router.swapExactETHForTokens;
    if (!swapExactETHForTokens) {
      throw new Error("Router swapExactETHForTokens method unavailable");
    }
    tx = await swapExactETHForTokens(minAmountOut, path, recipient, deadline, {
      value: BigInt(request.amountIn),
      ...gasOverrides,
    });
  } else {
    // Token in: need approval first
    await checkAllowanceAndApprove(
      wallet,
      provider,
      request.tokenIn,
      routerAddr,
      BigInt(request.amountIn)
    );

    if (isNativeOut) {
      // Token → Native: swapExactTokensForETH
      const swapExactTokensForETH = router.swapExactTokensForETH;
      if (!swapExactTokensForETH) {
        throw new Error("Router swapExactTokensForETH method unavailable");
      }
      tx = await swapExactTokensForETH(
        BigInt(request.amountIn),
        minAmountOut,
        path,
        recipient,
        deadline,
        gasOverrides
      );
    } else {
      // Token → Token: swapExactTokensForTokens
      const swapExactTokensForTokens = router.swapExactTokensForTokens;
      if (!swapExactTokensForTokens) {
        throw new Error("Router swapExactTokensForTokens method unavailable");
      }
      tx = await swapExactTokensForTokens(
        BigInt(request.amountIn),
        minAmountOut,
        path,
        recipient,
        deadline,
        gasOverrides
      );
    }
  }

  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/**
 * Check token allowance for the router and approve if insufficient.
 * Returns the approval tx hash if an approve was sent, or null if not needed.
 * For native token input, always returns null (no approval needed).
 */
export async function checkAllowanceAndApprove(
  wallet: ethers.Wallet,
  provider: ethers.Provider,
  tokenAddress: string,
  spender: string,
  amount: bigint
): Promise<string | null> {
  // Native token never needs approval
  if (tokenAddress === ethers.ZeroAddress) return null;

  const checksummedToken = ethers.getAddress(tokenAddress);
  const checksummedSpender = ethers.getAddress(spender);
  const owner = wallet.address;

  const contract = new ethers.Contract(checksummedToken, ERC20_ABI, provider);
  const allowanceFn = contract.allowance;
  if (!allowanceFn) throw new Error("ERC20 allowance method unavailable");
  const currentAllowance: bigint = await allowanceFn(owner, checksummedSpender);

  if (currentAllowance >= amount) {
    return null; // Allowance is sufficient
  }

  // Send approve transaction
  const signerContract = new ethers.Contract(
    checksummedToken,
    ERC20_ABI,
    wallet
  );
  const approve = signerContract.approve;
  if (!approve) throw new Error("ERC20 approve method unavailable");
  const tx = await approve(checksummedSpender, amount);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

// ── Internal helpers ──

/**
 * Build a swap path array from token addresses.
 * For native token input/output, replace with wrapped native address.
 */
function buildPath(
  chain: ChainName,
  tokenIn: string,
  tokenOut: string
): string[] {
  const chainConfig = getChainConfig(chain);
  const wNative = chainConfig.wrappedNativeAddress;

  if (!wNative) {
    throw new Error(`No wrapped native address configured for chain: ${chain}`);
  }

  const resolvedIn = tokenIn === NATIVE_TOKEN ? wNative : tokenIn;
  const resolvedOut = tokenOut === NATIVE_TOKEN ? wNative : tokenOut;

  return [resolvedIn, resolvedOut];
}
