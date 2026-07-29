/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Focused tests for the C-5 fix from the 2026-06-27 worker audit:
 *
 * C-5: PUT /config previously used a Zod schema with `.passthrough()`
 * and only 3 chain-level fields (chainId, rpcUrl, maxGasPrice), but
 * the route handler did a SHALLOW merge (`{ ...current, ...body }`).
 * An attacker could submit:
 *   { security: { whitelistedContractsOnly: false },
 *     dex: { maxApprovalAmount: "999999999999" } }
 * and replace the entire security/dex sub-objects with
 * attacker-controlled values.
 *
 * This file tests the schema and the deep-merge behavior in isolation
 * (without importing the full worker, which has a complex import
 * graph).
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";

// Mirror of the production schema (see src/index.ts). Kept here
// in-sync with the source so a future refactor that loosens the
// schema fails this test.
const DexConfigUpdateSchema = z
  .object({
    slippageTolerance: z.number().nonnegative().optional(),
    gasMultiplier: z.number().positive().optional(),
    maxApprovalAmount: z.string().optional(),
  })
  .strict();

const SecurityConfigUpdateSchema = z
  .object({
    maxTransactionValueUsd: z.number().nonnegative().optional(),
    requireConfirmation: z.boolean().optional(),
    whitelistedContractsOnly: z.boolean().optional(),
    whitelistedContracts: z.array(z.string()).optional(),
  })
  .strict();

const WalletConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultChain: z
      .enum(["ethereum", "bsc", "polygon", "arbitrum", "optimism"])
      .optional(),
    dex: DexConfigUpdateSchema.optional(),
    security: SecurityConfigUpdateSchema.optional(),
  })
  .strict();

// Mirror of the production deep-merge in src/index.ts:445-460.
function deepMergeConfig(
  current: {
    enabled: boolean;
    defaultChain: string;
    dex: {
      slippageTolerance: number;
      gasMultiplier: number;
      maxApprovalAmount: string;
    };
    security: {
      maxTransactionValueUsd: number;
      requireConfirmation: boolean;
      whitelistedContractsOnly: boolean;
      whitelistedContracts: string[];
    };
  },
  body: z.infer<typeof WalletConfigUpdateSchema>
) {
  return {
    ...current,
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.defaultChain !== undefined
      ? { defaultChain: body.defaultChain }
      : {}),
    dex: { ...current.dex, ...(body.dex ?? {}) },
    security: { ...current.security, ...(body.security ?? {}) },
  };
}

const DEFAULT_CURRENT = {
  enabled: true,
  defaultChain: "ethereum",
  dex: {
    slippageTolerance: 0.5,
    gasMultiplier: 1.2,
    maxApprovalAmount: "1000000",
  },
  security: {
    maxTransactionValueUsd: 10_000,
    requireConfirmation: true,
    whitelistedContractsOnly: true,
    whitelistedContracts: ["0x1234567890abcdef1234567890abcdef12345678"],
  },
};

