/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, mock } from "bun:test";
import { getConfig, updateConfig, loadChainRpcUrl } from "../src/config.js";
import { rowTenant } from "../src/index.js";
import {
  storeTransaction,
  listTransactions,
  getTransaction,
  updateTxStatus,
  initTransactionsTable,
} from "../src/transactions.js";

const TENANT_ENV = { TENANT_ID: "acme", TENANT_MODE: "true" };

function mockKV(store: Record<string, string> = {}) {
  return {
    get: mock((key: string) => Promise.resolve(store[key] ?? null)),
    put: mock((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
  };
}

type Recorded = { sql: string; binds: unknown[] };

function mockDB() {
  const recorded: Recorded[] = [];
  const makeStmt = (sql: string): any => {
    const stmt: any = {
      bind: mock((...args: unknown[]) => {
        recorded.push({ sql, binds: args });
        return stmt;
      }),
      run: mock(() => {
        recorded.push({ sql, binds: [] });
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      }),
      all: mock(() =>
        Promise.resolve({ success: true, results: [] as unknown[] })
      ),
      first: mock(() => Promise.resolve(null)),
    };
    return stmt;
  };
  return {
    recorded,
    prepare: mock((sql: string) => makeStmt(sql)),
  };
}

describe("web3 config KV tenant scoping", () => {
  test("getConfig reads the tenant-scoped key when flagged", async () => {
    const kv = mockKV({
      "t/acme/wallet:config": JSON.stringify({ enabled: true }),
    });
    const cfg = await getConfig(kv as any, TENANT_ENV);
    expect(cfg.enabled).toBe(true);
    expect(kv.get.mock.calls[0][0]).toBe("t/acme/wallet:config");
  });

  test("getConfig reads the canonical key without flag", async () => {
    const kv = mockKV({ "wallet:config": JSON.stringify({ enabled: false }) });
    const cfg = await getConfig(kv as any);
    expect(cfg.enabled).toBe(false);
    expect(kv.get.mock.calls[0][0]).toBe("wallet:config");
  });

  test("updateConfig writes the tenant-scoped key when flagged", async () => {
    const store: Record<string, string> = {};
    const kv = mockKV(store);
    await updateConfig(kv as any, { enabled: true } as any, TENANT_ENV);
    expect(store["t/acme/wallet:config"]).toBeDefined();
    expect(store["wallet:config"]).toBeUndefined();
  });

  test("loadChainRpcUrl scopes the per-chain key when flagged", async () => {
    const kv = mockKV({
      "t/acme/wallet:rpc:ethereum": "https://tenant-rpc.example",
    });
    const url = await loadChainRpcUrl(kv as any, "ethereum", TENANT_ENV);
    expect(url).toBe("https://tenant-rpc.example");
  });
});

describe("web3 transactions tenant isolation", () => {
  const tx = {
    id: "tx-1",
    chain: "ethereum",
    txHash: "0xabc",
    type: "transfer",
    status: "pending",
    from: "0x1",
    to: "0x2",
    value: "1",
    createdAt: 1,
  } as any;

  test("storeTransaction stamps tenant_id", async () => {
    const db = mockDB();
    await storeTransaction(db as any, tx, "acme");
    const insert = db.recorded.find((r) => /INSERT OR REPLACE/i.test(r.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("tenant_id");
    expect(insert!.binds[insert!.binds.length - 1]).toBe("acme");
  });

  test("listTransactions filters by tenant when given", async () => {
    const db = mockDB();
    await listTransactions(db as any, { tenantId: "acme", limit: 10 });
    const sel = db.recorded.find((r) =>
      /FROM wallet_transactions/i.test(r.sql)
    );
    expect(sel).toBeDefined();
    expect(sel!.sql).toContain("tenant_id = ?");
    expect(sel!.binds).toContain("acme");
  });

  test("listTransactions unscoped when tenant omitted", async () => {
    const db = mockDB();
    await listTransactions(db as any, { limit: 10 });
    const sel = db.recorded.find((r) =>
      /FROM wallet_transactions/i.test(r.sql)
    );
    expect(sel).toBeDefined();
    expect(sel!.sql).not.toContain("tenant_id");
  });

  test("getTransaction guards on tenant", async () => {
    const db = mockDB();
    await getTransaction(db as any, "tx-1", "acme");
    const sel = db.recorded.find((r) =>
      /FROM wallet_transactions/i.test(r.sql)
    );
    expect(sel).toBeDefined();
    expect(sel!.sql).toContain("tenant_id = ?");
    expect(sel!.binds).toEqual(["tx-1", "acme"]);
  });

  test("updateTxStatus guards on tenant", async () => {
    const db = mockDB();
    await updateTxStatus(
      db as any,
      "tx-1",
      "confirmed",
      undefined,
      undefined,
      undefined,
      "acme"
    );
    const upd = db.recorded.find((r) =>
      /UPDATE wallet_transactions/i.test(r.sql)
    );
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain("tenant_id = ?");
    expect(upd!.binds[upd!.binds.length - 1]).toBe("acme");
  });

  test("initTransactionsTable backfills tenant column idempotently", async () => {
    const db = mockDB();
    await initTransactionsTable(db as any);
    const stmts = db.recorded.map((r) => r.sql);
    expect(stmts.some((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))).toBe(true);
    expect(stmts.some((s) => /ADD COLUMN tenant_id/i.test(s))).toBe(true);
    expect(stmts.some((s) => /CREATE INDEX IF NOT EXISTS/i.test(s))).toBe(true);
  });
});

describe("web3 rowTenant message attribution", () => {
  const env = (extra: Record<string, string> = {}) => ({ ...extra }) as any;

  test("env tenant wins over body when flagged", () => {
    expect(
      rowTenant(env({ TENANT_ID: "acme", TENANT_MODE: "true" }), {
        tenantId: "other",
      })
    ).toBe("acme");
  });

  test("body tenant used on shared path when flag off", () => {
    expect(rowTenant(env({}), { tenantId: "shared-1" })).toBe("shared-1");
  });

  test("invalid body tenant falls back to unscoped", () => {
    expect(rowTenant(env({}), { tenantId: "evil/../x" })).toBe("");
    expect(rowTenant(env({}))).toBe("");
  });
});
