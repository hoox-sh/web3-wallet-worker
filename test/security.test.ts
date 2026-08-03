/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/security.test.ts

import { describe, it, expect } from "bun:test";
import {
  validateTransaction,
  validateOutgoingTransfer,
  validateSwapTransaction,
  validateApproval,
  isContractWhitelisted,
} from "../src/security";
import { testWalletConfig, TEST_TOKEN_ADDRESS } from "./helpers";

describe("Security Validation", () => {
  const UNISWAP_V2_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

  describe("validateTransaction", () => {
    it("should approve transaction within limits to DEX router", async () => {
      const result = await validateTransaction({
        config: testWalletConfig,
        to: UNISWAP_V2_ADDRESS,
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject transaction exceeding max value", async () => {
      const result = await validateTransaction({
        config: testWalletConfig,
        to: TEST_TOKEN_ADDRESS,
        valueUsd: 50000, // exceeds 10,000
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds");
    });

    it("should reject transaction to non-whitelisted contract when enabled", async () => {
      const strictConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: true,
          whitelistedContracts: ["0x1111111111111111111111111111111111111111"],
        },
      };
      const result = await validateTransaction({
        config: strictConfig,
        to: TEST_TOKEN_ADDRESS, // not in whitelist
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("whitelist");
    });

    it("should reject transaction when wallet is disabled", async () => {
      const disabledConfig = {
        ...testWalletConfig,
        enabled: false,
      };
      const result = await validateTransaction({
        config: disabledConfig,
        to: UNISWAP_V2_ADDRESS,
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("should allow DEX router even without explicit whitelist", async () => {
      const strictConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: true,
          whitelistedContracts: [],
        },
      };
      // DEX router should be auto-whitelisted
      const result = await validateTransaction({
        config: strictConfig,
        to: UNISWAP_V2_ADDRESS,
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject non-positive valueUsd (client cannot understate to 0)", async () => {
      const result = await validateTransaction({
        config: testWalletConfig,
        to: UNISWAP_V2_ADDRESS,
        valueUsd: 0,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("valueUsd");
    });

    it("should reject high-value txs when requireConfirmation is set (fail-closed)", async () => {
      // Under max (10_000) but over confirmation threshold (1000)
      const result = await validateTransaction({
        config: testWalletConfig,
        to: UNISWAP_V2_ADDRESS,
        valueUsd: 1500,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Confirmation required");
    });
  });

  describe("validateApproval", () => {
    it("should allow approve to DEX router within maxApprovalAmount", async () => {
      const result = await validateApproval({
        config: testWalletConfig,
        to: UNISWAP_V2_ADDRESS,
        tokenAddress: TEST_TOKEN_ADDRESS,
        spender: UNISWAP_V2_ADDRESS,
        amount: "1000",
        valueUsd: 1,
        chain: "ethereum",
        maxApprovalAmount: "1000000",
      });
      // Token may need whitelist when whitelistedContractsOnly is true
      // testWalletConfig defaults whitelistedContractsOnly: true with empty list —
      // token not in list and not router → reject. Use explicit whitelist.
      const openConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: false,
        },
      };
      const allowed = await validateApproval({
        config: openConfig,
        to: UNISWAP_V2_ADDRESS,
        tokenAddress: TEST_TOKEN_ADDRESS,
        spender: UNISWAP_V2_ADDRESS,
        amount: "1000",
        valueUsd: 1,
        chain: "ethereum",
        maxApprovalAmount: "1000000",
      });
      expect(allowed.allowed).toBe(true);
      // silence unused first result
      void result;
    });

    it("should reject approve exceeding maxApprovalAmount", async () => {
      const openConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: false,
        },
      };
      const result = await validateApproval({
        config: openConfig,
        to: UNISWAP_V2_ADDRESS,
        tokenAddress: TEST_TOKEN_ADDRESS,
        spender: UNISWAP_V2_ADDRESS,
        amount: "9999999999999999999999999",
        valueUsd: 1,
        chain: "ethereum",
        maxApprovalAmount: "1000",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("maxApprovalAmount");
    });

    it("should reject approve to non-whitelisted spender when enabled", async () => {
      const strictConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: true,
          whitelistedContracts: [TEST_TOKEN_ADDRESS],
        },
      };
      const result = await validateApproval({
        config: strictConfig,
        to: "0xdead000000000000000000000000000000000000",
        tokenAddress: TEST_TOKEN_ADDRESS,
        spender: "0xdead000000000000000000000000000000000000",
        amount: "1000",
        valueUsd: 1,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("validateOutgoingTransfer", () => {
    it("should validate recipient address, not token contract", async () => {
      const strictConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: true,
          whitelistedContracts: [TEST_TOKEN_ADDRESS],
        },
      };
      const result = await validateOutgoingTransfer({
        config: strictConfig,
        to: "0xdead000000000000000000000000000000000000",
        tokenAddress: TEST_TOKEN_ADDRESS,
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("whitelist");
    });

    it("should allow whitelisted token and recipient within limits", async () => {
      const strictConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContractsOnly: true,
          whitelistedContracts: [
            TEST_TOKEN_ADDRESS,
            "0x1111111111111111111111111111111111111111",
          ],
        },
      };
      const result = await validateOutgoingTransfer({
        config: strictConfig,
        to: "0x1111111111111111111111111111111111111111",
        tokenAddress: TEST_TOKEN_ADDRESS,
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("validateSwapTransaction", () => {
    it("should reject swap exceeding max value", async () => {
      const result = await validateSwapTransaction({
        config: testWalletConfig,
        to: UNISWAP_V2_ADDRESS,
        tokenIn: TEST_TOKEN_ADDRESS,
        tokenOut: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        valueUsd: 50000,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds");
    });

    it("should allow swap via DEX router within limits", async () => {
      const swapConfig = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContracts: [
            TEST_TOKEN_ADDRESS,
            "0x6B175474E89094C44Da98b954EedeAC495271d0F",
          ],
        },
      };
      const result = await validateSwapTransaction({
        config: swapConfig,
        to: UNISWAP_V2_ADDRESS,
        tokenIn: TEST_TOKEN_ADDRESS,
        tokenOut: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        valueUsd: 100,
        chain: "ethereum",
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe("isContractWhitelisted", () => {
    it("should return true if contract is whitelisted", () => {
      const config = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContracts: [TEST_TOKEN_ADDRESS],
        },
      };
      const result = isContractWhitelisted(config, TEST_TOKEN_ADDRESS);
      expect(result).toBe(true);
    });

    it("should return false if contract is not whitelisted", () => {
      const config = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContracts: [],
        },
      };
      const result = isContractWhitelisted(
        config,
        "0xdead000000000000000000000000000000000000"
      );
      expect(result).toBe(false);
    });

    it("should be case-insensitive", () => {
      const config = {
        ...testWalletConfig,
        security: {
          ...testWalletConfig.security,
          whitelistedContracts: ["0x6B175474E89094C44Da98b954EedeAC495271d0F"],
        },
      };
      const result = isContractWhitelisted(
        config,
        "0x6b175474e89094c44da98b954eedeac495271d0f"
      );
      expect(result).toBe(true);
    });
  });
});
