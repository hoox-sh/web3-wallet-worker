import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock providers before importing pricing
mock.module("../src/providers", () => ({
  getReadOnlyProvider: () => ({}),
}));

mock.module("../src/tokens", () => ({
  getTokenInfo: async () => ({
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    chain: "ethereum",
    symbol: "USDT",
    name: "Tether",
    decimals: 6,
  }),
}));

const { estimateTokenValueUsd, resolveEnforcedValueUsd } = await import(
  "../src/pricing"
);

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
    // Unknown token, no DEX pair, no stable match → unavailable
    const result = await resolveEnforcedValueUsd({
      chain: "ethereum",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      amountRaw: 10n ** 18n,
    });
    // getTokenInfo is mocked; getAmountsOut will fail without a real provider
    // → unavailable → fail closed
    expect(result.ok).toBe(false);
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
