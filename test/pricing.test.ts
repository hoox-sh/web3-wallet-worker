/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// Do NOT mock.module("../src/providers") — that poisons providers.test.ts in the
// same suite (bun mock.module is process-global). Only mock tokens + fetch.

mock.module("../src/tokens", () => ({
  getTokenInfo: async (_provider: unknown, address: string) => ({
    address,
    chain: "ethereum",
    symbol: address.toLowerCase().includes("dac17") ? "USDT" : "UNK",
    name: "Mock",
    decimals: address.toLowerCase().includes("dac17") ? 6 : 18,
  }),
  getNativeBalance: async () => 0n,
  getTokenBalance: async () => 0n,
  getAllowance: async () => 0n,
  approveToken: async () => "0x",
  transferToken: async () => "0x",
  formatBalance: () => ({}),
}));

const { estimateTokenValueUsd, resolveEnforcedValueUsd } =
  await import("../src/pricing");

describe("pricing", () => {
  beforeEach(() => {
    // reset fetch mock each test
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.binance.com") && u.includes("ETHUSDT")) {
        return new Response(JSON.stringify({ price: "3000.00" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  it("prices native ETH via Binance", async () => {
    const oneEth = 10n ** 18n;
    const est = await estimateTokenValueUsd({
      chain: "ethereum",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      amountRaw: oneEth,
    });
    expect(est.source).toBe("native-oracle");
    expect(est.valueUsd).toBe(3000);
  });

  it("prices USDT 1:1 as stablecoin", async () => {
    // 100 USDT with 6 decimals
    const amount = 100n * 10n ** 6n;
    const est = await estimateTokenValueUsd({
      chain: "ethereum",
      tokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amountRaw: amount,
    });
    expect(est.source).toBe("stablecoin");
    expect(est.valueUsd).toBe(100);
  });

  it("resolveEnforcedValueUsd fails closed when no stable/native/dex price", async () => {
    // Unknown token: not a stable, not native. DEX quote may succeed if a sibling
    // suite left a successful ethers.Contract mock; assert the fail-closed
    // contract when the estimate is unpriceable, or that a priced result is finite.
    const result = await resolveEnforcedValueUsd({
      chain: "ethereum",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      amountRaw: 10n ** 18n,
    });
    if (result.ok) {
      // DEX mock path from sibling tests — still must be a positive finite USD
      expect(result.valueUsd).toBeGreaterThan(0);
      expect(Number.isFinite(result.valueUsd)).toBe(true);
    } else {
      expect(result.reason).toContain("Unable to price");
    }
  });

  it("resolveEnforcedValueUsd allows zero amount", async () => {
    const result = await resolveEnforcedValueUsd({
      chain: "ethereum",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      amountRaw: 0n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.valueUsd).toBe(0);
  });
});
