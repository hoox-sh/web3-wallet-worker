/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/web3-wallet-worker/src/solana.ts
// Jupiter Swap V2 + Solana RPC. Secrets are never logged.

import bs58 from "bs58";
import nacl from "tweetnacl";

export const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2";
export const JUPITER_PRICE_V3 = "https://api.jup.ag/price/v3";

/** Jupiter v6 program id (records/docs). */
export const JUPITER_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const RPC_TIMEOUT_MS = 10_000;
const JUPITER_TIMEOUT_MS = 10_000;

export interface JupiterOrder {
  transaction: string;
  requestId: string;
}

export interface SolanaKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Solana shortvec / compact-u16 (base-128 LE).
 * Throws `Truncated compact-u16` on overrun.
 */
export function decodeCompactU16(
  bytes: Uint8Array,
  offset: number
): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < 3; i++) {
    if (pos >= bytes.length) {
      throw new Error("Truncated compact-u16");
    }
    const byte = bytes[pos]!;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: pos };
    }
    shift += 7;
  }
  throw new Error("Truncated compact-u16");
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function decodeSecretBytes(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const arr: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(arr) ||
      !arr.every((n) => typeof n === "number" && Number.isInteger(n))
    ) {
      throw new Error("Invalid Solana secret key format");
    }
    return Uint8Array.from(arr as number[]);
  }
  const hexBody = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (
    /^[0-9a-fA-F]+$/.test(hexBody) &&
    (hexBody.length === 64 || hexBody.length === 128)
  ) {
    const out = new Uint8Array(hexBody.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return bs58.decode(trimmed);
}

/**
 * Accept a 64-byte Phantom secret or a 32-byte seed.
 * Rejects any other length. Never logs the secret.
 */
export function keypairFromSecret(secret: string): SolanaKeypair {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Solana secret is empty");
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeSecretBytes(secret);
  } catch (err) {
    if (err instanceof Error && /secret key/i.test(err.message)) throw err;
    throw new Error("Invalid Solana secret key format", { cause: err });
  }
  if (bytes.length === 64) {
    return nacl.sign.keyPair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return nacl.sign.keyPair.fromSeed(bytes);
  }
  throw new Error(`Invalid Solana secret key length: ${bytes.length}`);
}

export function publicKeyBase58(keypair: SolanaKeypair): string {
  return bs58.encode(keypair.publicKey);
}

/**
 * Wire-sign a Jupiter (Solana) transaction:
 * base64 → compact-u16 sig count → N×64 slots → message bytes.
 * Sign the message (tweetnacl detached), write into slot 0, re-encode.
 * Throws `Unexpected Jupiter transaction shape` if count !== 1 or
 * the buffer is too short.
 */
export function signJupiterTransaction(
  txBase64: string,
  secret: string
): string {
  let raw: Uint8Array;
  try {
    raw = fromBase64(txBase64);
  } catch {
    throw new Error("Unexpected Jupiter transaction shape");
  }
  if (raw.length < 2) {
    throw new Error("Unexpected Jupiter transaction shape");
  }
  const { value: sigCount, nextOffset } = decodeCompactU16(raw, 0);
  const sigBytes = sigCount * 64;
  if (sigCount !== 1 || nextOffset + sigBytes > raw.length) {
    throw new Error("Unexpected Jupiter transaction shape");
  }
  const msgOffset = nextOffset + sigBytes;
  const message = raw.subarray(msgOffset);
  if (message.length === 0) {
    throw new Error("Unexpected Jupiter transaction shape");
  }
  const keypair = keypairFromSecret(secret);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  if (signature.length !== 64) {
    throw new Error("Unexpected signature length");
  }
  const signed = new Uint8Array(raw);
  signed.set(signature, nextOffset);
  return toBase64(signed);
}

