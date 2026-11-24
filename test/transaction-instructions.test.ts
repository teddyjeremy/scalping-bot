import test from "node:test";
import assert from "node:assert/strict";
import { getTopLevelInstructions } from "../src/transaction-instructions.js";

test("launch candidate scanning receives top-level instructions only", () => {
  const topLevel = [{ programId: "pump", data: "create", accounts: ["mint"] }];
  const inner = [{ programId: "pump", data: "create", accounts: ["false-mint"] }];
  const tx = {
    transaction: { message: { instructions: topLevel } },
    meta: { innerInstructions: [{ index: 0, instructions: inner }] }
  };
  assert.deepEqual(getTopLevelInstructions(tx.transaction.message), topLevel);
  assert.equal(getTopLevelInstructions(tx.transaction.message).some(i => i.accounts?.[0] === "false-mint"), false);
});