describe("WalletConfigUpdateSchema (C-5 fix)", () => {
  it("is .strict() (rejects unknown top-level fields)", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      enabled: true,
      evilUnknownField: "injection",
    });
    expect(result.success).toBe(false);
  });

  it("is .strict() on the dex sub-schema (rejects unknown dex fields)", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      dex: { slippageTolerance: 1.0, evilDexField: true },
    });
    expect(result.success).toBe(false);
  });

  it("is .strict() on the security sub-schema (rejects unknown security fields)", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      security: { whitelistedContractsOnly: false, evilSecField: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid partial update with only `enabled`", () => {
    const result = WalletConfigUpdateSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts a valid partial update with only security fields", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      security: { whitelistedContractsOnly: false },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid partial update with only dex fields", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      dex: { slippageTolerance: 1.0 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects defaultChain values outside the enum", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      defaultChain: "solana",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative slippageTolerance", () => {
    const result = WalletConfigUpdateSchema.safeParse({
      dex: { slippageTolerance: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero or negative gasMultiplier", () => {
    expect(
      WalletConfigUpdateSchema.safeParse({ dex: { gasMultiplier: 0 } }).success
    ).toBe(false);
    expect(
      WalletConfigUpdateSchema.safeParse({ dex: { gasMultiplier: -1.2 } })
        .success
    ).toBe(false);
  });
});

describe("deep-merge behavior (C-5 fix)", () => {
  it("merges `security` sub-object partially without clobbering siblings", () => {
    const body: z.infer<typeof WalletConfigUpdateSchema> = {
      security: { whitelistedContractsOnly: false },
    };
    const merged = deepMergeConfig(DEFAULT_CURRENT, body);
    // Updated field:
    expect(merged.security.whitelistedContractsOnly).toBe(false);
    // Sibling fields must be preserved (the C-5 bug would lose them):
    expect(merged.security.maxTransactionValueUsd).toBe(10_000);
    expect(merged.security.requireConfirmation).toBe(true);
    expect(merged.security.whitelistedContracts).toEqual([
      "0x1234567890abcdef1234567890abcdef12345678",
    ]);
  });

  it("merges `dex` sub-object partially without clobbering siblings", () => {
    const body: z.infer<typeof WalletConfigUpdateSchema> = {
      dex: { maxApprovalAmount: "999999999999" },
    };
    const merged = deepMergeConfig(DEFAULT_CURRENT, body);
    // Updated field:
    expect(merged.dex.maxApprovalAmount).toBe("999999999999");
    // Sibling fields must be preserved:
    expect(merged.dex.slippageTolerance).toBe(0.5);
    expect(merged.dex.gasMultiplier).toBe(1.2);
  });

  it("preserves top-level fields (enabled, defaultChain) when only sub-objects are updated", () => {
    const body: z.infer<typeof WalletConfigUpdateSchema> = {
      security: { whitelistedContractsOnly: false },
      dex: { slippageTolerance: 2.0 },
    };
    const merged = deepMergeConfig(DEFAULT_CURRENT, body);
    expect(merged.enabled).toBe(true);
    expect(merged.defaultChain).toBe("ethereum");
    expect(merged.security.whitelistedContractsOnly).toBe(false);
    expect(merged.dex.slippageTolerance).toBe(2.0);
  });

  it("top-level field updates take effect when provided", () => {
    const body: z.infer<typeof WalletConfigUpdateSchema> = {
      enabled: false,
      defaultChain: "polygon",
    };
    const merged = deepMergeConfig(DEFAULT_CURRENT, body);
    expect(merged.enabled).toBe(false);
    expect(merged.defaultChain).toBe("polygon");
  });

  it("the C-5 attack scenario: flipping whitelistedContractsOnly to false alone", () => {
    // Documents the original attack: an attacker submits
    //   { security: { whitelistedContractsOnly: false } }
    // hoping the shallow merge drops requireConfirmation and the
    // whitelist. The fix: the deep merge preserves them.
    const body: z.infer<typeof WalletConfigUpdateSchema> = {
      security: { whitelistedContractsOnly: false },
    };
    const merged = deepMergeConfig(DEFAULT_CURRENT, body);

    // The attacker's only modification took effect:
    expect(merged.security.whitelistedContractsOnly).toBe(false);
    // ...but the safety mechanisms remain:
    expect(merged.security.requireConfirmation).toBe(true);
    expect(merged.security.whitelistedContracts).toEqual([
      "0x1234567890abcdef1234567890abcdef12345678",
    ]);
  });
});

describe("source - C-5 fix verification", () => {
  // Static analysis: confirm the production code uses .strict() (not
  // .passthrough()) and does a deep merge (not a shallow spread).
  it("WalletConfigUpdateSchema in source uses .strict() (not .passthrough())", async () => {
    const source = await Bun.file(
      new URL("../src/index.ts", import.meta.url)
    ).text();
    // Find the WalletConfigUpdateSchema block and check it ends with .strict()
    const matches = source.match(
      /const WalletConfigUpdateSchema = z[\s\S]*?\n\}/
    );
    expect(matches).not.toBeNull();
    if (matches) {
      expect(matches[0]).toContain(".strict()");
      expect(matches[0]).not.toContain(".passthrough()");
    }
  });

  it("PUT /config route does a deep merge of `dex` and `security`", async () => {
    const source = await Bun.file(
      new URL("../src/index.ts", import.meta.url)
    ).text();
    // The deep merge should be: dex: { ...current.dex, ...(body.dex ?? {}) }
    expect(source).toMatch(
      /dex:\s*\{\s*\.\.\.current\.dex\s*,\s*\.\.\.\(body\.dex/
    );
    expect(source).toMatch(
      /security:\s*\{\s*\.\.\.current\.security\s*,\s*\.\.\.\(body\.security/
    );
  });
});
