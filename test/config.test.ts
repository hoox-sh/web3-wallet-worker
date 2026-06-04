// workers/web3-wallet-worker/test/config.test.ts

import { describe, it, expect } from "bun:test";
import {
  getConfig,
  updateConfig,
  getChainConfig,
  getDexConfig,
  getSecurityConfig,
} from "../src/config";
import { createMockKV, testWalletConfig } from "./helpers";
import { KV_CONFIG_KEY, DEFAULT_WALLET_CONFIG } from "../src/constants";

describe("Config Manager", () => {
  describe("getConfig", () => {
    it("should return default config when KV is empty", async () => {
      const kv = createMockKV({});
      const config = await getConfig(kv);
      expect(config.enabled).toBe(DEFAULT_WALLET_CONFIG.enabled);
      expect(config.defaultChain).toBe(DEFAULT_WALLET_CONFIG.defaultChain);
    });

    it("should return stored config when KV has data", async () => {
      const kv = createMockKV({
        [KV_CONFIG_KEY]: JSON.stringify(testWalletConfig),
      });
      const config = await getConfig(kv);
      expect(config.defaultChain).toBe("ethereum");
      expect(config.dex.slippageTolerance).toBe(0.5);
    });

    it("should return default config when KV has corrupted JSON", async () => {
      const kv = createMockKV({ [KV_CONFIG_KEY]: "not-json" });
      const config = await getConfig(kv);
      expect(config.enabled).toBe(true); // falls back to default
    });
  });

  describe("updateConfig", () => {
    it("should store config in KV", async () => {
      const kv = createMockKV({});
      await updateConfig(kv, testWalletConfig);
      const stored = await kv.get(KV_CONFIG_KEY);
      expect(stored).toBe(JSON.stringify(testWalletConfig));
    });

    it("should update updatedAt timestamp", async () => {
      const kv = createMockKV({});
      const before = Date.now();
      await updateConfig(kv, { ...testWalletConfig, updatedAt: 0 });
      const storedRaw = await kv.get(KV_CONFIG_KEY);
      if (storedRaw) {
        const stored: { updatedAt: number } = JSON.parse(storedRaw);
        expect(stored.updatedAt).toBeGreaterThanOrEqual(before);
      }
    });
  });

  describe("getChainConfig", () => {
    it("should return chain config for valid chain", () => {
      const config = getChainConfig("ethereum");
      expect(config.chainId).toBe(1);
      expect(config.currency).toBe("ETH");
    });

    it("should throw for unknown chain", () => {
      expect(() => getChainConfig("solana" as any)).toThrow(
        "Unsupported chain"
      );
    });
  });

  describe("getDexConfig", () => {
    it("should return DEX section from config", () => {
      const dex = getDexConfig(testWalletConfig);
      expect(dex.slippageTolerance).toBe(0.5);
    });
  });

  describe("getSecurityConfig", () => {
    it("should return security section from config", () => {
      const sec = getSecurityConfig(testWalletConfig);
      expect(sec.maxTransactionValueUsd).toBe(10000);
    });
  });
});
