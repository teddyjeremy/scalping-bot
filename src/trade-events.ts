import { PublicKey } from "@solana/web3.js";
import { decodeBase58 } from "./pump-instructions.js";
import { decodeRaydiumCpmmTradeEvent } from "./raydium-cpmm-trade.js";\nimport { findPumpSwapPoolFromInstructions } from "./pool-state.js";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const PUMP_TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const PUMP_AMM_BUY = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const PUMP_AMM_SELL = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const LAUNCHLAB_TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const ZERO_KEY = new PublicKey(Buffer.alloc(32)).toBase58();
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAUNCHLAB_SWAPS = new Map<string, "buy" | "sell">([
  ["faea0d7bd59c13ec", "buy"], ["18d3742869039938", "buy"],
  ["9527de9bd37c981a", "sell"], ["5fc8472208090ba6", "sell"]
]);

class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  ensure(length: number) { if (this.offset + length > this.data.length) throw new Error("Truncated event"); }
  u8() { this.ensure(1); return this.data[this.offset++]; }
  bool() { const value = this.u8(); if (value > 1) throw new Error("Invalid Borsh bool"); return value === 1; }
  u16() { this.ensure(2); const value = this.data.readUInt16LE(this.offset); this.offset += 2; return value; }
  u32() { this.ensure(4); const value = this.data.readUInt32LE(this.offset); this.offset += 4; return value; }
  u64() { this.ensure(8); const value = this.data.readBigUInt64LE(this.offset); this.offset += 8; return value; }
  i64() { this.ensure(8); const value = this.data.readBigInt64LE(this.offset); this.offset += 8; return value; }
  i128() { this.ensure(16); const high = this.data.readBigInt64LE(this.offset + 8); const low = this.data.readBigUInt64LE(this.offset); this.offset += 16; return (high << 64n) + low; }
  key() { this.ensure(32); const value = new PublicKey(this.data.subarray(this.offset, this.offset + 32)).toBase58(); this.offset += 32; return value; }
  string() { const length = this.u32(); if (length > 1024) throw new Error("Unreasonable Borsh string length"); this.ensure(length); const value = this.data.toString("utf8", this.offset, this.offset + length); this.offset += length; return value; }
}

export type DecodedProgramTrade = {
  venue: "pumpfun" | "pumpswap" | "stonkfun" | "raydium_cpmm";
  eventName: "TradeEvent" | "BuyEvent" | "SellEvent" | "SwapEvent";
  mint: string;
  user: string;
  side: "buy" | "sell";
  timestamp: number | null;
  tokenAmountRaw: bigint;
  quoteMint: string;
  quoteAmountRaw: bigint;
  protocolFeeRaw: bigint | null;
  platformFeeRaw: bigint | null;
  lpFeeRaw: bigint | null;
  creatorFeeRaw: bigint | null;
  shareFeeRaw: bigint | null;
  cashbackRaw: bigint | null;
  buybackFeeRaw: bigint | null;
  protocolFeeBps: bigint | null;
  lpFeeBps: bigint | null;
  creatorFeeBps: bigint | null;
  instructionName: string | null;
  pool: string | null;
  creator: string | null;
  feeRecipient: string | null;
  virtualQuoteReservesRaw: bigint | null;
  realQuoteReservesRaw: bigint | null;
  tradeFeeRaw?: bigint;
  tradeFeeMint?: string;
  venueTradeFeeRaw?: bigint;
  venueTradeFeeMint?: string;
  creatorFeeMint?: string;
  inputTransferFeeRaw?: bigint;
  outputTransferFeeRaw?: bigint;
  preTradeBaseReserveRaw?: bigint;
  preTradeQuoteReserveRaw?: bigint;
};

