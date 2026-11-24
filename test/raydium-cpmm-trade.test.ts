import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { decodeProgramTradeEvents } from "../src/trade-events.js";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const parts: Buffer[] = [];
const u8 = (v: number) => parts.push(Buffer.from([v]));
const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
const pub = (v: number) => parts.push(new PublicKey(key(v)).toBuffer());
const b58 = (bytes: number[]) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const x of bytes) n = (n << 8n) + BigInt(x);
  let out = ""; while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  return out;
};

test("decodes Raydium CPMM user-side buy amount and transfer fees", () => {
  parts.length = 0;
  parts.push(Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]));
  pub(1); u64(1000); u64(2000);
  u64(1_000_000); u64(500_000);
  u64(100); u64(50); u8(1);
  pub(2); pub(9); u64(1000); u64(200); u8(1);
  const mint = key(9), quote = key(2), pool = key(1), user = key(8);
  const program = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  const ixData = b58([143, 190, 90, 218, 196, 30, 51, 222]);
  const instructions = [{ programId: program, data: ixData, accounts: [user, key(3), key(4), pool, key(5), key(6), key(7), key(8), key(10), key(11), quote, mint] }];
  const result = decodeProgramTradeEvents([
    "Program " + program + " invoke [1]",
    "Program data: " + Buffer.concat(parts).toString("base64"),
    "Program " + program + " success"
  ], mint, instructions);
  assert.equal(result.length, 1);
  assert.equal(result[0].venue, "raydium_cpmm");
  assert.equal(result[0].side, "buy");
  assert.equal(result[0].user, user);
  assert.equal(result[0].quoteMint, quote);
  assert.equal(result[0].tokenAmountRaw, 499_950n);
  assert.equal(result[0].quoteAmountRaw, 1_000_100n);
  assert.equal(result[0].tradeFeeRaw, 1000n);
  assert.equal(result[0].creatorFeeRaw, 200n);
});
