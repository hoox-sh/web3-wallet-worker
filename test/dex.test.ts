/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/dex.test.ts

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ChainName } from "../src/types";

// ---------------------------------------------------------------------------
// Mock ethers before importing the module under test
// ---------------------------------------------------------------------------
const mockRouterInstance = {
  getAmountsOut: mock(async (_amountIn: bigint, _path: string[]) => [
    1000000000000000000n,
    2000000000000000000n,
  ]),
  swapExactETHForTokens: mock(
    async (
      _amountOutMin: bigint,
      _path: string[],
      _to: string,
      _deadline: number,
      _overrides?: { value: bigint }
    ) => ({
      hash: "0xswapnativehash",
      wait: mock(async () => ({ hash: "0xswapnativeconfirm" })),
    })
  ),
  swapExactTokensForETH: mock(
    async (
      _amountIn: bigint,
      _amountOutMin: bigint,
      _path: string[],
      _to: string,
      _deadline: number
    ) => ({
      hash: "0xswaptokenethhash",
      wait: mock(async () => ({ hash: "0xswaptokenethconfirm" })),
    })
  ),
  swapExactTokensForTokens: mock(
    async (
      _amountIn: bigint,
      _amountOutMin: bigint,
      _path: string[],
      _to: string,
      _deadline: number
    ) => ({
      hash: "0xswaptokentokenhash",
      wait: mock(async () => ({ hash: "0xswaptokentokenconfirm" })),
    })
  ),
};

const mockContractInstance = {
  name: mock(async () => "Mock Token"),
  symbol: mock(async () => "MCK"),
  decimals: mock(async () => 18),
  balanceOf: mock(async (_owner: string) => 0n),
  allowance: mock(async (_owner: string, _spender: string) => 0n),
  approve: mock(async (_spender: string, _amount: bigint) => ({
    hash: "0xapprovehash",
    wait: mock(async () => ({ hash: "0xapproveconfirm" })),
  })),
  transfer: mock(async (_to: string, _amount: bigint) => ({
    hash: "0x",
    wait: mock(async () => ({ hash: "0x" })),
  })),
};

const mockQuoterInstance = {
  quoteExactInputSingle: Object.assign(
    mock(async (params: { fee: number }) => [
      2000000n * BigInt(params.fee === 3000 ? 2 : 1),
      0n,
      0,
      0n,
    ]),
    {
      staticCall: mock(async (params: { fee: number }) => [
        2000000n * BigInt(params.fee === 3000 ? 2 : 1),
        0n,
        0,
        0n,
      ]),
    }
  ),
};

const mockSwapRouter02Instance = {
  exactInputSingle: mock(async () => ({
    hash: "0xv3hash",
    wait: mock(async () => ({ hash: "0xv3confirm" })),
  })),
  unwrapWETH9: mock(async () => ({
    hash: "0xunwrap",
    wait: mock(async () => ({ hash: "0xunwrap" })),
  })),
  multicall: mock(async () => ({
    hash: "0xv3multi",
    wait: mock(async () => ({ hash: "0xv3confirm" })),
  })),
  interface: { encodeFunctionData: mock(() => "0xdead") },
};

const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

let lastContractAddress = "";
let lastContractAbi: unknown = null;
let lastContractSigner: unknown = null;

const mockContractCtor = mock(
  (address: string, abi: unknown, providerOrSigner: unknown) => {
    lastContractAddress = address;
    lastContractAbi = abi;
    lastContractSigner = providerOrSigner;
    const lower = address.toLowerCase();
    if (lower === QUOTER_V2.toLowerCase()) {
      return mockQuoterInstance;
    }
    if (lower === SWAP_ROUTER_02.toLowerCase()) {
      return mockSwapRouter02Instance;
    }
    // Return router mock for DEX router address, contract mock otherwise
    if (
      address.toLowerCase().includes("router") ||
      address === "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    ) {
      return mockRouterInstance;
    }
    return mockContractInstance;
  }
);

