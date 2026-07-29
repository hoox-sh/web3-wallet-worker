/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/providers.test.ts

import { describe, it, expect } from "bun:test";
import {
  getReadOnlyProvider,
  getWallet,
  getProvider,
  connectWallet,
} from "../src/providers";
import {
  TEST_PRIVATE_KEY,
  TEST_WALLET_ADDRESS,
  TEST_MNEMONIC,
} from "./helpers";

describe("Provider Factory", () => {
  describe("getReadOnlyProvider", () => {
    it("should return a provider for a configured chain", () => {
      const provider = getReadOnlyProvider("ethereum");
      expect(provider).toBeDefined();
    });

    it("should return different providers for different chains", () => {
      const eth = getReadOnlyProvider("ethereum");
      const bsc = getReadOnlyProvider("bsc");
      expect(eth).not.toBe(bsc);
    });
  });

  describe("getProvider", () => {
    it("should return a provider for valid chain", () => {
      const provider = getProvider("ethereum");
      expect(provider).toBeDefined();
    });
  });

  describe("getWallet", () => {
    it("should create wallet from private key", () => {
      const wallet = getWallet(TEST_PRIVATE_KEY);
      expect(wallet.address).toBe(TEST_WALLET_ADDRESS);
    });

    it("should create wallet from mnemonic", () => {
      const wallet = getWallet(TEST_MNEMONIC);
      expect(wallet.address).toBe(TEST_WALLET_ADDRESS);
    });

    it("should detect private key format with 0x prefix", () => {
      const wallet = getWallet(TEST_PRIVATE_KEY);
      expect(wallet.address).toBe(TEST_WALLET_ADDRESS);
    });

    it("should detect private key format without 0x prefix", () => {
      const wallet = getWallet(TEST_PRIVATE_KEY.slice(2));
      expect(wallet.address).toBe(TEST_WALLET_ADDRESS);
    });
  });
});
