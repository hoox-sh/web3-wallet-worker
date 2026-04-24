import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterAll,
} from "bun:test";
import worker from "../src/index"; // Adjust the path as necessary
import type { Env } from "../src/index";

// Save original Response and Headers before mocking
const originalResponse = global.Response;
const originalHeaders = global.Headers;

// Mock Request and ExecutionContext
// Note: Cloudflare Worker types might not have a standard Request constructor globally available in Jest env.
// We might need a more robust mocking strategy if tests fail due to Request/Response/fetch availability.
// For now, basic object mocks suffice for the structure.
const mockRequest = (url = "http://localhost", method = "GET"): Request =>
  ({
    url,
    method,
    // Add other Request properties if the worker uses them
    headers: new Headers(),
    clone: vi.fn(),
    // ... other necessary Request properties/methods mocked
  }) as unknown as Request;

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

// Mock Response class if needed - bun test might provide it, but explicit mock can be safer
global.Response = vi.fn().mockImplementation((body, init) => {
  let jsonData = {};
  try {
    // Attempt to parse only if body looks like JSON (starts with { or [)
    if (
      typeof body === "string" &&
      (body.trim().startsWith("{") || body.trim().startsWith("["))
    ) {
      jsonData = JSON.parse(body);
    }
  } catch (e) {
    // Ignore parse error if body is not JSON
  }

  return {
    status: init?.status || 200,
    headers: new Headers(init?.headers),
    // Return the parsed JSON or empty object
    json: vi.fn().mockResolvedValue(jsonData),
    // Return the original body string
    text: vi.fn().mockResolvedValue(body || ""),
    clone: vi.fn(),
    ok: (init?.status || 200) >= 200 && (init?.status || 200) < 300,
    // ... other necessary Response properties/methods mocked
  };
}) as unknown as typeof Response;

global.Headers = vi.fn().mockImplementation((init) => {
  const headers = new Map(Object.entries(init || {}));
  return {
    append: vi.fn((name, value) => headers.set(name.toLowerCase(), value)),
    delete: vi.fn((name) => headers.delete(name.toLowerCase())),
    get: vi.fn((name) => headers.get(name.toLowerCase()) || null),
    has: vi.fn((name) => headers.has(name.toLowerCase())),
    set: vi.fn((name, value) => headers.set(name.toLowerCase(), value)),
    forEach: vi.fn((callback) =>
      headers.forEach((value, key) => callback(value, key, headers))
    ),
    // Add other Headers methods if needed
    [Symbol.iterator]: vi.fn(() => headers.entries()),
  };
}) as unknown as typeof Headers;

describe("Web3 Wallet Worker with Secrets Store", () => {
  // Reset mocks before each test
  beforeEach(() => {
    // Reset the mock call counts and recorded calls
    (global.Response as any).mockClear();
    (mockCtx.waitUntil as any).mockClear();
    (mockCtx.passThroughOnException as any).mockClear();
  });

  // Helper to create mock Env with specific secrets
  const createMockEnv = (secrets: {
    pk?: string | null;
    mnemonic?: string | null;
  }): Env => {
    return {
      WALLET_PK_SECRET: {
        get: vi
          .fn()
          .mockResolvedValue(secrets.pk !== undefined ? secrets.pk : null),
      },
      WALLET_MNEMONIC_SECRET: {
        get: vi
          .fn()
          .mockResolvedValue(
            secrets.mnemonic !== undefined ? secrets.mnemonic : null
          ),
      },
      TELEGRAM_SERVICE: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
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
    // Check if the correct secret was requested
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1); // Both are checked initially
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
    // Check if the correct secret was requested
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1);
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
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1);
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
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1);
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
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1);
  });

  it("should return 500 for invalid PRIVATE_KEY format", async () => {
    const env = createMockEnv({ pk: "invalid-key" });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("Configured private key secret is invalid.");
    expect(env.WALLET_PK_SECRET?.get).toHaveBeenCalledTimes(1);
    expect(env.WALLET_MNEMONIC_SECRET?.get).toHaveBeenCalledTimes(1);
  });

  it("should return 500 for invalid MNEMONIC_PHRASE format", async () => {
    const env = createMockEnv({ mnemonic: "invalid phrase" });
    const req = mockRequest();
    const res = await worker.fetch(req, env, mockCtx);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("Configured mnemonic phrase secret is invalid.");
  });
});

// Restore original Response and Headers after all tests in this file
afterAll(() => {
  global.Response = originalResponse;
  global.Headers = originalHeaders;
});
