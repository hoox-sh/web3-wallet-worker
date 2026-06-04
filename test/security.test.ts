// workers/web3-wallet-worker/test/security.test.ts

import { describe, it, expect } from "bun:test";
import { validateTransaction, isContractWhitelisted } from "../src/security";
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
