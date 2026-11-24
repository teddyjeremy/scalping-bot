const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]));

export const PUMP_CREATE_DISCRIMINATORS = new Map<string, "create" | "create_v2">([
  ["181ec828051c0777", "create"],
  ["d6904cec5f8b31b4", "create_v2"]
]);

export function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit == null) throw new Error("Invalid base58 instruction data");
    number = number * 58n + digit;
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes++;
  return Uint8Array.from([...Array(leadingZeroes).fill(0), ...bytes]);
}

export type PumpCreateInstruction = { mint: string; creator: string | null; kind: "create" | "create_v2" };

export function findPumpCreateInstructions(
  instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>,
  pumpProgramId: string
): PumpCreateInstruction[] {
  const found: PumpCreateInstruction[] = [];
  for (const instruction of instructions) {
    if (String(instruction.programId ?? "") !== pumpProgramId) continue;
    if (typeof instruction.data !== "string" || !Array.isArray(instruction.accounts)) continue;
    let decoded: Uint8Array;
    try { decoded = decodeBase58(instruction.data); } catch { continue; }
    if (decoded.length < 8) continue;
    const discriminator = [...decoded.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const kind = PUMP_CREATE_DISCRIMINATORS.get(discriminator);
    if (!kind) continue;
    const mintAccount = instruction.accounts[0];
    if (!mintAccount) continue;
    const creator = instruction.accounts[5] ? String(instruction.accounts[5]) : null;
    found.push({ mint: String(mintAccount), creator, kind });
  }
  return found;
}
