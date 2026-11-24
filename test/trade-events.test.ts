import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { decodeProgramTradeEvents } from "../src/trade-events.js";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const chunks: Buffer[] = [];
const u8 = (n: number) => chunks.push(Buffer.from([n]));
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); chunks.push(b); };
const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); chunks.push(b); };
const i64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); chunks.push(b); };
const i128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigInt64LE(n >> 64n, 8); chunks.push(b); };
const pubkey = (n: number) => chunks.push(new PublicKey(key(n)).toBuffer());
const str = (s: string) => { const b = Buffer.from(s); u32(b.length); chunks.push(b); };
const data = () => Buffer.concat(chunks);

test("decodes current Pump TradeEvent with quote amount and fee components", () => {
  chunks.length = 0;
  chunks.push(Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]));
  pubkey(1); u64(12_000_000_000n); u64(50_000_000n); u8(1); pubkey(2); i64(1_800_000_000n);
  u64(100); u64(200); u64(300); u64(400); pubkey(3); u64(95); u64(10); pubkey(4); u64(30); u64(3);
  u8(1); u64(0); u64(0); u64(0); i64(1_800_000_000n); str("buy"); u8(0);
  u64(0); u64(0); u64(0); u64(0); u32(0); pubkey(5); u64(11_000_000_000n);
  u64(500); u64(400); u64(0); u64(0); u64(0);
  const result = decodeProgramTradeEvents([
    "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
    "Program data: " + data().toString("base64"),
    "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success"
  ], key(1));
  assert.equal(result.length, 1);
  assert.equal(result[0].venue, "pumpfun");
  assert.equal(result[0].user, key(2));
  assert.equal(result[0].side, "buy");
  assert.equal(result[0].quoteAmountRaw, 11_000_000_000n);
  assert.equal(result[0].protocolFeeRaw, 10n);
  assert.equal(result[0].creatorFeeRaw, 3n);
  assert.equal(result[0].instructionName, "buy");
});

test("decodes PumpSwap buy and sell events with user quote amounts", () => {
  const makeBuy = () => {
    chunks.length = 0;
    chunks.push(Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]));
    i64(1_800_000_000n); u64(20_000_000n); u64(5); u64(0); u64(0); u64(980_000_000n); u64(10_050_000_000n);
    u64(9_000_000_000n); u64(20); u64(2); u64(30); u64(3); u64(9_100_000_000n); u64(9_050_000_000n);
    for (let i = 1; i <= 7; i++) pubkey(i);
    u64(25); u64(4); u8(1); u64(1); u64(2); u64(3); i64(1_800_000_000n); u64(5); str("buy");
    u64(1); u64(1); u64(2); u64(2); i128(30n); u8(1); u64(1000); u64(0); u64(0); u64(0);
    return data();
  };
  const makeSell = () => {
    chunks.length = 0;
    chunks.push(Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]));
    i64(1_800_000_001n); u64(10_000_000n); u64(5); u64(0); u64(0); u64(1_020_000_000n); u64(9_050_000_000n);
    u64(4_000_000_000n); u64(20); u64(2); u64(30); u64(3); u64(3_900_000_000n); u64(3_950_000_000n);
    for (let i = 1; i <= 7; i++) pubkey(i);
    u64(25); u64(4); u64(1); u64(1); u64(2); u64(2); i128(30n); u8(1); u64(1000); u64(0); u64(0); u64(0);
    return data();
  };
  const logs = [
    "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]",
    "Program data: " + makeBuy().toString("base64"),
    "Program data: " + makeSell().toString("base64"),
    "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success"
  ];
  const result = decodeProgramTradeEvents(logs, "target-mint");
  assert.equal(result.length, 2);
  assert.equal(result[0].venue, "pumpswap");
  assert.equal(result[0].side, "buy");
  assert.equal(result[0].quoteAmountRaw, 9_050_000_000n);
  assert.equal(result[0].preTradeBaseReserveRaw, 1_000_000_000n);
  assert.equal(result[0].preTradeQuoteReserveRaw, 1_000_000_000n);
  assert.equal(result[1].side, "sell");
  assert.equal(result[1].quoteAmountRaw, 3_950_000_000n);
});

test("decodes StonkFun LaunchLab trade events using matching swap instruction accounts", () => {
  chunks.length = 0;
  chunks.push(Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]));
  pubkey(1);
  for (let i = 1; i <= 7; i++) u64(i);
  u64(1_000_000_000n); u64(100_000_000n);
  u64(10_000n); u64(20_000n); u64(30_000n); u64(40_000n);
  u8(0); u8(0); u8(1);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encode58 = (bytes: Uint8Array) => {
    let value = 0n; for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    let out = ""; while (value > 0n) { const d = Number(value % 58n); out = alphabet[d] + out; value /= 58n; }
    return out;
  };
  const instructionData = encode58(Uint8Array.from([250, 234, 13, 123, 213, 156, 19, 236]));
  const mint = key(9), quoteMint = key(10), pool = key(1), user = key(8);
  const program = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
  const instructions = [{
    programId: program, data: instructionData,
    accounts: [user, key(2), key(3), key(4), pool, key(5), key(6), key(7), key(8), mint, quoteMint]
  }];
  const result = decodeProgramTradeEvents([
    "Program " + program + " invoke [1]",
    "Program data: " + data().toString("base64"),
    "Program " + program + " success"
  ], mint, instructions);
  assert.equal(result.length, 1);
  assert.equal(result[0].venue, "stonkfun");
  assert.equal(result[0].side, "buy");
  assert.equal(result[0].user, user);
  assert.equal(result[0].quoteMint, quoteMint);
  assert.equal(result[0].quoteAmountRaw, 1_000_000_000n);
  assert.equal(result[0].tokenAmountRaw, 100_000_000n);
  assert.equal(result[0].protocolFeeRaw, 10_000n);
  assert.equal(result[0].platformFeeRaw, 20_000n);
  assert.equal(result[0].creatorFeeRaw, 30_000n);
  assert.equal(result[0].shareFeeRaw, 40_000n);
  assert.equal(result[0].preTradeBaseReserveRaw, 4n);
  assert.equal(result[0].preTradeQuoteReserveRaw, 5n);
});
