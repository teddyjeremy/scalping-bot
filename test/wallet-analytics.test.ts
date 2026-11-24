import test from "node:test";
import assert from "node:assert/strict";
import { extractFundingSources, summarizeWalletCohorts, updateWalletProfile } from "../src/wallet-analytics.js";

test("classifies a launch creator's buys and sells without conflating fee payer with creator", () => {
  const context = { observedAt: 10_000, slot: 101, launchSlot: 100, launchAt: 0, launchFeePayer: "payer", creator: "dev" };
  const dev = updateWalletProfile(undefined, { wallet: "dev", side: "buy", tokenAmount: 100, quoteAmount: 2 }, context);
  const afterSell = updateWalletProfile(dev, { wallet: "dev", side: "sell", tokenAmount: 25, quoteAmount: 1 }, { ...context, observedAt: 12_000, slot: 102 });
  assert.equal(afterSell.creator, true);
  assert.equal(afterSell.launchFeePayer, false);
  assert.equal(afterSell.observedNetTokenChange, 75);
  const summary = summarizeWalletCohorts({ dev: afterSell });
  assert.equal(summary.creatorBuyQuote, 2);
  assert.equal(summary.creatorSellQuote, 1);
});

test("marks very early buys and same-launch-slot entries as candidates, not proof", () => {
  const profile = updateWalletProfile(undefined, { wallet: "sniper", side: "buy", tokenAmount: 1, quoteAmount: 0.1 }, {
    observedAt: 3_000, slot: 500, launchSlot: 500, launchAt: 0, launchFeePayer: "payer", creator: "dev"
  });
  assert.equal(profile.sniperCandidate, true);
  assert.equal(profile.bundleCandidate, true);
  assert.equal(profile.botScore, 0);
});

test("bot score requires multiple behavioral signals", () => {
  let profile;
  for (let i = 0; i < 4; i++) profile = updateWalletProfile(profile, {
    wallet: "bot", side: i === 3 ? "sell" : "buy", tokenAmount: 1, quoteAmount: 0.01
  }, { observedAt: 1000 + i * 1000, slot: 700 + i, launchSlot: 699, launchAt: 0, launchFeePayer: null, creator: null });
  assert.ok(profile);
  assert.ok(profile.botScore >= 50);
  assert.ok(profile.botSignals.includes("four_or_more_transactions_in_30_seconds"));
  assert.ok(profile.botSignals.includes("buy_and_sell_within_30_seconds"));
});

test("extracts direct system transfer funders from parsed top-level and inner instructions", () => {
  const tx = {
    transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "funderA", destination: "wallet", lamports: 100 } } }] } },
    meta: { innerInstructions: [{ instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "funderB", destination: "wallet", lamports: 50 } } }] }] }
  };
  assert.deepEqual(extractFundingSources(tx, "wallet"), ["funderA", "funderB"]);
});

test("deduplicates transaction counts and computes observed inventory PnL", () => {
  const base = { observedAt: 1_000, slot: 10, launchSlot: 10, launchAt: 0, launchFeePayer: null, creator: "dev" };
  let profile = updateWalletProfile(undefined, { wallet: "dev", side: "buy", tokenAmount: 100, quoteAmount: 2, confidence: "high" }, { ...base, signature: "sig1" });
  profile = updateWalletProfile(profile, { wallet: "dev", side: "sell", tokenAmount: 25, quoteAmount: 1, confidence: "high" }, { ...base, observedAt: 2_000, slot: 11, signature: "sig2" });
  assert.equal(profile.transactionCount, 2);
  assert.equal(profile.exactTransactionCount, 2);
  assert.equal(profile.trackedTokenBalance, 75);
  assert.equal(profile.realizedPnlQuote, 0.5);
  assert.equal(profile.sellExceedsObservedBuys, false);
  const summary = summarizeWalletCohorts({ dev: profile });
  assert.equal(summary.creatorRealizedPnlQuote, 0.5);
});

test("does not claim realized PnL when observed sells exceed observed buys", () => {
  let profile = updateWalletProfile(undefined, { wallet: "wallet", side: "sell", tokenAmount: 10, quoteAmount: 1, confidence: "high" }, {
    observedAt: 1_000, slot: 20, launchSlot: 20, launchAt: 0, launchFeePayer: null, creator: null
  });
  assert.equal(profile.realizedPnlQuote, null);
  assert.equal(profile.sellExceedsObservedBuys, true);
});

test("aggregates multiple swap events in one signature but counts one wallet transaction", () => {
  const context = { observedAt: 20_000, slot: 900, launchSlot: 899, launchAt: 0, launchFeePayer: null, creator: null, signature: "same-signature" };
  let profile = updateWalletProfile(undefined, { wallet: "trader", side: "buy", tokenAmount: 10, quoteAmount: 1, confidence: "high" }, context);
  profile = updateWalletProfile(profile, { wallet: "trader", side: "buy", tokenAmount: 20, quoteAmount: 2, confidence: "high" }, context);
  assert.equal(profile.transactionCount, 1);
  assert.equal(profile.buyCount, 2);
  assert.equal(profile.tokenBought, 30);
  assert.equal(profile.exactQuoteSpent, 3);
});
