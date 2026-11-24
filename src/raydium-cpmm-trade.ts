import { decodeBase58 } from "./pump-instructions.js";

const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const SWAP_BASE_INPUT = "8fbe5adac41e33de";
const SWAP_BASE_OUTPUT = "37d96256a34ab4ad";
const SWAP_EVENT = Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]);

type Instruction = { programId?: unknown; data?: unknown; accounts?: unknown[] };
type ReaderLike = {
  offset: number;
  key(): string;
  u64(): bigint;
  bool(): boolean;
};

export type RaydiumCpmmTrade = {
  venue: "raydium_cpmm";
  eventName: "SwapEvent";
  mint: string;
  user: string;
  side: "buy" | "sell";
  timestamp: null;
  tokenAmountRaw: bigint;
  quoteMint: string;
  quoteAmountRaw: bigint;
  pool: string;
  tradeFeeRaw: bigint;
  tradeFeeMint: string;
  creatorFeeRaw: bigint;
  creatorFeeMint: string;
  inputTransferFeeRaw: bigint;
  outputTransferFeeRaw: bigint;
};

export function decodeRaydiumCpmmTradeEvent(
  data: Buffer,
  targetMint: string,
  instructions: Instruction[],
  readerFactory: (data: Buffer) => ReaderLike
): RaydiumCpmmTrade | null {
  try {
    if (data.length < 8 || !data.subarray(0, 8).equals(SWAP_EVENT)) return null;
    const r = readerFactory(data);
    r.offset = 8;
    const pool = r.key();
    r.u64(); r.u64();
    const inputAmount = r.u64();
    const outputAmount = r.u64();
    const inputTransferFeeRaw = r.u64();
    const outputTransferFeeRaw = r.u64();
    r.bool();
    const inputMint = r.key();
    const outputMint = r.key();
    const tradeFeeRaw = r.u64();
    const creatorFeeRaw = r.u64();
    const creatorFeeOnInput = r.bool();

    for (const instruction of instructions) {
      if (String(instruction.programId ?? "") !== CPMM_PROGRAM || typeof instruction.data !== "string" || !Array.isArray(instruction.accounts)) continue;
      let bytes: Uint8Array;
      try { bytes = decodeBase58(instruction.data); } catch { continue; }
      if (bytes.length < 8 || instruction.accounts.length < 12) continue;
      const discriminator = [...bytes.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (discriminator !== SWAP_BASE_INPUT && discriminator !== SWAP_BASE_OUTPUT) continue;
      const user = String(instruction.accounts[0] ?? "");
      const instructionPool = String(instruction.accounts[3] ?? "");
      const instructionInputMint = String(instruction.accounts[10] ?? "");
      const instructionOutputMint = String(instruction.accounts[11] ?? "");
      if (instructionPool !== pool || instructionInputMint !== inputMint || instructionOutputMint !== outputMint) continue;
      if (inputMint !== targetMint && outputMint !== targetMint) continue;
      const side = inputMint === targetMint ? "sell" : "buy";
      const tokenAmountRaw = side === "buy"
        ? outputAmount > outputTransferFeeRaw ? outputAmount - outputTransferFeeRaw : 0n
        : inputAmount + inputTransferFeeRaw;
      const quoteAmountRaw = side === "buy"
        ? inputAmount + inputTransferFeeRaw
        : outputAmount > outputTransferFeeRaw ? outputAmount - outputTransferFeeRaw : 0n;
      if (tokenAmountRaw <= 0n || quoteAmountRaw <= 0n) return null;
      return {
        venue: "raydium_cpmm", eventName: "SwapEvent", mint: targetMint, user, side, timestamp: null,
        tokenAmountRaw, quoteMint: side === "buy" ? inputMint : outputMint,
        quoteAmountRaw,
        pool, tradeFeeRaw, tradeFeeMint: inputMint,
        creatorFeeRaw, creatorFeeMint: creatorFeeOnInput ? inputMint : outputMint,
        inputTransferFeeRaw, outputTransferFeeRaw
      };
    }
    return null;
  } catch { return null; }
}
