import { decodeBase58 } from "./pump-instructions.js";

const LAUNCHLAB_INITIALIZERS = new Map<string, "initialize" | "initialize_v2" | "initialize_with_token_2022">([
  ["afaf6d1f0d989bed", "initialize"],
  ["4399af27da102620", "initialize_v2"],
  ["25be7ede2c9aab11", "initialize_with_token_2022"]
]);

export type StonkFunLaunchInstruction = {
  payer: string; creator: string; mint: string;
  quoteMint: string;
  pool: string;
  platformConfig: string;
  kind: "initialize" | "initialize_v2" | "initialize_with_token_2022";
};

export function findStonkFunLaunchInstructions(
  instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>,
  launchLabProgramId: string,
  stonkFunPlatformConfigs: Set<string>
): StonkFunLaunchInstruction[] {
  const found: StonkFunLaunchInstruction[] = [];
  for (const instruction of instructions) {
    if (String(instruction.programId ?? "") !== launchLabProgramId) continue;
    if (typeof instruction.data !== "string" || !Array.isArray(instruction.accounts)) continue;
    let decoded: Uint8Array;
    try { decoded = decodeBase58(instruction.data); } catch { continue; }
    if (decoded.length < 8 || instruction.accounts.length < 8) continue;
    const discriminator = [...decoded.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const kind = LAUNCHLAB_INITIALIZERS.get(discriminator);
    if (!kind) continue;
    const platformConfig = String(instruction.accounts[3] ?? "");
    if (!stonkFunPlatformConfigs.has(platformConfig)) continue;
    const payer = String(instruction.accounts[0] ?? "");
    const creator = String(instruction.accounts[1] ?? "");
    const pool = String(instruction.accounts[5] ?? "");
    const mint = String(instruction.accounts[6] ?? "");
    const quoteMint = String(instruction.accounts[7] ?? "");
    if (!payer || !creator || !pool || !mint || !quoteMint) continue;
    found.push({ payer, creator, mint, quoteMint, pool, platformConfig, kind });
  }
  return found;
}
