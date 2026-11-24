import { PublicKey } from "@solana/web3.js";

const PUMP_TRADE = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const PUMP_AMM_BUY = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const PUMP_AMM_SELL = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const ZERO_KEY = new PublicKey(Buffer.alloc(32)).toBase58();
const SOL_MINT = "So11111111111111111111111111111111111111112";

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
  venue: "pumpfun" | "pumpswap";
  eventName: "TradeEvent" | "BuyEvent" | "SellEvent";
  mint: string;
  user: string;
  side: "buy" | "sell";
  timestamp: number;
  tokenAmountRaw: bigint;
  quoteMint: string;
  quoteAmountRaw: bigint;
  protocolFeeRaw: bigint | null;
  lpFeeRaw: bigint | null;
  creatorFeeRaw: bigint | null;
  cashbackRaw: bigint | null;
  buybackFeeRaw: bigint | null;
  protocolFeeBps: bigint | null;
  lpFeeBps: bigint | null;
  creatorFeeBps: bigint | null;
  instructionName: string | null;
  pool: string | null;
  virtualQuoteReservesRaw: bigint | null;
  realQuoteReservesRaw: bigint | null;
};

function decodePump(data: Buffer): DecodedProgramTrade | null {
  try {
    const r = new Reader(data);
    r.offset = 8;
    const mint = r.key();
    const solAmount = r.u64();
    const tokenAmountRaw = r.u64();
    const isBuy = r.bool();
    const user = r.key();
    const timestamp = Number(r.i64());
    r.u64(); // virtual SOL reserves
    r.u64(); // virtual token reserves
    r.u64(); // real SOL reserves
    r.u64(); // real token reserves
    r.key(); // fee recipient
    const protocolFeeBps = r.u64();
    const protocolFeeRaw = r.u64();
    r.key(); // creator
    const creatorFeeBps = r.u64();
    const creatorFeeRaw = r.u64();
    // Older event versions end here; current versions append volume, quote and reward fields.
    let quoteMint = SOL_MINT;
    let quoteAmountRaw = solAmount;
    let cashbackRaw: bigint | null = null;
    let buybackFeeRaw: bigint | null = null;
    let instructionName: string | null = null;
    let virtualQuoteReservesRaw: bigint | null = null;
    let realQuoteReservesRaw: bigint | null = null;
    if (r.offset < data.length) {
      r.bool(); r.u64(); r.u64(); r.u64(); r.i64();
      instructionName = r.string();
      r.bool();
      r.u64(); cashbackRaw = r.u64();
      r.u64(); buybackFeeRaw = r.u64();
      const shareholderCount = r.u32();
      if (shareholderCount > 100) throw new Error("Unreasonable shareholder vector");
      for (let i = 0; i < shareholderCount; i++) { r.key(); r.u16(); }
      if (r.offset + 32 <= data.length) {
        const parsedQuote = r.key();
        if (parsedQuote !== ZERO_KEY) quoteMint = parsedQuote;
      }
      if (r.offset + 8 <= data.length) quoteAmountRaw = r.u64();
      if (r.offset + 8 <= data.length) virtualQuoteReservesRaw = r.u64();
      if (r.offset + 8 <= data.length) realQuoteReservesRaw = r.u64();
    }
    return {
      venue: "pumpfun", eventName: "TradeEvent", mint, user, side: isBuy ? "buy" : "sell",
      timestamp, tokenAmountRaw, quoteMint, quoteAmountRaw, protocolFeeRaw, lpFeeRaw: null,
      creatorFeeRaw, cashbackRaw, buybackFeeRaw, protocolFeeBps, lpFeeBps: null, creatorFeeBps,
      instructionName, pool: null, virtualQuoteReservesRaw, realQuoteReservesRaw
    };
  } catch { return null; }
}

function decodePumpAmm(data: Buffer, side: "buy" | "sell"): DecodedProgramTrade | null {
  try {
    const r = new Reader(data);
    r.offset = 8;
    const timestamp = Number(r.i64());
    const tokenAmountRaw = r.u64(); // base amount out on buy / base amount in on sell
    r.u64(); // max quote in / min quote out
    r.u64(); r.u64(); // user reserves
    r.u64(); r.u64(); // pool reserves
    const poolQuoteAmountRaw = r.u64();
    const lpFeeBps = r.u64();
    const lpFeeRaw = r.u64();
    const protocolFeeBps = r.u64();
    const protocolFeeRaw = r.u64();
    r.u64(); // quote amount with LP fee / without LP fee
    const userQuoteAmountRaw = r.u64();
    const pool = r.key();
    const user = r.key();
    r.key(); r.key(); r.key(); r.key(); // token accounts and protocol recipient
    r.key(); // coin creator
    const creatorFeeBps = r.u64();
    const creatorFeeRaw = r.u64();
    let instructionName: string | null = null;
    if (side === "buy") {
      r.bool(); // track volume
      r.u64(); r.u64(); r.u64(); r.i64(); r.u64();
      instructionName = r.string();
    }
    const cashbackFeeBps = r.u64();
    const cashbackRaw = r.u64();
    const buybackFeeBps = r.u64();
    const buybackFeeRaw = r.u64();
    const virtualQuoteReservesRaw = r.i128();
    if (side === "buy") r.bool(); // can boost
    r.u64(); // base supply
    r.u64(); // holder rewards bps
    r.u64(); // holder rewards
    r.u64(); // creator fee unclaimed
    void cashbackFeeBps; void buybackFeeBps;
    return {
      venue: "pumpswap", eventName: side === "buy" ? "BuyEvent" : "SellEvent",
      mint: "", user, side, timestamp, tokenAmountRaw,
      quoteMint: SOL_MINT, quoteAmountRaw: userQuoteAmountRaw > 0n ? userQuoteAmountRaw : poolQuoteAmountRaw,
      protocolFeeRaw, lpFeeRaw, creatorFeeRaw, cashbackRaw, buybackFeeRaw,
      protocolFeeBps, lpFeeBps, creatorFeeBps, instructionName, pool,
      virtualQuoteReservesRaw, realQuoteReservesRaw: null
    };
  } catch { return null; }
}

export function decodeProgramTradeEvents(logMessages: string[] | null | undefined, targetMint: string): DecodedProgramTrade[] {
  const decoded: DecodedProgramTrade[] = [];
  for (const line of logMessages ?? []) {
    const marker = "Program data: ";
    const position = line.indexOf(marker);
    if (position < 0) continue;
    let bytes: Buffer;
    try { bytes = Buffer.from(line.slice(position + marker.length).trim(), "base64"); } catch { continue; }
    if (bytes.length < 8) continue;
    const discriminator = bytes.subarray(0, 8);
    let event: DecodedProgramTrade | null = null;
    if (discriminator.equals(PUMP_TRADE)) event = decodePump(bytes);
    else if (discriminator.equals(PUMP_AMM_BUY)) event = decodePumpAmm(bytes, "buy");
    else if (discriminator.equals(PUMP_AMM_SELL)) event = decodePumpAmm(bytes, "sell");
    if (!event) continue;
    if (event.venue === "pumpswap") event.mint = targetMint;
    if (event.mint === targetMint && event.tokenAmountRaw > 0n && event.quoteAmountRaw > 0n) decoded.push(event);
  }
  return decoded;
}
