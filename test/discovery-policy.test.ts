import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDiscoveryCandidate, evaluateMintSafety, evaluateLiquiditySafety } from "../src/discovery-policy.js";

const safeMint = {
  mintMetadataParsed: true, mintInitialized: true, mintAuthority: null, freezeAuthority: null,
  tokenProgramOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", tokenExtensions: []
};
const curve = {
  kind: "bonding_curve" as const, programOwnerVerified: true, curvePdaVerified: true, active: true,
  realQuoteReserve: 5, virtualQuoteReserve: 30, realTokenReserve: 500_000, virtualTokenReserve: 1_000_000
};
test("accepts a fully verified bonding-curve candidate in FDV and age range", () => {
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 60, fdvUsd: 7500, mint: safeMint, liquidity: curve }).eligible, true);
});
test("fails closed when authority metadata is unavailable", () => {
  assert.equal(evaluateMintSafety({ ...safeMint, mintMetadataParsed: false }).eligible, false);
});
test("rejects active mint or freeze authority", () => {
  assert.equal(evaluateMintSafety({ ...safeMint, mintAuthority: "creator" }).eligible, false);
  assert.equal(evaluateMintSafety({ ...safeMint, freezeAuthority: "creator" }).eligible, false);
});
test("rejects dangerous Token-2022 permanent delegate extension", () => {
  assert.equal(evaluateMintSafety({ ...safeMint, tokenProgramOwner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", tokenExtensions: [{ extension: "permanentDelegate" }] }).eligible, false);
});
test("rejects unverifiable LP lock authority", () => {
  assert.equal(evaluateLiquiditySafety({ kind: "locked_lp", poolOwnerVerified: true, lpMintVerified: true, lockVaultTokenAccountVerified: true, lockAuthorityVerified: false, lockedLpAmount: 90, lpSupply: 100 }).eligible, false);
});
test("rejects entry candidates outside the five-minute age and FDV window", () => {
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 301, fdvUsd: 7500, mint: safeMint, liquidity: curve }).eligible, false);
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 60, fdvUsd: 12000, mint: safeMint, liquidity: curve }).eligible, false);
});
