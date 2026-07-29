/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/test/helpers.ts

import { mock } from "bun:test";
import type { Env } from "../src/index";
import type { WalletConfig, TokenInfo, TransactionRecord } from "../src/types";

/** Create mock KV namespace */
export function createMockKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: mock(async (key: string) => store[key] ?? null),
    put: mock(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: mock(async (key: string) => {
      delete store[key];
    }),
    list: mock(async () => ({
      keys: Object.keys(store).map((k) => ({ name: k })),
    })),
    getWithMetadata: mock(() => Promise.reject(new Error("not implemented"))),
  } as unknown as KVNamespace;
}

/** Create mock D1 database */
export function createMockD1(): D1Database {
  const runMock = mock(async () => ({ success: true }));
  const firstMock = mock(async () => null);
  const allMock = mock(async () => ({ results: [] as unknown[] }));

  const boundStmt = {
    first: firstMock,
    run: runMock,
    all: allMock,
  };

  const stmt = {
    bind: mock(() => boundStmt),
    run: runMock,
    first: firstMock,
    all: allMock,
  };

  return {
    prepare: mock(() => stmt),
  } as unknown as D1Database;
}

/** Create mock Fetcher (service binding) */
export function createMockFetcher(
  response: Response = new Response(JSON.stringify({ success: true }), {
    status: 200,
  })
): Fetcher {
  return {
    fetch: mock(async (_req: Request | string) => response),
    connect: mock(() => {}),
  } as unknown as Fetcher;
}

/** Create mock execution context */
export function createMockCtx() {
  return {
    waitUntil: mock(() => {}),
    passThroughOnException: mock(() => {}),
  } as unknown as ExecutionContext;
}

/** Create mock Env */
export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    INTERNAL_KEY_BINDING: "test-internal-key",
    WALLET_PK_SECRET: undefined,
    WALLET_MNEMONIC_SECRET: undefined,
    TELEGRAM_SERVICE: createMockFetcher(),
    ANALYTICS_SERVICE: createMockFetcher(),
    WALLET_CONFIG_KV: createMockKV(),
    CONFIG_KV: createMockKV(),
    TRANSACTIONS_DB: createMockD1(),
    ...overrides,
  } as Env;
}

/** Create mock request */
export function mockRequest(
  url = "http://localhost/",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  const init: RequestInit = {
    method,
    headers: {
      "X-Internal-Auth-Key": "test-internal-key",
      "Content-Type": "application/json",
      ...headers,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// Test addresses
export const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
export const TEST_WALLET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const TEST_TOKEN_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI
export const TEST_RECEIVER_ADDRESS =
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const testTokenInfo: TokenInfo = {
  address: TEST_TOKEN_ADDRESS,
  chain: "ethereum",
  symbol: "DAI",
  name: "Dai Stablecoin",
  decimals: 18,
};

export const testWalletConfig: WalletConfig = {
  enabled: true,
  defaultChain: "ethereum",
  dex: {
    slippageTolerance: 0.5,
    gasMultiplier: 1.2,
    maxApprovalAmount: "1000000000000000000000000",
  },
  security: {
    maxTransactionValueUsd: 10000,
    requireConfirmation: true,
    whitelistedContractsOnly: true,
    whitelistedContracts: [],
  },
  updatedAt: Date.now(),
};