export function buildJupiterOrderUrl(params: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  taker: string;
  slippageBps: number;
}): string {
  const url = new URL(`${JUPITER_SWAP_V2_BASE}/order`);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", String(params.amount));
  url.searchParams.set("taker", params.taker);
  url.searchParams.set("slippageBps", String(params.slippageBps));
  url.searchParams.set("swapMode", "ExactIn");
  return url.toString();
}

export async function requestJupiterOrder(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  slippageBps: number;
  apiKey: string;
}): Promise<JupiterOrder> {
  const url = buildJupiterOrderUrl(params);
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": params.apiKey },
    signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jupiter order failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    transaction?: string;
    swapTransaction?: string;
    requestId?: string;
  };
  const transaction = data.transaction ?? data.swapTransaction;
  if (!transaction || !data.requestId) {
    throw new Error("Jupiter order missing transaction or requestId");
  }
  return { transaction, requestId: data.requestId };
}

export async function executeJupiterOrder(params: {
  signedTransaction: string;
  requestId: string;
  apiKey: string;
}): Promise<string> {
  const res = await fetch(`${JUPITER_SWAP_V2_BASE}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": params.apiKey,
    },
    body: JSON.stringify({
      signedTransaction: params.signedTransaction,
      requestId: params.requestId,
    }),
    signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jupiter execute failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    status?: string;
    signature?: string;
  };
  if (data.status !== "Success" || typeof data.signature !== "string") {
    throw new Error(`Jupiter execute status ${data.status ?? "unknown"}`);
  }
  return data.signature;
}

/**
 * Jupiter Price V3. Returns usdPrice or null — never throws.
 */
export async function getJupiterUsdPrice(
  mint: string,
  apiKey?: string
): Promise<number | null> {
  try {
    const url = `${JUPITER_PRICE_V3}?ids=${encodeURIComponent(mint)}`;
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: Record<string, { usdPrice?: unknown }>;
    } & Record<string, { usdPrice?: unknown } | undefined>;
    const usd = body.data?.[mint]?.usdPrice ?? body[mint]?.usdPrice;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      return null;
    }
    return usd;
  } catch {
    return null;
  }
}

async function solanaRpc(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Solana RPC ${method} failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(body.error.message ?? `Solana RPC ${method} error`);
  }
  return body.result;
}

/**
 * Native SOL (`getBalance`) when mint is the wrapped-SOL mint or omitted.
 * Otherwise sum `tokenAmount.amount` from `getTokenAccountsByOwner`.
 */
export async function getSolanaBalance(params: {
  rpcUrl: string;
  owner: string;
  mint?: string;
}): Promise<bigint> {
  const mint = params.mint;
  if (!mint || mint === SOLANA_NATIVE_MINT) {
    const result = (await solanaRpc(params.rpcUrl, "getBalance", [
      params.owner,
    ])) as { value?: number } | number;
    const lamports = typeof result === "number" ? result : (result?.value ?? 0);
    return BigInt(lamports);
  }
  const result = (await solanaRpc(params.rpcUrl, "getTokenAccountsByOwner", [
    params.owner,
    { mint },
    { encoding: "jsonParsed" },
  ])) as {
    value?: Array<{
      account?: {
        data?: {
          parsed?: { info?: { tokenAmount?: { amount?: string } } };
        };
      };
    }>;
  };
  let sum = 0n;
  for (const acc of result.value ?? []) {
    const amount = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amount) sum += BigInt(amount);
  }
  return sum;
}

/**
 * Mint decimals via `getAccountInfo` jsonParsed. Throws on failure.
 */
export async function getSolanaMintDecimals(params: {
  rpcUrl: string;
  mint: string;
}): Promise<number> {
  const result = (await solanaRpc(params.rpcUrl, "getAccountInfo", [
    params.mint,
    { encoding: "jsonParsed" },
  ])) as {
    value?: {
      data?: { parsed?: { info?: { decimals?: number } } };
    } | null;
  };
  const decimals = result.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== "number" || !Number.isFinite(decimals)) {
    throw new Error(`Failed to fetch Solana mint decimals for ${params.mint}`);
  }
  return decimals;
}
