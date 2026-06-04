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

let lastContractAddress = "";
let lastContractAbi: unknown = null;
let lastContractSigner: unknown = null;

const mockContractCtor = mock(
  (address: string, abi: unknown, providerOrSigner: unknown) => {
    lastContractAddress = address;
    lastContractAbi = abi;
    lastContractSigner = providerOrSigner;
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
  const ethers = {
    Contract: mockContractCtor,
    getAddress: (addr: string) => addr,
    formatUnits: (value: bigint, decimals: number) => {
      const divisor = 10n ** BigInt(decimals);
      return `${value / divisor}.${String(value % divisor).padStart(decimals, "0")}`;
    },
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  };
  return { ethers };
});

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import { getQuote, executeSwap, checkAllowanceAndApprove } from "../src/dex";
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
});