mock.module("ethers", () => {
  // Keep Wallet / JsonRpcProvider so sibling tests are not poisoned by a partial mock.
  class MockWallet {
    address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    privateKey: string;
    provider: unknown = {
      getFeeData: async () => ({ maxFeePerGas: 20n * 10n ** 9n }),
    };
    constructor(key: string) {
      this.privateKey = key;
    }
    static fromPhrase(_phrase: string) {
      return new MockWallet("0xmock");
    }
    connect(provider: unknown) {
      this.provider = provider;
      return this;
    }
  }
  class MockJsonRpcProvider {
    constructor(
      public url?: string,
      public network?: unknown,
      public opts?: unknown
    ) {}
    async getFeeData() {
      return { maxFeePerGas: 20n * 10n ** 9n, gasPrice: 20n * 10n ** 9n };
    }
    async getBalance() {
      return 0n;
    }
  }
  const ethers = {
    Contract: mockContractCtor,
    Wallet: MockWallet,
    JsonRpcProvider: MockJsonRpcProvider,
    getAddress: (addr: string) => addr,
    formatUnits: (value: bigint, decimals: number | string) => {
      const d = typeof decimals === "string" ? 9 : decimals;
      const divisor = 10n ** BigInt(d);
      return `${value / divisor}.${String(value % divisor).padStart(d, "0")}`;
    },
    formatEther: (value: bigint) => {
      const divisor = 10n ** 18n;
      return `${value / divisor}.${String(value % divisor).padStart(18, "0")}`;
    },
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  };
  return { ethers, ...ethers, default: ethers };
});

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import {
  getQuote,
  getV3Quote,
  executeSwap,
  checkAllowanceAndApprove,
} from "../src/dex";
import { UNISWAP_V3_FEE_TIERS } from "../src/constants";
import {
  TEST_TOKEN_ADDRESS,
  TEST_RECEIVER_ADDRESS,
  TEST_PRIVATE_KEY,
  testWalletConfig,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DEX Swap Engine", () => {
  const mockProvider = {
    getBalance: mock(async () => 1000000000000000000n),
  } as any;
  const mockWallet = {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    provider: mockProvider,
    connect: mock(() => mockWallet),
  } as any;

  const chain: ChainName = "ethereum";
  const swapAmount = 1000000000000000000n;

  beforeEach(() => {
    mockRouterInstance.getAmountsOut.mockClear();
    mockRouterInstance.swapExactETHForTokens.mockClear();
    mockRouterInstance.swapExactTokensForETH.mockClear();
    mockRouterInstance.swapExactTokensForTokens.mockClear();
    mockContractInstance.allowance.mockClear();
    mockContractInstance.approve.mockClear();
    mockQuoterInstance.quoteExactInputSingle.mockClear();
    mockQuoterInstance.quoteExactInputSingle.staticCall.mockClear();
    mockSwapRouter02Instance.exactInputSingle.mockClear();
    mockSwapRouter02Instance.unwrapWETH9.mockClear();
    mockSwapRouter02Instance.multicall.mockClear();
  });

  describe("getQuote", () => {
    it("should return expected output amount from DEX router", async () => {
      const quote = await getQuote(
        mockProvider,
        chain,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        swapAmount
      );

      expect(quote).toBe(2000000000000000000n);
    });

    it("should call getAmountsOut with correct path", async () => {
      await getQuote(
        mockProvider,
        chain,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        swapAmount
      );

      expect(mockRouterInstance.getAmountsOut).toHaveBeenCalledWith(
        swapAmount,
        [TEST_TOKEN_ADDRESS, TEST_RECEIVER_ADDRESS]
      );
    });

    it("should reject if no DEX router configured", async () => {
      await expect(
        getQuote(
          mockProvider,
          "optimism" as ChainName,
          "0xtoken",
          "0xtoken2",
          1n
        )
      ).rejects.toThrow("No DEX router configured");
    });
  });

  describe("executeSwap - native to token", () => {
    it("should call swapExactETHForTokens for native input", async () => {
      const hash = await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: "0x0000000000000000000000000000000000000000",
          tokenOut: TEST_TOKEN_ADDRESS,
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      expect(hash).toBe("0xswapnativeconfirm");
      expect(mockRouterInstance.swapExactETHForTokens).toHaveBeenCalled();
    });

    it("should include value override for native swap", async () => {
      await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: "0x0000000000000000000000000000000000000000",
          tokenOut: TEST_TOKEN_ADDRESS,
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      const callArgs = mockRouterInstance.swapExactETHForTokens.mock.calls[0];
      // Last argument is the overrides object with value
      const overrides = callArgs[callArgs.length - 1];
      expect(overrides).toHaveProperty("value");
      expect(overrides.value).toBe(swapAmount);
    });
  });

  describe("executeSwap - token to token", () => {
    it("should check allowance and approve before token swap", async () => {
      // allowance returns 0 → approve will be called
      mockContractInstance.allowance = mock(async () => 0n);

      const hash = await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: TEST_TOKEN_ADDRESS,
          tokenOut: TEST_RECEIVER_ADDRESS,
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      expect(hash).toBe("0xswaptokentokenconfirm");
      // Should have created an ERC20 contract for allowance check
      expect(mockContractInstance.allowance).toHaveBeenCalled();
      expect(mockRouterInstance.swapExactTokensForTokens).toHaveBeenCalled();
    });

    it("should not approve if allowance is sufficient", async () => {
      mockContractInstance.allowance = mock(async () => swapAmount);

      await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: TEST_TOKEN_ADDRESS,
          tokenOut: TEST_RECEIVER_ADDRESS,
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      // approve should not have been called
      expect(mockContractInstance.approve).not.toHaveBeenCalled();
    });

    it("should call swapExactTokensForTokens directly", async () => {
      mockContractInstance.allowance = mock(async () => swapAmount);

      await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: TEST_TOKEN_ADDRESS,
          tokenOut: TEST_RECEIVER_ADDRESS,
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      expect(mockRouterInstance.swapExactTokensForTokens).toHaveBeenCalled();
      expect(mockRouterInstance.swapExactETHForTokens).not.toHaveBeenCalled();
      expect(mockRouterInstance.swapExactTokensForETH).not.toHaveBeenCalled();
    });
  });

  describe("executeSwap - token to native", () => {
    it("should call swapExactTokensForETH for token-to-native swap", async () => {
      mockContractInstance.allowance = mock(async () => swapAmount);

      const hash = await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: TEST_TOKEN_ADDRESS,
          tokenOut: "0x0000000000000000000000000000000000000000",
          amountIn: swapAmount.toString(),
        },
        testWalletConfig
      );

      expect(hash).toBe("0xswaptokenethconfirm");
      expect(mockRouterInstance.swapExactTokensForETH).toHaveBeenCalled();
      expect(
        mockRouterInstance.swapExactTokensForTokens
      ).not.toHaveBeenCalled();
    });
  });

  describe("checkAllowanceAndApprove", () => {
    const spender = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

    it("should return null for native token (no approval needed)", async () => {
      const result = await checkAllowanceAndApprove(
        mockWallet,
        mockProvider,
        "0x0000000000000000000000000000000000000000",
        spender,
        swapAmount
      );

      expect(result).toBeNull();
    });

    it("should return null if allowance is already sufficient", async () => {
      mockContractInstance.allowance = mock(async () => swapAmount + 1n);

      const result = await checkAllowanceAndApprove(
        mockWallet,
        mockProvider,
        TEST_TOKEN_ADDRESS,
        spender,
        swapAmount
      );

      expect(result).toBeNull();
      expect(mockContractInstance.approve).not.toHaveBeenCalled();
    });

    it("should send approve tx when allowance is insufficient", async () => {
      mockContractInstance.allowance = mock(async () => 0n);

      const result = await checkAllowanceAndApprove(
        mockWallet,
        mockProvider,
        TEST_TOKEN_ADDRESS,
        spender,
        swapAmount
      );

      expect(result).toBe("0xapproveconfirm");
      expect(mockContractInstance.approve).toHaveBeenCalledWith(
        spender,
        swapAmount
      );
    });
  });

  describe("getV3Quote", () => {
    it("picks fee 3000 (best output with the fixture)", async () => {
      const quote = await getV3Quote(
        mockProvider,
        chain,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        swapAmount
      );

      expect(quote.fee).toBe(3000);
      expect(quote.amountOut).toBe(4000000n);
    });

    it("fee is one of 100/500/3000/10000", async () => {
      const quote = await getV3Quote(
        mockProvider,
        chain,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        swapAmount
      );

      expect(UNISWAP_V3_FEE_TIERS).toContain(quote.fee);
      expect([100, 500, 3000, 10000]).toContain(quote.fee);
    });

    it("quotes via staticCall (QuoterV2 is non-view)", async () => {
      await getV3Quote(
        mockProvider,
        chain,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        swapAmount
      );

      expect(
        mockQuoterInstance.quoteExactInputSingle.staticCall
      ).toHaveBeenCalled();
    });
  });

  describe("executeSwap - Uniswap V3", () => {
    it("hits V3 path when dexVersion is v3", async () => {
      mockContractInstance.allowance = mock(async () => swapAmount);

      const hash = await executeSwap(
        mockWallet,
        chain,
        {
          chain,
          tokenIn: TEST_TOKEN_ADDRESS,
          tokenOut: TEST_RECEIVER_ADDRESS,
          amountIn: swapAmount.toString(),
          dexVersion: "v3",
        },
        testWalletConfig
      );

      expect(hash).toBe("0xv3confirm");
      expect(mockSwapRouter02Instance.exactInputSingle).toHaveBeenCalled();
      expect(
        mockRouterInstance.swapExactTokensForTokens
      ).not.toHaveBeenCalled();
    });
  });
});
