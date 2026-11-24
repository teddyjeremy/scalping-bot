import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { decodeLaunchLabPoolState, decodePumpSwapPoolState, decodeRaydiumCpmmPoolState, decodeTokenAccountAmount, findLaunchLabCpmmMigration, findPumpSwapPoolFromInstructions } from "../src/pool-state.js";

const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();

test("decodes the documented LaunchLab PoolState offsets", () => {
  const data = Buffer.alloc(429);
  Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]).copy(data, 0);
  data[17] = 2; data[18] = 6; data[19] = 9; data[20] = 1;
  data.writeBigUInt64LE(123n, 21);
  data.writeBigUInt64LE(456n, 53);
  Buffer.alloc(32, 1).copy(data, 205);
  Buffer.alloc(32, 2).copy(data, 237);
  Buffer.alloc(32, 3).copy(data, 269);
  Buffer.alloc(32, 4).copy(data, 301);
  const decoded = decodeLaunchLabPoolState(data);
  assert.ok(decoded);
  assert.equal(decoded.statusName, "trading");
  assert.equal(decoded.migrateTypeName, "cpmm");
  assert.equal(decoded.supplyRaw, 123n);
  assert.equal(decoded.realBaseRaw, 456n);
  assert.equal(decoded.baseMint, key(1));
  assert.equal(decoded.quoteMint, key(2));
  assert.equal(decoded.baseVault, key(3));
  assert.equal(decoded.quoteVault, key(4));
});

test("decodes PumpSwap pool reserves metadata and appended virtual quote reserve", () => {
  const data = Buffer.alloc(261);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(data, 0);
  data[8] = 254; data.writeUInt16LE(0, 9);
  for (const [offset, byte] of [[11, 1], [43, 2], [75, 3], [107, 4], [139, 5], [171, 6], [211, 7]] as const) Buffer.alloc(32, byte).copy(data, offset);
  data.writeBigUInt64LE(999n, 203);
  data[243] = 1; data[244] = 0;
  data.writeBigUInt64LE(25n, 245); data.writeBigInt64LE(0n, 253);
  const decoded = decodePumpSwapPoolState(data);
  assert.ok(decoded);
  assert.equal(decoded.index, 0);
  assert.equal(decoded.baseMint, key(2));
  assert.equal(decoded.quoteMint, key(3));
  assert.equal(decoded.baseVault, key(5));
  assert.equal(decoded.quoteVault, key(6));
  assert.equal(decoded.lpSupplyRaw, 999n);
  assert.equal(decoded.isMayhemMode, true);
  assert.equal(decoded.virtualQuoteReservesRaw, 25n);
});

test("reads SPL token account amount only when its mint matches", () => {
  const data = Buffer.alloc(165);
  Buffer.alloc(32, 8).copy(data, 0);
  data.writeBigUInt64LE(123456n, 64);
  assert.equal(decodeTokenAccountAmount(data, key(8)), 123456n);
  assert.equal(decodeTokenAccountAmount(data, key(9)), null);
});

test("discovers a PumpSwap pool only from a matching top-level buy or sell instruction", () => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encode = (bytes: Uint8Array) => {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    let output = "";
    while (value > 0n) { const digit = Number(value % 58n); output = alphabet[digit] + output; value /= 58n; }
    return output;
  };
  const buy = encode(Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234, 1]));
  const sell = encode(Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173, 1]));
  const programId = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const result = findPumpSwapPoolFromInstructions([
    { programId, data: buy, accounts: ["pool", "user", "config", "mint", "quote"] }
  ], "mint");
  assert.deepEqual(result, { pool: "pool", quoteMint: "quote", side: "buy" });
  assert.equal(findPumpSwapPoolFromInstructions([
    { programId, data: sell, accounts: ["pool2", "user", "config", "other-mint", "quote"] }
  ], "mint"), null);
});

test("decodes Raydium CPMM pool vaults, mints, fee counters and creator settings", () => {
  const data = Buffer.alloc(637);
  Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]).copy(data, 0);
  for (const [offset, byte] of [[40, 1], [72, 2], [104, 3], [136, 4], [168, 5], [200, 6]] as const) Buffer.alloc(32, byte).copy(data, offset);
  data[329] = 3; data[331] = 9; data[332] = 6;
  data.writeBigUInt64LE(999n, 333);
  data.writeBigUInt64LE(11n, 341); data.writeBigUInt64LE(12n, 349);
  data.writeBigUInt64LE(13n, 357); data.writeBigUInt64LE(14n, 365);
  data.writeBigUInt64LE(1234n, 373); data[389] = 2; data[390] = 1;
  data.writeBigUInt64LE(15n, 397); data.writeBigUInt64LE(16n, 405);
  const decoded = decodeRaydiumCpmmPoolState(data);
  assert.ok(decoded);
  assert.equal(decoded.poolCreator, key(1));
  assert.equal(decoded.token0Vault, key(2));
  assert.equal(decoded.token1Vault, key(3));
  assert.equal(decoded.lpMint, key(4));
  assert.equal(decoded.token0Mint, key(5));
  assert.equal(decoded.token1Mint, key(6));
  assert.equal(decoded.token0Decimals, 9);
  assert.equal(decoded.token1Decimals, 6);
  assert.equal(decoded.lpSupplyRaw, 999n);
  assert.equal(decoded.status, 3);
  assert.equal(decoded.enableCreatorFee, true);
  assert.equal(decoded.creatorFeesToken1Raw, 16n);
});

test("finds LaunchLab migration to CPMM from the migration instruction accounts", () => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encode = (bytes: Uint8Array) => {
    let value = 0n; for (const byte of bytes) value = (value << 8n) + BigInt(byte);
    let output = ""; while (value > 0n) { output = alphabet[Number(value % 58n)] + output; value /= 58n; }
    return output;
  };
  const data = encode(Uint8Array.from([136, 92, 200, 103, 28, 218, 144, 140]));
  const result = findLaunchLabCpmmMigration([{
    programId: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    data, accounts: ["payer", "mint", "quote", "platform", "cpmm-program", "pool", "authority", "lp-mint", "base-vault", "quote-vault", "config", "fee", "observation", "lock-program", "lock-authority", "lock-lp-vault"]
  }], "mint");
  assert.deepEqual(result, { pool: "pool", quoteMint: "quote", lockLpVault: "lock-lp-vault" });
});
