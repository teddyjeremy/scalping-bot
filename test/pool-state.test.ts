import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { decodeLaunchLabPoolState, decodePumpSwapPoolState, decodeTokenAccountAmount } from "../src/pool-state.js";

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
  data.writeBigInt128LE(25n, 245);
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
