/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/transactions.test.ts

import { describe, it, expect } from "bun:test";
import {
  storeTransaction,
  getTransaction,
  listTransactions,
  updateTxStatus,
  initTransactionsTable,
} from "../src/transactions";
import {
  createMockD1,
  testWalletConfig,
  TEST_WALLET_ADDRESS,
  TEST_RECEIVER_ADDRESS,
} from "./helpers";
import type { TransactionRecord } from "../src/types";

const testTx: TransactionRecord = {
  id: "test-tx-001",
  chain: "ethereum",
  txHash: "0xabc123def456",
  type: "swap",
  status: "pending",
  from: TEST_WALLET_ADDRESS,
  to: TEST_RECEIVER_ADDRESS,
  value: "1000000000000000000",
  createdAt: Date.now(),
};

describe("Transaction Manager", () => {
  describe("initTransactionsTable", () => {
    it("should run CREATE TABLE without error", async () => {
      const db = createMockD1();
      await expect(initTransactionsTable(db)).resolves.toBeUndefined();
    });
  });

  describe("storeTransaction", () => {
    it("should insert a transaction record into D1", async () => {
      const db = createMockD1();
      const result = await storeTransaction(db, testTx);
      expect(result).toBeDefined();
    });
  });

  describe("getTransaction", () => {
    it("should return null when no transaction exists", async () => {
      const db = createMockD1();
      const tx = await getTransaction(db, "nonexistent");
      expect(tx).toBeNull();
    });
  });

  describe("listTransactions", () => {
    it("should return empty array when no transactions", async () => {
      const db = createMockD1();
      const txs = await listTransactions(db);
      expect(txs).toEqual([]);
    });

    it("should accept filter options", async () => {
      const db = createMockD1();
      const txs = await listTransactions(db, {
        chain: "ethereum",
        limit: 10,
      });
      expect(txs).toEqual([]);
    });
  });

  describe("updateTxStatus", () => {
    it("should update transaction status", async () => {
      const db = createMockD1();
      const result = await updateTxStatus(
        db,
        "test-tx-001",
        "confirmed",
        "0xabc123def456",
        12345
      );
      expect(result).toBeDefined();
    });
  });
});
