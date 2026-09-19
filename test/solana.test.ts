/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  decodeCompactU16,
  signJupiterTransaction,
  buildJupiterOrderUrl,
  executeJupiterOrder,
  getJupiterUsdPrice,
  keypairFromSecret,
  publicKeyBase58,
  getSolanaBalance,
  getSolanaMintDecimals,
  SOLANA_NATIVE_MINT,
} from "../src/solana";
import { resolveToken } from "../src/token-registry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("decodeCompactU16", () => {
  it("decodes a single-byte value", () => {
    expect(decodeCompactU16(new Uint8Array([0x01]), 0)).toEqual({
      value: 1,
      nextOffset: 1,
    });
  });

  it("decodes 300 from two bytes", () => {
    expect(decodeCompactU16(new Uint8Array([0xac, 0x02]), 0).value).toBe(300);
  });

  it("throws Truncated compact-u16 on overrun", () => {
    expect(() => decodeCompactU16(new Uint8Array([0x80]), 0)).toThrow(
      /Truncated compact-u16/
    );
    expect(() => decodeCompactU16(new Uint8Array([]), 0)).toThrow(
      /Truncated compact-u16/
    );
  });
});

describe("signJupiterTransaction", () => {
  it("throws on unexpected shape", () => {
    expect(() => signJupiterTransaction("AAAA", "x".repeat(87))).toThrow(
      /shape|signature/i
    );
  });

  it("writes a detached signature into slot 0", () => {
    const seed = new Uint8Array(32).fill(7);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const secret = bs58.encode(kp.secretKey);
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const raw = new Uint8Array(1 + 64 + message.length);
    raw[0] = 0x01; // compact-u16 count = 1
    raw.set(message, 1 + 64);
    const tx = btoa(String.fromCharCode(...raw));
    const signedB64 = signJupiterTransaction(tx, secret);
    const signed = Uint8Array.from(atob(signedB64), (c) => c.charCodeAt(0));
    const sig = signed.subarray(1, 65);
    expect(nacl.sign.detached.verify(message, sig, kp.publicKey)).toBe(true);
  });
});

describe("buildJupiterOrderUrl", () => {
  it("builds ExactIn Swap V2 order URL", () => {
    const url = buildJupiterOrderUrl({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      taker: "11111111111111111111111111111111",
      slippageBps: 50,
    });
    expect(url.startsWith("https://api.jup.ag/swap/v2/order?")).toBe(true);
    expect(url).toContain("swapMode=ExactIn");
    expect(url).toContain("slippageBps=50");
  });
});

describe("executeJupiterOrder", () => {
  it("throws when status is not Success", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ status: "Failed", signature: "sig" }), {
          status: 200,
        })
    ) as unknown as typeof fetch;

    await expect(
      executeJupiterOrder({
        signedTransaction: "AA==",
        requestId: "req",
        apiKey: "test-key",
      })
    ).rejects.toThrow(/status/i);
  });

  it("returns signature on Success", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ status: "Success", signature: "5sig" }), {
          status: 200,
        })
    ) as unknown as typeof fetch;

    const sig = await executeJupiterOrder({
      signedTransaction: "AA==",
      requestId: "req",
      apiKey: "test-key",
    });
    expect(sig).toBe("5sig");
  });
});

describe("getJupiterUsdPrice", () => {
  it("returns null on failure", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 })
    ) as unknown as typeof fetch;
    expect(
      await getJupiterUsdPrice("So11111111111111111111111111111111111111112")
    ).toBeNull();
  });

  it("returns usdPrice from data[mint]", async () => {
    const mint = "So11111111111111111111111111111111111111112";
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ data: { [mint]: { usdPrice: 150.25 } } }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    expect(await getJupiterUsdPrice(mint)).toBe(150.25);
  });
});

describe("keypairFromSecret", () => {
  it("accepts a 32-byte seed", () => {
    const seed = new Uint8Array(32).fill(3);
    const kp = keypairFromSecret(bs58.encode(seed));
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
    expect(publicKeyBase58(kp).length).toBeGreaterThan(30);
  });

  it("accepts a 64-byte Phantom secret", () => {
    const seed = new Uint8Array(32).fill(9);
    const generated = nacl.sign.keyPair.fromSeed(seed);
    const kp = keypairFromSecret(bs58.encode(generated.secretKey));
    expect(Buffer.from(kp.publicKey)).toEqual(Buffer.from(generated.publicKey));
  });

  it("rejects other lengths", () => {
    expect(() => keypairFromSecret(bs58.encode(new Uint8Array(16)))).toThrow(
      /length/i
    );
  });
});

describe("getSolanaBalance", () => {
  it("uses getBalance for native SOL", async () => {
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method?: string };
        expect(body.method).toBe("getBalance");
        return new Response(JSON.stringify({ result: { value: 42 } }), {
          status: 200,
        });
      }
    ) as unknown as typeof fetch;

    const bal = await getSolanaBalance({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      owner: "11111111111111111111111111111111",
      mint: SOLANA_NATIVE_MINT,
    });
    expect(bal).toBe(42n);
  });

  it("sums jsonParsed token amounts", async () => {
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method?: string };
        expect(body.method).toBe("getTokenAccountsByOwner");
        return new Response(
          JSON.stringify({
            result: {
              value: [
                {
                  account: {
                    data: {
                      parsed: { info: { tokenAmount: { amount: "10" } } },
                    },
                  },
                },
                {
                  account: {
                    data: {
                      parsed: { info: { tokenAmount: { amount: "5" } } },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
    ) as unknown as typeof fetch;

    const bal = await getSolanaBalance({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      owner: "11111111111111111111111111111111",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    expect(bal).toBe(15n);
  });
});

describe("getSolanaMintDecimals", () => {
  it("throws on failure", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ result: { value: null } }), {
          status: 200,
        })
    ) as unknown as typeof fetch;
    await expect(
      getSolanaMintDecimals({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      })
    ).rejects.toThrow(/decimals/i);
  });
});

describe("resolveToken", () => {
  it("returns curated Solana symbols", () => {
    const sol = resolveToken("solana", "SOL");
    expect(sol.mint).toBe(SOLANA_NATIVE_MINT);
    expect(sol.decimals).toBe(9);
  });

  it("returns decimals -1 for raw Solana mints", () => {
    const raw = resolveToken(
      "solana",
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    );
    expect(raw.mint).toBe("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    expect(raw.decimals).toBe(-1);
  });

  it("throws on unknown human symbols", () => {
    expect(() => resolveToken("solana", "NOTACOIN")).toThrow(
      /Unknown token symbol/
    );
  });

  it("returns curated Ethereum USDC", () => {
    const usdc = resolveToken("ethereum", "USDC");
    expect(usdc.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(usdc.decimals).toBe(6);
  });
});
