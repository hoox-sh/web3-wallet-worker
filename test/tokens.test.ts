/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/tokens.test.ts

import { describe, it, expect, mock } from "bun:test";
import type { ChainName } from "../src/types";

// ---------------------------------------------------------------------------
// Mock ethers before importing the module under test
// ---------------------------------------------------------------------------
const mockContractInstance = {
  name: mock(async () => "Test Token"),
  symbol: mock(async () => "TST"),
  decimals: mock(async () => 18),
  balanceOf: mock(async (_owner: string) => 1000000000000000000n),
  allowance: mock(
    async (_owner: string, _spender: string) => 500000000000000000n
  ),
  approve: mock(async (_spender: string, _amount: bigint) => ({
    hash: "0xapprovehashunconfirmed",
    wait: mock(async () => ({ hash: "0xapprovehashconfirmed" })),
  })),
  transfer: mock(async (_to: string, _amount: bigint) => ({
    hash: "0xtransferhashunconfirmed",
    wait: mock(async () => ({ hash: "0xtransferhashconfirmed" })),
  })),
};

const mockContractCtor = mock(
  (_address: string, _abi: unknown, _providerOrSigner: unknown) =>
    mockContractInstance
);

mock.module("ethers", () => {
  // Keep Wallet / JsonRpcProvider so sibling tests are not poisoned by a partial mock.
  class MockWallet {
    address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    privateKey: string;
    provider: unknown = null;
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
      const intPart = value / divisor;
      const fracPart = value % divisor;
      const padded = String(fracPart).padStart(d, "0");
      return `${intPart}.${padded}`;
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
  getTokenInfo,
  getNativeBalance,
  getTokenBalance,
  getAllowance,
  approveToken,
  transferToken,
  formatBalance,
} from "../src/tokens";
import {
  TEST_TOKEN_ADDRESS,
  TEST_RECEIVER_ADDRESS,
  testTokenInfo,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Token Operations", () => {
  const mockProvider = {} as any;
  const mockWallet = { connect: mock(() => mockWallet) } as any;

  describe("getTokenInfo", () => {
    it("should fetch ERC20 name, symbol, and decimals", async () => {
      const info = await getTokenInfo(mockProvider, TEST_TOKEN_ADDRESS);

      expect(info.symbol).toBe("TST");
      expect(info.name).toBe("Test Token");
      expect(info.decimals).toBe(18);
    });

    it("should pass the contract address to Contract constructor", async () => {
      mockContractCtor.mockClear();
      await getTokenInfo(mockProvider, TEST_TOKEN_ADDRESS);

      expect(mockContractCtor).toHaveBeenCalledWith(
        TEST_TOKEN_ADDRESS,
        expect.any(Array),
        mockProvider
      );
    });

    it("should call all three contract methods in parallel", async () => {
      const spyName = mock(async () => "Parallel Token");
      const spySymbol = mock(async () => "PAR");
      const spyDecimals = mock(async () => 6);

      // Override for this test only
      const origName = mockContractInstance.name;
      const origSymbol = mockContractInstance.symbol;
      const origDecimals = mockContractInstance.decimals;
      mockContractInstance.name = spyName;
      mockContractInstance.symbol = spySymbol;
      mockContractInstance.decimals = spyDecimals;

      await getTokenInfo(mockProvider, TEST_TOKEN_ADDRESS);

      expect(spyName).toHaveBeenCalled();
      expect(spySymbol).toHaveBeenCalled();
      expect(spyDecimals).toHaveBeenCalled();

      // Restore
      mockContractInstance.name = origName;
      mockContractInstance.symbol = origSymbol;
      mockContractInstance.decimals = origDecimals;
    });
  });

  describe("getNativeBalance", () => {
    it("should return the native balance from provider", async () => {
      const spyGetBalance = mock(() => Promise.resolve(5000000000000000000n));
      const provider = { getBalance: spyGetBalance } as any;

      const balance = await getNativeBalance(provider, TEST_RECEIVER_ADDRESS);

      expect(balance).toBe(5000000000000000000n);
      expect(spyGetBalance).toHaveBeenCalledWith(TEST_RECEIVER_ADDRESS);
    });
  });

  describe("getTokenBalance", () => {
    it("should return the token balance from contract", async () => {
      const balance = await getTokenBalance(
        mockProvider,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS
      );

      expect(balance).toBe(1000000000000000000n);
    });
  });

  describe("getAllowance", () => {
    it("should return the allowance from contract", async () => {
      const allowance = await getAllowance(
        mockProvider,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        "0xSpenderAddress"
      );

      expect(allowance).toBe(500000000000000000n);
    });
  });

  describe("approveToken", () => {
    it("should call approve on the contract and return confirmed hash", async () => {
      const hash = await approveToken(
        mockWallet,
        TEST_TOKEN_ADDRESS,
        "0xSpenderAddress",
        1000000000000000000n
      );

      expect(hash).toBe("0xapprovehashconfirmed");
      expect(mockContractInstance.approve).toHaveBeenCalledWith(
        "0xSpenderAddress",
        1000000000000000000n
      );
    });

    it("should return unconfirmed hash if wait fails", async () => {
      mockContractInstance.approve = mock(async () => ({
        hash: "0xapprovehashunconfirmed",
        wait: mock(async () => null),
      }));

      const hash = await approveToken(
        mockWallet,
        TEST_TOKEN_ADDRESS,
        "0xSpenderAddress",
        1000000000000000000n
      );

      expect(hash).toBe("0xapprovehashunconfirmed");
    });
  });

  describe("transferToken", () => {
    it("should call transfer on the contract and return confirmed hash", async () => {
      mockContractInstance.transfer = mock(async () => ({
        hash: "0xtransferhashunconfirmed",
        wait: mock(async () => ({ hash: "0xtransferhashconfirmed" })),
      }));

      const hash = await transferToken(
        mockWallet,
        TEST_TOKEN_ADDRESS,
        TEST_RECEIVER_ADDRESS,
        500000000000000000n
      );

      expect(hash).toBe("0xtransferhashconfirmed");
      expect(mockContractInstance.transfer).toHaveBeenCalledWith(
        TEST_RECEIVER_ADDRESS,
        500000000000000000n
      );
    });
  });

  describe("formatBalance", () => {
    it("should produce correct BalanceResult for 18 decimal token", () => {
      const token = { ...testTokenInfo, decimals: 18 };
      const result = formatBalance("ethereum", token, 1500000000000000000n);

      expect(result.chain).toBe("ethereum");
      expect(result.token).toBe(token);
      expect(result.balance).toBe("1500000000000000000");
      expect(result.balanceFormatted).toBe("1.500000000000000000");
    });

    it("should handle zero balance", () => {
      const token = { ...testTokenInfo, decimals: 6 };
      const result = formatBalance("ethereum", token, 0n);

      expect(result.balance).toBe("0");
      expect(result.balanceFormatted).toBe("0.000000");
    });

    it("should handle small decimal tokens (6 decimals USDC)", () => {
      const token = { ...testTokenInfo, decimals: 6 };
      const result = formatBalance("ethereum", token, 1000000n);

      expect(result.balanceFormatted).toBe("1.000000");
    });
  });
});
