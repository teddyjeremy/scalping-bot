import test from "node:test";
import assert from "node:assert/strict";
import { findStonkFunLaunchInstructions } from "../src/launchlab-instructions.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let result = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    result = alphabet[remainder] + result;
    value /= 58n;
  }
  return result;
}

const launchLab = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const stonkConfig = "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7";
const mint = "Mint111111111111111111111111111111111111111";
const quote = "Quote1111111111111111111111111111111111111";
const pool = "Pool11111111111111111111111111111111111111";

test("detects StonkFun initialize_with_token_2022 by program, discriminator and platform config", () => {
  const data = encodeBase58(Uint8Array.from([37, 190, 126, 222, 44, 154, 171, 17, 0]));
  const result = findStonkFunLaunchInstructions([
    { programId: launchLab, data, accounts: ["payer", "creator", "global", stonkConfig, "authority", pool, mint, quote] },
    { programId: launchLab, data, accounts: ["payer", "creator", "global", "other-config", "authority", pool, "other-mint", quote] },
    { programId: "another-program", data, accounts: ["payer", "creator", "global", stonkConfig, "authority", pool, "wrong-mint", quote] }
  ], launchLab, new Set([stonkConfig]));
  assert.deepEqual(result, [{ payer: "payer", creator: "creator", mint, quoteMint: quote, pool, platformConfig: stonkConfig, kind: "initialize_with_token_2022" }]);
});