type LaunchLabSwap = { user: string; pool: string; quoteMint: string; side: "buy" | "sell" };
function findLaunchLabSwap(instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>, mint: string, pool: string): LaunchLabSwap | null {
  for (const instruction of instructions) {
    if (String(instruction.programId ?? "") !== LAUNCHLAB_PROGRAM || typeof instruction.data !== "string" || !Array.isArray(instruction.accounts)) continue;
    let bytes: Uint8Array;
    try { bytes = decodeBase58(instruction.data); } catch { continue; }
    if (bytes.length < 8 || instruction.accounts.length < 11) continue;
    const discriminator = [...bytes.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const side = LAUNCHLAB_SWAPS.get(discriminator);
    if (!side) continue;
    const user = String(instruction.accounts[0] ?? "");
    const instructionPool = String(instruction.accounts[4] ?? "");
    const baseMint = String(instruction.accounts[9] ?? "");
    const quoteMint = String(instruction.accounts[10] ?? "");
    if (baseMint === mint && instructionPool === pool && user && quoteMint) return { user, pool, quoteMint, side };
  }
  return null;
}

function decodePump(data: Buffer): DecodedProgramTrade | null {
  try {
    const r = new Reader(data); r.offset = 8;
    const mint = r.key(); const solAmount = r.u64(); const tokenAmountRaw = r.u64();
    const isBuy = r.bool(); const user = r.key(); const timestamp = Number(r.i64());
    const virtualQuoteAfter = r.u64(); const virtualBaseAfter = r.u64(); r.u64(); r.u64();
    const feeRecipient = r.key(); const protocolFeeBps = r.u64(); const protocolFeeRaw = r.u64();
    const creator = r.key(); const creatorFeeBps = r.u64(); const creatorFeeRaw = r.u64();
    let quoteMint = SOL_MINT; let quoteAmountRaw = solAmount;
    let cashbackRaw: bigint | null = null; let buybackFeeRaw: bigint | null = null; let instructionName: string | null = null;
    let virtualQuoteReservesRaw: bigint | null = null; let realQuoteReservesRaw: bigint | null = null;
    if (r.offset < data.length) {
      r.bool(); r.u64(); r.u64(); r.u64(); r.i64(); instructionName = r.string(); r.bool();
      r.u64(); cashbackRaw = r.u64(); r.u64(); buybackFeeRaw = r.u64();
      const shareholderCount = r.u32(); if (shareholderCount > 100) throw new Error("Unreasonable shareholder vector");
      for (let i = 0; i < shareholderCount; i++) { r.key(); r.u16(); }
      if (r.offset + 32 <= data.length) { const parsedQuote = r.key(); if (parsedQuote !== ZERO_KEY) quoteMint = parsedQuote; }
      if (r.offset + 8 <= data.length) quoteAmountRaw = r.u64();
      if (r.offset + 8 <= data.length) virtualQuoteReservesRaw = r.u64();
      if (r.offset + 8 <= data.length) realQuoteReservesRaw = r.u64();
    }
    return {
      venue: "pumpfun", eventName: "TradeEvent", mint, user, side: isBuy ? "buy" : "sell", timestamp,
      tokenAmountRaw, quoteMint, quoteAmountRaw, protocolFeeRaw, platformFeeRaw: null, lpFeeRaw: null,
      creatorFeeRaw, shareFeeRaw: null, cashbackRaw, buybackFeeRaw, protocolFeeBps, lpFeeBps: null,
      creatorFeeBps, instructionName, pool: null, creator: creator === ZERO_KEY ? null : creator,
      feeRecipient: feeRecipient === ZERO_KEY ? null : feeRecipient, virtualQuoteReservesRaw, realQuoteReservesRaw,
      preTradeBaseReserveRaw: isBuy ? virtualBaseAfter + tokenAmountRaw : virtualBaseAfter > tokenAmountRaw ? virtualBaseAfter - tokenAmountRaw : 0n,
      preTradeQuoteReserveRaw: isBuy ? (virtualQuoteReservesRaw ?? virtualQuoteAfter) > quoteAmountRaw ? (virtualQuoteReservesRaw ?? virtualQuoteAfter) - quoteAmountRaw : 0n : (virtualQuoteReservesRaw ?? virtualQuoteAfter) + quoteAmountRaw
    };
  } catch { return null; }
}

function decodePumpAmm(data: Buffer, side: "buy" | "sell"): DecodedProgramTrade | null {
  try {
    const r = new Reader(data); r.offset = 8;
    const timestamp = Number(r.i64()); const tokenAmountRaw = r.u64(); r.u64();
    r.u64(); r.u64(); const poolBaseAfter = r.u64(); const poolQuoteAfter = r.u64();
    const poolQuoteAmountRaw = r.u64(); const lpFeeBps = r.u64(); const lpFeeRaw = r.u64();
    const protocolFeeBps = r.u64(); const protocolFeeRaw = r.u64(); r.u64();
    const userQuoteAmountRaw = r.u64(); const pool = r.key(); const user = r.key();
    r.key(); r.key(); r.key(); r.key(); const creator = r.key();
    const creatorFeeBps = r.u64(); const creatorFeeRaw = r.u64();
    let instructionName: string | null = null;
    if (side === "buy") { r.bool(); r.u64(); r.u64(); r.u64(); r.i64(); r.u64(); instructionName = r.string(); }
    const cashbackFeeBps = r.u64(); const cashbackRaw = r.u64();
    const buybackFeeBps = r.u64(); const buybackFeeRaw = r.u64();
    const virtualQuoteReservesRaw = r.i128();
    if (side === "buy") r.bool();
    r.u64(); r.u64(); r.u64(); r.u64();
    void cashbackFeeBps; void buybackFeeBps;
    return {
      venue: "pumpswap", eventName: side === "buy" ? "BuyEvent" : "SellEvent",
      mint: "", user, side, timestamp, tokenAmountRaw, quoteMint: SOL_MINT,
      quoteAmountRaw: userQuoteAmountRaw > 0n ? userQuoteAmountRaw : poolQuoteAmountRaw,
      protocolFeeRaw, platformFeeRaw: null, lpFeeRaw, creatorFeeRaw, shareFeeRaw: null,
      cashbackRaw, buybackFeeRaw, protocolFeeBps, lpFeeBps, creatorFeeBps,
      instructionName, pool, creator: creator === ZERO_KEY ? null : creator, feeRecipient: null,
      virtualQuoteReservesRaw, realQuoteReservesRaw: null,
      preTradeBaseReserveRaw: side === "buy" ? poolBaseAfter + tokenAmountRaw : poolBaseAfter > tokenAmountRaw ? poolBaseAfter - tokenAmountRaw : 0n,
      preTradeQuoteReserveRaw: side === "buy" ? poolQuoteAfter > (userQuoteAmountRaw > 0n ? userQuoteAmountRaw : poolQuoteAmountRaw) ? poolQuoteAfter - (userQuoteAmountRaw > 0n ? userQuoteAmountRaw : poolQuoteAmountRaw) : 0n : poolQuoteAfter + (userQuoteAmountRaw > 0n ? userQuoteAmountRaw : poolQuoteAmountRaw)
    };
  } catch { return null; }
}

function decodeLaunchLab(data: Buffer, targetMint: string, instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>): DecodedProgramTrade | null {
  try {
    const r = new Reader(data); r.offset = 8;
    const pool = r.key();
    r.u64();
    const virtualBaseAfter = r.u64(); const virtualQuoteAfter = r.u64();
    r.u64(); r.u64(); r.u64(); r.u64();
    const amountIn = r.u64(); const amountOut = r.u64();
    const protocolFeeRaw = r.u64(); const platformFeeRaw = r.u64();
    const creatorFeeRaw = r.u64(); const shareFeeRaw = r.u64();
    const direction = r.u8(); r.u8(); r.bool();
    if (direction > 1) return null;
    const side = direction === 0 ? "buy" : "sell";
    const swap = findLaunchLabSwap(instructions, targetMint, pool);
    if (!swap || swap.side !== side) return null;
    return {
      venue: "stonkfun", eventName: "TradeEvent", mint: targetMint, user: swap.user, side,
      timestamp: null, tokenAmountRaw: side === "buy" ? amountOut : amountIn,
      quoteMint: swap.quoteMint, quoteAmountRaw: side === "buy" ? amountIn : amountOut,
      protocolFeeRaw, platformFeeRaw, lpFeeRaw: null, creatorFeeRaw, shareFeeRaw,
      cashbackRaw: null, buybackFeeRaw: null, protocolFeeBps: null, lpFeeBps: null,
      creatorFeeBps: null, instructionName: null, pool, creator: null, feeRecipient: null,
      virtualQuoteReservesRaw: null, realQuoteReservesRaw: null,
      preTradeBaseReserveRaw: side === "buy" ? virtualBaseAfter + amountOut : virtualBaseAfter > amountIn ? virtualBaseAfter - amountIn : 0n,
      preTradeQuoteReserveRaw: side === "buy" ? virtualQuoteAfter > amountIn ? virtualQuoteAfter - amountIn : 0n : virtualQuoteAfter + amountOut
    };
  } catch { return null; }
}

export function decodeProgramTradeEvents(
  logMessages: string[] | null | undefined,
  targetMint: string,
  instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }> = []
): DecodedProgramTrade[] {
  const decoded: DecodedProgramTrade[] = [];
  const stack: string[] = [];
  for (const line of logMessages ?? []) {
    const invoke = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/);
    if (invoke) { stack.push(invoke[1]); continue; }
    const marker = "Program data: ";
    const position = line.indexOf(marker);
    if (position >= 0) {
      const program = stack[stack.length - 1];
      let bytes: Buffer;
      try { bytes = Buffer.from(line.slice(position + marker.length).trim(), "base64"); } catch { continue; }
      if (bytes.length < 8) continue;
      const discriminator = bytes.subarray(0, 8);
      let event: DecodedProgramTrade | null = null;
      if (program === PUMP_PROGRAM && discriminator.equals(PUMP_TRADE)) event = decodePump(bytes);
      else if (program === PUMP_AMM_PROGRAM && discriminator.equals(PUMP_AMM_BUY)) event = decodePumpAmm(bytes, "buy");
      else if (program === PUMP_AMM_PROGRAM && discriminator.equals(PUMP_AMM_SELL)) event = decodePumpAmm(bytes, "sell");
      else if (program === LAUNCHLAB_PROGRAM && discriminator.equals(LAUNCHLAB_TRADE)) event = decodeLaunchLab(bytes, targetMint, instructions);
      else if (program === RAYDIUM_CPMM_PROGRAM && discriminator.equals(Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]))) {
        const raydium = decodeRaydiumCpmmTradeEvent(bytes, targetMint, instructions, data => new Reader(data));
        event = raydium ? {
          ...raydium,
          protocolFeeRaw: null,
          platformFeeRaw: null, lpFeeRaw: null,
          creatorFeeRaw: raydium.creatorFeeMint === raydium.quoteMint ? raydium.creatorFeeRaw : null,
          shareFeeRaw: null, cashbackRaw: null, buybackFeeRaw: null,
          protocolFeeBps: null, lpFeeBps: null, creatorFeeBps: null,
          instructionName: null, feeRecipient: null, creator: null,
          virtualQuoteReservesRaw: null, realQuoteReservesRaw: null,
          venueTradeFeeRaw: raydium.tradeFeeRaw, venueTradeFeeMint: raydium.tradeFeeMint,
          preTradeBaseReserveRaw: raydium.preTradeBaseReserveRaw, preTradeQuoteReserveRaw: raydium.preTradeQuoteReserveRaw,
          inputTransferFeeRaw: raydium.inputTransferFeeRaw, outputTransferFeeRaw: raydium.outputTransferFeeRaw
        } : null;
      }
      if (!event) continue;
      if (event.venue === "pumpswap") {\n        event.mint = targetMint;\n        const pool = findPumpSwapPoolFromInstructions(instructions, targetMint);\n        if (pool) event.quoteMint = pool.quoteMint;\n      }
      if (event.mint === targetMint && event.tokenAmountRaw > 0n && event.quoteAmountRaw > 0n) decoded.push(event);
      continue;
    }
    const finish = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/);
    if (finish) {
      const index = stack.lastIndexOf(finish[1]);
      if (index >= 0) stack.splice(index, 1);
    }
  }
  return decoded;
}
