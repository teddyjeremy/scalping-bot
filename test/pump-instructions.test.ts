import test from "node:test";
import assert from "node:assert/strict";
import { decodeBase58, findPumpCreateInstructions } from "../src/pump-instructions.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = ALPHABET[remainder] + encoded;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + (encoded || (zeros ? "" : "1"));
}

const pump = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const mint = "TokenMintExample111111111111111111111111111";

test("base58 preserves leading zero bytes", () => {
  assert.deepEqual([...decodeBase58("1112")], [0, 0, 0, 1]);
});

test("recognizes only the official create_v2 discriminator", () => {
  const data = encodeBase58(Uint8Array.from([214, 144, 76, 236, 95, 139, 49, 180, 0]));
  const result = findPumpCreateInstructions([
    { programId: pump, data, accounts: [mint, "authority"] },
    { programId: pump, data: encodeBase58(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), accounts: ["not-a-mint"] },
    { programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", data, accounts: ["not-a-mint"] }
  ], pump);
  assert.deepEqual(result, [{ mint, creator: null, kind: "create_v2" }]);
});

test("recognizes the legacy create discriminator", () => {
  const data = encodeBase58(Uint8Array.from([24, 30, 200, 40, 5, 28, 7, 119, 0]));
  assert.deepEqual(
    findPumpCreateInstructions([{ programId: pump, data, accounts: [mint] }], pump),
    [{ mint, creator: null, kind: "create" }]
  );
});

test("extracts the legacy create creator from account index 7", () => {
  const data = encodeBase58(Uint8Array.from([24, 30, 200, 40, 5, 28, 7, 119, 0]));
  const creator = "Creator111111111111111111111111111111111";
  const result = findPumpCreateInstructions([
    { programId: pump, data, accounts: [mint, "authority", "curve", "associated-curve", "global", "metadata-program", "metadata", creator] }
  ], pump);
  assert.deepEqual(result, [{ mint, creator, kind: "create" }]);
});

test("extracts the create_v2 creator from account index 5", () => {
  const data = encodeBase58(Uint8Array.from([214, 144, 76, 236, 95, 139, 49, 180, 0]));
  const creator = "Creator111111111111111111111111111111111";
  const result = findPumpCreateInstructions([
    { programId: pump, data, accounts: [mint, "authority", "curve", "associated-curve", "global", creator] }
  ], pump);
  assert.deepEqual(result, [{ mint, creator, kind: "create_v2" }]);
});

test("does not mistake associated-token Create logs or Pump buys for launch instructions", () => {
  const buyData = encodeBase58(Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]));
  assert.deepEqual(
    findPumpCreateInstructions([{ programId: pump, data: buyData, accounts: [mint] }], pump),
    []
  );
});

import { normalizeTransactionInstructions } from "../src/transaction-instructions.js";

test("resolves compiled program and account indexes to public keys", () => {
  const result = normalizeTransactionInstructions({
    accountKeys: ["Mint111", "PumpProgram111", "Creator111"],
    instructions: [{ programIdIndex: 1, accounts: [0, 2], data: "encoded-data" }]
  });
  assert.deepEqual(result, [{ programId: "PumpProgram111", accounts: ["Mint111", "Creator111"], data: "encoded-data" }]);
});

test("normalizes parsed instructions and compiled inner instructions consistently", () => {
  const result = normalizeTransactionInstructions(
    {
      accountKeys: ["Mint111", "PumpProgram111", "Creator111"],
      instructions: [{ programId: "PumpProgram111", accounts: ["Mint111", "Creator111"], data: "top-level" }]
    },
    [{ instructions: [{ programIdIndex: 1, accounts: [0, 2], data: "inner" }] }]
  );
  assert.deepEqual(result, [
    { programId: "PumpProgram111", accounts: ["Mint111", "Creator111"], data: "top-level" },
    { programId: "PumpProgram111", accounts: ["Mint111", "Creator111"], data: "inner" }
  ]);
});
