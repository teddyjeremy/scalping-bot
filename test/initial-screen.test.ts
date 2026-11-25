import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInitialScreen } from "../src/initial-screen.js";

test("missing historical security evidence is unverified, never eligible", () => {
  const result = evaluateInitialScreen({});
  assert.equal(result.status, "unverified");
  assert.ok(result.reasons.includes("historical_mint_authority_state_unverified"));
  assert.ok(result.reasons.includes("token_2022_extensions_not_assessed"));
  assert.ok(result.reasons.includes("historical_curve_or_locked_pool_liquidity_unverified"));
});

test("known unsafe mint authority rejects", () => {
  const result = evaluateInitialScreen({ mintAuthorityRevoked: false });
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.includes("mint_authority_not_revoked"));
});

test("complete positive security evidence can pass this security gate", () => {
  const result = evaluateInitialScreen({
    mintAuthorityRevoked: true,
    tokenExtensionsAssessed: true,
    tokenExtensionsSafe: true,
    pumpCurveVerifiedActive: true,
    pumpRealQuoteReservesPositive: true
  });
  assert.equal(result.status, "eligible");
  assert.deepEqual(result.reasons, []);
});

test("migrated pool requires at least 90 percent verified lock", () => {
  const result = evaluateInitialScreen({
    mintAuthorityRevoked: true,
    tokenExtensionsAssessed: true,
    tokenExtensionsSafe: true,
    migratedPoolVerified: true,
    migratedPoolLockPercent: 89.99
  });
  assert.equal(result.status, "rejected");
});
