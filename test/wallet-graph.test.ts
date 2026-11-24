import test from "node:test";
import assert from "node:assert/strict";
import { reconstructCrossTokenWalletGraph } from "../src/wallet-graph.js";

test("reconstructs cross-token wallet activity, funding groups and repeated co-entry pairs", () => {
  const report = reconstructCrossTokenWalletGraph([
    { kind: "wallet_activity", mint: "mintA", wallet: "wallet1", signature: "sig1", slot: 10, side: "buy", tokenAmount: 100, quoteAmount: 1, quoteMint: "SOL", isCreator: true, sniperCandidate: true, botScore: 60, botSignals: ["rapid"], fundingSources: ["funder"] },
    { kind: "wallet_activity", mint: "mintA", wallet: "wallet2", signature: "sig2", slot: 10, side: "buy", tokenAmount: 50, quoteAmount: 0.5, quoteMint: "SOL", bundleCandidate: true, fundingSources: ["funder"] },
    { kind: "wallet_activity", mint: "mintB", wallet: "wallet1", signature: "sig3", slot: 20, side: "sell", tokenAmount: 20, quoteAmount: 0.4, quoteMint: "SOL", sniperCandidate: true },
    { kind: "wallet_activity", mint: "mintB", wallet: "wallet2", signature: "sig4", slot: 20, side: "buy", tokenAmount: 40, quoteAmount: 0.3, quoteMint: "USDC", bundleCandidate: true },
    { kind: "token_activity", mint: "mintC", signature: "ignored" }
  ]);
  assert.equal(report.walletCount, 2);
  assert.equal(report.crossTokenWallets.length, 2);
  const wallet1 = report.wallets.find(wallet => wallet.wallet === "wallet1");
  assert.ok(wallet1);
  assert.equal(wallet1.uniqueTokenCount, 2);
  assert.equal(wallet1.uniqueTransactionCount, 2);
  assert.equal(wallet1.sniperCandidateMintCount, 2);
  assert.deepEqual(wallet1.quoteSpentByMint, { SOL: 1 });
  assert.deepEqual(wallet1.quoteReceivedByMint, { SOL: 0.4 });
  assert.equal(report.sharedFundingSourceGroups.length, 1);
  assert.equal(report.repeatedSameLaunchSlotCoEntryPairs[0].sharedLaunchCount, 2);
  assert.equal(report.ignoredEvents, 1);
});

test("keeps quote asset totals separate and ignores duplicate activity rows", () => {
  const event = { kind: "wallet_activity", mint: "mintA", wallet: "wallet", signature: "sig", side: "buy", tokenAmount: 1, quoteAmount: 1, quoteMint: "SOL" };
  const report = reconstructCrossTokenWalletGraph([event, event, { ...event, mint: "mintB", signature: "sig2", quoteMint: "USDC" }]);
  const wallet = report.wallets[0];
  assert.equal(wallet.eventCount, 2);
  assert.deepEqual(wallet.quoteSpentByMint, { SOL: 1, USDC: 1 });
});
