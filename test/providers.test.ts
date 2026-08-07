/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/providers.test.ts

import { describe, it, expect } from "bun:test";
import {
  getReadOnlyProvider,
  getWallet,
  getProvider,
  connectWallet,
  isSafeRpcUrl,
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

  describe("isSafeRpcUrl", () => {
    it("allows https public RPCs", () => {
      expect(isSafeRpcUrl("https://eth.llamarpc.com")).toBe(true);
    });

    it("allows localhost http for local Anvil", () => {
      expect(isSafeRpcUrl("http://127.0.0.1:8545")).toBe(true);
      expect(isSafeRpcUrl("http://localhost:8545")).toBe(true);
    });

    it("blocks cloud metadata and non-local http", () => {
      expect(isSafeRpcUrl("http://169.254.169.254/latest")).toBe(false);
      expect(isSafeRpcUrl("http://evil.example.com")).toBe(false);
      expect(isSafeRpcUrl("file:///etc/passwd")).toBe(false);
    });
  });

  describe("connectWallet", () => {
    it("attaches a provider to a wallet", () => {
      const wallet = getWallet(TEST_PRIVATE_KEY);
      const connected = connectWallet(wallet, "ethereum");
      expect(connected.provider).toBeDefined();
      expect(connected.address).toBe(TEST_WALLET_ADDRESS);
    });
  });
});
