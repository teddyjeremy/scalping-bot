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
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 60, fdvUsd: 7500, mint: safeMint, liquidity: curve, holderSnapshotVerified: true, top20HolderSharePct: 30, creatorHoldingSharePct: 0, feePayerHoldingSharePct: 0 }).eligible, true);
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
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 301, fdvUsd: 7500, mint: safeMint, liquidity: curve, holderSnapshotVerified: true, top20HolderSharePct: 30, creatorHoldingSharePct: 0, feePayerHoldingSharePct: 0 }).eligible, false);
  assert.equal(evaluateDiscoveryCandidate({ launchAgeSeconds: 60, fdvUsd: 12000, mint: safeMint, liquidity: curve, holderSnapshotVerified: true, top20HolderSharePct: 30, creatorHoldingSharePct: 0, feePayerHoldingSharePct: 0 }).eligible, false);
});

test("fails closed when early holder distribution cannot be verified", () => {
  const result = evaluateDiscoveryCandidate({ launchAgeSeconds: 60, fdvUsd: 7500, mint: safeMint, liquidity: curve });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("holder_distribution_snapshot_unverified"));
});
test("rejects extreme holder and creator concentration", () => {
  const result = evaluateDiscoveryCandidate({
    launchAgeSeconds: 60, fdvUsd: 7500, mint: safeMint, liquidity: curve,
    holderSnapshotVerified: true, top20HolderSharePct: 95, creatorHoldingSharePct: 35, feePayerHoldingSharePct: 0
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("top20_holder_concentration_above_90_percent"));
  assert.ok(result.reasons.includes("creator_holds_over_30_percent_of_supply"));
});
