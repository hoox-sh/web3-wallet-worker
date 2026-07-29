/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/transactions.ts

import type { D1Database } from "@cloudflare/workers-types";
import type { TransactionRecord } from "./types";

const TABLE_NAME = "wallet_transactions";
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value TEXT NOT NULL,
  token_address TEXT,
  gas_used TEXT,
  gas_price TEXT,
  block_number INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
)`;

/**
 * Initialize the transactions table (idempotent).
 */
export async function initTransactionsTable(db: D1Database): Promise<void> {
  await db.prepare(CREATE_TABLE_SQL).run();
}

/**
 * Store a new transaction record in D1.
 */
export async function storeTransaction(
  db: D1Database,
  tx: TransactionRecord
): Promise<D1Result> {
  const stmt = db
    .prepare(
      `INSERT OR REPLACE INTO ${TABLE_NAME}
    (id, chain, tx_hash, type, status, from_address, to_address, value,
     token_address, gas_used, gas_price, block_number, error, created_at, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tx.id,
      tx.chain,
      tx.txHash,
      tx.type,
      tx.status,
      tx.from,
      tx.to,
      tx.value,
      tx.tokenAddress || null,
      tx.gasUsed || null,
      tx.gasPrice || null,
      tx.blockNumber || null,
      tx.error || null,
      tx.createdAt,
      tx.confirmedAt || null
    );
  return stmt.run();
}

/**
 * Get a transaction record by ID.
 */
export async function getTransaction(
  db: D1Database,
  id: string
): Promise<TransactionRecord | null> {
  const result = await db
    .prepare(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`)
    .bind(id)
    .first<TransactionRecord>();
  return result || null;
}

/**
 * List transactions with optional chain filter and pagination.
 */
export async function listTransactions(
  db: D1Database,
  options: {
    chain?: string;
    type?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<TransactionRecord[]> {
  let sql = `SELECT * FROM ${TABLE_NAME} WHERE 1=1`;
  const binds: unknown[] = [];

  if (options.chain) {
    sql += " AND chain = ?";
    binds.push(options.chain);
  }
  if (options.type) {
    sql += " AND type = ?";
    binds.push(options.type);
  }
  if (options.status) {
    sql += " AND status = ?";
    binds.push(options.status);
  }

  sql += " ORDER BY created_at DESC";
  sql += ` LIMIT ?`;
  binds.push(options.limit || 50);
  sql += ` OFFSET ?`;
  binds.push(options.offset || 0);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<TransactionRecord>();
  return result.results || [];
}

/**
 * Update transaction status (e.g., pending -> confirmed/failed).
 */
export async function updateTxStatus(
  db: D1Database,
  id: string,
  status: TransactionRecord["status"],
  txHash?: string,
  blockNumber?: number,
  error?: string
): Promise<D1Result> {
  const updates: string[] = ["status = ?"];
  const binds: unknown[] = [status];

  if (status === "confirmed") {
    updates.push("confirmed_at = ?");
    binds.push(Date.now());
  }
  if (txHash) {
    updates.push("tx_hash = ?");
    binds.push(txHash);
  }
  if (blockNumber) {
    updates.push("block_number = ?");
    binds.push(blockNumber);
  }
  if (error) {
    updates.push("error = ?");
    binds.push(error);
  }

  binds.push(id);
  return db
    .prepare(`UPDATE ${TABLE_NAME} SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}
