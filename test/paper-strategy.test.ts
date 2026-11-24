import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScalpDecision } from "../src/paper-strategy.js";

const base = {
  now: 70_000, launchAt: 0, price: 0.00001, fdvUsd: 7500, quoteLiquidity: 20,
  recentTrades: Array.from({ length: 12 }, (_, i) => ({ at: 69_000 + i * 50, side: "buy" as const, quoteAmount: 1, wallet: `wallet-${i}`, confidence: "high" as const })),
  creatorSelling: false, reserveDropPct: 0, priceImpactPctForOneDollar: 1, securityPassed: true
};
test("does not enter before 30 seconds", () => {
  assert.equal(evaluateScalpDecision({ ...base, now: 29_000 }).action, "wait");
});
test("can enter only within 30 seconds to five minutes after security and momentum checks", () => {
  assert.equal(evaluateScalpDecision(base).action, "enter");
  assert.equal(evaluateScalpDecision({ ...base, now: 301_000 }).action, "reject");
});
test("creator selling triggers immediate paper exit", () => {
  const opened = evaluateScalpDecision(base).position!;
  const result = evaluateScalpDecision({ ...base, now: 80_000, creatorSelling: true }, opened);
  assert.equal(result.action, "exit");
  assert.equal(result.position?.exitReason, "creator_or_creator_fee_payer_selling");
});
test("severe reserve deterioration rejects a new entry", () => {
  assert.equal(evaluateScalpDecision({ ...base, reserveDropPct: -25 }).action, "reject");
});
test("closed positions cannot re-enter the same mint", () => {
  const opened = evaluateScalpDecision(base).position!;
  const closed = evaluateScalpDecision({ ...base, now: 80_000, creatorSelling: true }, opened).position!;
  assert.equal(evaluateScalpDecision({ ...base, now: 90_000 }, closed).action, "reject");
});
