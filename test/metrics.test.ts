import test from "node:test";
import assert from "node:assert/strict";
import { deriveTradeObservations } from "../src/metrics.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";

const base = "BaseMint111111111111111111111111111111111111";
const quote = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const amount = (value: string) => ({ amount: value, decimals: 6, uiAmount: Number(value) / 1_000_000, uiAmountString: String(Number(value) / 1_000_000) });
const balance = (mint: string, owner: string, value: string) => ({
  accountIndex: owner === "buyer" ? 1 : 2, mint, owner,
  uiTokenAmount: amount(value)
});

test("counts only the signed wallet side, not the pool's opposite reserve delta", () => {
  const tx = {
    transaction: {
      signatures: ["signature"],
      message: {
        accountKeys: [
          { pubkey: "payer", signer: true, writable: true },
          { pubkey: "buyer", signer: true, writable: true },
          { pubkey: "pool", signer: false, writable: true }
        ]
      }
    },
    meta: {
      err: null, fee: 5000,
      preBalances: [1_000_000_000, 1_000_000_000, 1_000_000_000],
      postBalances: [999_995_000, 1_000_000_000, 1_000_000_000],
      preTokenBalances: [
        balance(base, "buyer", "0"),
        balance(base, "pool", "100000000"),
        balance(quote, "buyer", "100000000"),
        balance(quote, "pool", "0")
      ],
      postTokenBalances: [
        balance(base, "buyer", "100000000"),
        balance(base, "pool", "0"),
        balance(quote, "buyer", "90000000"),
        balance(quote, "pool", "10000000")
      ]
    }
  } as unknown as ParsedTransactionWithMeta;
  const result = deriveTradeObservations(tx, base, 150, quote);
  assert.equal(result.length, 1);
  assert.equal(result[0].wallet, "buyer");
  assert.equal(result[0].side, "buy");
  assert.equal(result[0].quoteAmount, 10);
  assert.equal(result[0].priceQuote, 0.1);
});
