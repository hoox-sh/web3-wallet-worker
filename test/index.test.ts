import { describe, it, expect, vi, beforeEach, afterAll } from "bun:test";
import worker from "../src/index"; // Adjust the path as necessary
import type { Env } from "../src/index";

// Mock Request and ExecutionContext
const mockRequest = (url = "http://localhost", method = "GET"): Request =>
  new Request(url, {
    method,
    headers: { "X-Internal-Auth-Key": "test-internal-key" },
  });

// Mock ExecutionContext
const mockCtx: any = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

// Test mnemonic and private key (replace with actual test values if needed, but keep them non-production)
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Default Anvil/Hardhat key
const EXPECTED_ADDRESS_FROM_PK = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const EXPECTED_ADDRESS_FROM_MNEMONIC =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Mnemonic above corresponds to this PK/address

describe("Web3 Wallet Worker with Secrets Store", () => {
  // Reset mocks before each test
  beforeEach(() => {
    (mockCtx.waitUntil as any).mockClear();
    (mockCtx.passThroughOnException as any).mockClear();
  });

  // Helper to create mock Env with specific secrets
  const createMockEnv = (secrets: {
    pk?: string | null;
    mnemonic?: string | null;
  }): Env => {
    return {
      INTERNAL_KEY_BINDING: "test-internal-key",
      WALLET_PK_SECRET:
        secrets.pk !== undefined
          ? (secrets.pk as string | undefined)
          : undefined,
      WALLET_MNEMONIC_SECRET:
        secrets.mnemonic !== undefined
          ? (secrets.mnemonic as string | undefined)
          : undefined,
      TELEGRAM_SERVICE: {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { status: 200 })
          ),
        connect: vi.fn(),
      },
    };
  };

  it("should initialize with PRIVATE_KEY and return correct address", async () => {
    const env = createMockEnv({ pk: TEST_PRIVATE_KEY });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx); // Get the actual Response

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.message).toBe(
      "Worker initialized successfully using Secrets Store."
    );
    expect(json.walletAddress).toBe(EXPECTED_ADDRESS_FROM_PK);
  });

  it("should initialize with MNEMONIC_PHRASE and return correct address", async () => {
    const env = createMockEnv({ mnemonic: TEST_MNEMONIC }); // Only provide mnemonic
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.message).toBe(
      "Worker initialized successfully using Secrets Store."
    );
    expect(json.walletAddress).toBe(EXPECTED_ADDRESS_FROM_MNEMONIC);
  });

  it("should prioritize PRIVATE_KEY over MNEMONIC_PHRASE", async () => {
    const env = createMockEnv({
      pk: TEST_PRIVATE_KEY,
      mnemonic: "other mnemonic",
    });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.walletAddress).toBe(EXPECTED_ADDRESS_FROM_PK); // PK address expected
  });

  it("should return 500 if no secrets are configured/retrieved", async () => {
    const env = createMockEnv({}); // No secrets provided to mock
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain(
      "Required wallet secret binding not configured or accessible."
    );
  });

  it("should return 500 if secrets retrieved are null", async () => {
    const env = createMockEnv({ pk: null, mnemonic: null }); // Explicitly null secrets
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain(
      "Required wallet secret binding not configured or accessible."
    );
  });

  it("should return 400 for invalid PRIVATE_KEY format", async () => {
    const env = createMockEnv({ pk: "invalid-key" });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Configured private key secret is invalid.");
  });

  it("should return 400 for invalid MNEMONIC_PHRASE format", async () => {
    const env = createMockEnv({ mnemonic: "invalid phrase" });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Configured mnemonic phrase secret is invalid.");
  });
});

// Restore original Response and Headers after all tests in this file
afterAll(() => {
  // Restore is no longer needed since we removed global mocking
});
