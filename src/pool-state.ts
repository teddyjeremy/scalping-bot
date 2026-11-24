import { PublicKey } from "@solana/web3.js";
import { decodeBase58 } from "./pump-instructions.js";

const LAUNCHLAB_POOL_STATE_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const PUMP_SWAP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

function readKey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

export type LaunchLabPoolState = {
  status: number;
  statusName: "funding" | "migrating" | "trading" | "unknown";
  baseDecimals: number;
  quoteDecimals: number;
  migrateType: number;
  migrateTypeName: "amm" | "cpmm" | "unknown";
  supplyRaw: bigint;
  totalBaseSellRaw: bigint;
  virtualBaseRaw: bigint;
  virtualQuoteRaw: bigint;
  realBaseRaw: bigint;
  realQuoteRaw: bigint;
  totalQuoteFundRaisingRaw: bigint;
  quoteProtocolFeeRaw: bigint;
  platformFeeRaw: bigint;
  migrateFeeRaw: bigint;
  globalConfig: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  creator: string;
  tokenProgramFlag: number;
  ammCreatorFeeOn: number;
};

export function decodeLaunchLabPoolState(data: Buffer): LaunchLabPoolState | null {
  // Raydium LaunchLab PoolState layout from the published raydium-cpi states.rs.
  if (data.length < 429 || !data.subarray(0, 8).equals(LAUNCHLAB_POOL_STATE_DISCRIMINATOR)) return null;
  const status = data[17];
  const migrateType = data[20];
  return {
    status,
    statusName: status === 0 ? "funding" : status === 1 ? "migrating" : status === 2 ? "trading" : "unknown",
    baseDecimals: data[18],
    quoteDecimals: data[19],
    migrateType,
    migrateTypeName: migrateType === 0 ? "amm" : migrateType === 1 ? "cpmm" : "unknown",
    supplyRaw: data.readBigUInt64LE(21),
    totalBaseSellRaw: data.readBigUInt64LE(29),
    virtualBaseRaw: data.readBigUInt64LE(37),
    virtualQuoteRaw: data.readBigUInt64LE(45),
    realBaseRaw: data.readBigUInt64LE(53),
    realQuoteRaw: data.readBigUInt64LE(61),
    totalQuoteFundRaisingRaw: data.readBigUInt64LE(69),
    quoteProtocolFeeRaw: data.readBigUInt64LE(77),
    platformFeeRaw: data.readBigUInt64LE(85),
    migrateFeeRaw: data.readBigUInt64LE(93),
    globalConfig: readKey(data, 141),
    platformConfig: readKey(data, 173),
    baseMint: readKey(data, 205),
    quoteMint: readKey(data, 237),
    baseVault: readKey(data, 269),
    quoteVault: readKey(data, 301),
    creator: readKey(data, 333),
    tokenProgramFlag: data[365],
    ammCreatorFeeOn: data[366]
  };
};

export type PumpSwapPoolState = {
  bump: number;
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  baseVault: string;
  quoteVault: string;
  lpSupplyRaw: bigint;
  coinCreator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  virtualQuoteReservesRaw: bigint;
};

export function decodePumpSwapPoolState(data: Buffer): PumpSwapPoolState | null {
  // Pump AMM Pool layout, including the appended i128 virtual quote reserves.
  if (data.length < 261 || !data.subarray(0, 8).equals(PUMP_SWAP_POOL_DISCRIMINATOR)) return null;
  return {
    bump: data[8],
    index: data.readUInt16LE(9),
    creator: readKey(data, 11),
    baseMint: readKey(data, 43),
    quoteMint: readKey(data, 75),
    lpMint: readKey(data, 107),
    baseVault: readKey(data, 139),
    quoteVault: readKey(data, 171),
    lpSupplyRaw: data.readBigUInt64LE(203),
    coinCreator: readKey(data, 211),
    isMayhemMode: data[243] === 1,
    isCashbackCoin: data[244] === 1,
    virtualQuoteReservesRaw: (data.readBigInt64LE(253) << 64n) + data.readBigUInt64LE(245)
  };
}

/** SPL Token and Token-2022 keep mint, owner and amount in the same base account prefix. */
export function decodeTokenAccountAmount(data: Buffer, expectedMint: string): bigint | null {
  if (data.length < 72) return null;
  if (readKey(data, 0) !== expectedMint) return null;
  return data.readBigUInt64LE(64);
}

const PUMP_SWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_SWAP_BUY_DISCRIMINATORS = new Set(["66063d1201daebea", "b817ee6167c5d33d"]);
const PUMP_SWAP_SELL_DISCRIMINATORS = new Set(["33e685a4017f83ad", "5df6823ce7e940b2"]);

export function findPumpSwapPoolFromInstructions(
  instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>,
  mint: string
): { pool: string; quoteMint: string; side: "buy" | "sell" } | null {
  for (const instruction of instructions) {
    if (String(instruction.programId ?? "") !== PUMP_SWAP_PROGRAM_ID) continue;
    if (typeof instruction.data !== "string" || !Array.isArray(instruction.accounts) || instruction.accounts.length < 5) continue;
    let bytes: Uint8Array;
    try { bytes = decodeBase58(instruction.data); } catch { continue; }
    if (bytes.length < 8) continue;
    const discriminator = [...bytes.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (!PUMP_SWAP_BUY_DISCRIMINATORS.has(discriminator) && !PUMP_SWAP_SELL_DISCRIMINATORS.has(discriminator)) continue;
    const pool = String(instruction.accounts[0] ?? "");
    const baseMint = String(instruction.accounts[3] ?? "");
    const quoteMint = String(instruction.accounts[4] ?? "");
    if (!pool || baseMint !== mint || !quoteMint) continue;
    return { pool, quoteMint, side: PUMP_SWAP_BUY_DISCRIMINATORS.has(discriminator) ? "buy" : "sell" };
  }
  return null;
}
