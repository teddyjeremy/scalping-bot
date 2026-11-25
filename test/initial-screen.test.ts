import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInitialScreen, evaluateBehaviouralWindows } from "../src/initial-screen.js";

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

test("behavioural windows use only trades at or before each timestamp", () => {
  const events = [
    ...Array.from({ length: 5 }, (_, i) => ({ secondsSinceLaunch: 10 + i, side: "buy" as const, user: "wallet-" + i, quoteAmount: 2 })),
    { secondsSinceLaunch: 40, side: "sell" as const, user: "seller", quoteAmount: 1 },
    { secondsSinceLaunch: 90, side: "sell" as const, user: "seller2", quoteAmount: 20 }
  ];
  const windows = evaluateBehaviouralWindows(events);
  assert.equal(windows[0].metrics.successfulBuyEvents, 5);
  assert.equal(windows[0].metrics.successfulSellEvents, 0);
  assert.equal(windows[1].metrics.successfulSellEvents, 1);
  assert.equal(windows[2].metrics.successfulSellEvents, 2);
  assert.equal(windows[2].status, "rejected");
});
