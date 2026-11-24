import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateHolderConcentration,
  calculatePricePathMetrics,
  calculateTradeFlowMetrics,
  estimateConstantProductSwap,
  reconstructTokenResearch
} from "../src/research-metrics.js";

test("price path derives excursions, drawdown and horizon returns", () => {
  const result = calculatePricePathMetrics([
    { at: 0, price: 1 }, { at: 5_000, price: 2 }, { at: 10_000, price: 1.5 }
  ]);
  assert.ok(result);
  assert.equal(result.maxFavorableExcursionPct, 100);
  assert.equal(result.maxAdverseExcursionPct, 0);
  assert.equal(result.maxDrawdownPct, -25);
  assert.equal(result.timeToHighSeconds, 5);
  assert.equal(result.totalReturnPct, 50);
});

test("trade flow separates buy and sell pressure by time window", () => {
  const result = calculateTradeFlowMetrics([
    { at: 95_000, side: "buy", quoteAmount: 2, wallet: "a", slot: 1 },
    { at: 98_000, side: "buy", quoteAmount: 3, wallet: "b", slot: 1 },
    { at: 99_000, side: "sell", quoteAmount: 1, wallet: "c", slot: 2 }
  ], 100_000);
  const window = result.windows["5s"] as { tradeCount: number; netFlowQuote: number; uniqueWallets: number; sameSlotTradeCount: number };
  assert.equal(window.tradeCount, 3);
  assert.equal(window.netFlowQuote, 4);
  assert.equal(window.uniqueWallets, 3);
  assert.equal(window.sameSlotTradeCount, 2);
});

test("holder concentration returns HHI, effective holders and Gini", () => {
  const result = calculateHolderConcentration([{ amount: 90 }, { amount: 10 }]);
  assert.ok(Math.abs(result.hhi - 0.82) < 1e-12);
  assert.ok(result.effectiveHolderCount != null && result.effectiveHolderCount < 2);
  assert.ok(Math.abs(result.gini - 0.4) < 1e-12);
});

test("constant product estimate accounts for fee and worsens with larger orders", () => {
  const small = estimateConstantProductSwap({ baseReserve: 1_000, quoteReserve: 1_000, amountIn: 1, side: "buy", feeBps: 100 });
  const large = estimateConstantProductSwap({ baseReserve: 1_000, quoteReserve: 1_000, amountIn: 100, side: "buy", feeBps: 100 });
  assert.ok(small && large);
  assert.ok(small.amountOut < 1);
  assert.ok(large.priceImpactPct > small.priceImpactPct);
  assert.equal(small.method, "constant_product_reserve_approximation_not_executable_quote");
});

test("reconstruction aggregates raw trade and fee events", () => {
  const result = reconstructTokenResearch([
    { kind: "launch_detected", mint: "mint", firstSeenAt: 1_000 },
    { kind: "trade_metric", blockTime: 2, slot: 3, observations: [{ side: "buy", quoteAmount: 2, priceQuote: 1, wallet: "a" }] },
    { kind: "transaction_fee", networkFeeLamports: 5, transactionFailed: true, computeUnitsConsumed: 10 }
  ]);
  assert.equal(result.mint, "mint");
  assert.equal(result.networkFees.networkFeeLamports, 5);
  assert.equal(result.networkFees.failedTransactionRatePct, 100);
  assert.equal(result.tradeFlow.totalTradeObservations, 1);
});
