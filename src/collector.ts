import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Connection, PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveTradeObservations, marketCap } from "./metrics.js";
import { findPumpCreateInstructions } from "./pump-instructions.js";
import { flushHuggingFaceUploads, markCollectorStateDirty, markMintDirty, restoreCollectorState, restoreTokenEvents } from "./hf-uploader.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const INVALID_QUOTE_MINTS = new Set([WRAPPED_SOL_MINT, USDC_MINT, USDT_MINT]);
const CREATE_LOG = /Program log: Instruction: Create(?:V2)?\s*$/im;
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const CAPTURE_MS = Number(process.env.CAPTURE_MINUTES ?? 10) * 60_000;
const RUN_FOR_MS = Number(process.env.RUN_FOR_MINUTES ?? 0) * 60_000;
const RECONCILE_PAGE_SIZE = 100;
const MAX_RECONCILE_PAGES = Number(process.env.MAX_RECONCILE_PAGES_PER_RUN ?? 20);
const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter((v): v is string => Boolean(v));
if (keys.length === 0) throw new Error("Set at least HELIUS_API_KEY_1 in your environment.");
if (keys.length !== 3) console.warn(`Only ${keys.length} Helius API key(s) configured; using available key(s).`);
const rpc = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
let rpcCursor = 0;
const nextRpc = () => rpc[(rpcCursor++) % rpc.length];

type TokenMetrics = {
  tradeCount: number; buyCount: number; sellCount: number;
  volumeSol: number; volumeUsd: number;
  uniqueBuyers: string[]; uniqueSellers: string[];
  firstPriceSol: number | null; firstPriceUsd: number | null;
  lastPriceSol: number | null; lastPriceUsd: number | null; lastPriceObservedAt: number | null;
  highPriceUsd: number | null; lowPriceUsd: number | null;
  snapshotsRecorded: number[];
  maxDrawdownPct: number | null;
  timeToTargetsSeconds: Record<string, number | null>;
  largestBuySol: number;
  largestSellSol: number;
  priceSource?: string;
  curveRealSolReserves?: number | null;
  curveRealTokenReserves?: number | null;
  curveVirtualSolReserves?: number | null;
  curveVirtualTokenReserves?: number | null;
  curveComplete?: boolean | null;
  curveSnapshots?: number;
  firstPriceQuote?: number | null; lastPriceQuote?: number | null;
  quoteMint?: string | null; quoteSymbol?: string | null; quoteDecimals?: number | null;
  curveRealQuoteReserves?: number | null; curveVirtualQuoteReserves?: number | null;
};
type TokenState = {
  mint: string; creator: string | null; launchSignature: string;
  launchVerified?: boolean; launchInstruction?: "create" | "create_v2";
  firstSeenAt: number; expiresAt: number;
  supplyUi?: number | null; supplyDecimals?: number | null;
  metrics?: TokenMetrics;
};
type CollectorState = {
  tokens: Record<string, TokenState>;
  seenLaunchSignatures: string[];
  lastProgramSignature?: string;
  reconcileTarget?: string;
  reconcileBefore?: string;
};
const statePath = path.join(DATA_DIR, "collector-state.json");
let state: CollectorState = { tokens: {}, seenLaunchSignatures: [] };
const activeSubscriptions = new Map<string, { connection: Connection; id: number; curveId?: number; timer?: NodeJS.Timeout }>();
let discoverySubscription: { connection: Connection; id: number } | undefined;
let expiryTimer: NodeJS.Timeout | undefined;
let runTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let reconciliation: Promise<void> | undefined;

let cachedSolUsd: { value: number; fetchedAt: number } | undefined;
const quoteDecimalsCache = new Map<string, number>();
async function getMintDecimals(mint: string): Promise<number | null> {
  if (mint === WRAPPED_SOL_MINT) return 9;
  if (quoteDecimalsCache.has(mint)) return quoteDecimalsCache.get(mint)!;
  try {
    const response = await nextRpc().getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const value = response.value;
    if (!value || !("parsed" in value.data)) return null;
    const parsed = value.data.parsed as { info?: { decimals?: number } };
    const decimals = parsed.info?.decimals;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    quoteDecimalsCache.set(mint, decimals);
    return decimals;
  } catch (error) {
    console.warn("Could not read quote mint decimals:", mint, String(error).slice(0, 120));
    return null;
  }
}
async function getSolUsd(): Promise<number | null> {
  if (cachedSolUsd && Date.now() - cachedSolUsd.fetchedAt < 60_000) return cachedSolUsd.value;
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`SOL/USD price HTTP ${response.status}`);
    const body = await response.json() as { solana?: { usd?: number } };
    const value = body.solana?.usd;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return cachedSolUsd?.value ?? null;
    cachedSolUsd = { value, fetchedAt: Date.now() };
    return value;
  } catch (error) {
    console.warn("SOL/USD reference unavailable; USD metrics will remain null:", String(error).slice(0, 120));
    return cachedSolUsd?.value ?? null;
  }
}
function ensureMetrics(item: TokenState): TokenMetrics {
  item.metrics ??= {
    tradeCount: 0, buyCount: 0, sellCount: 0, volumeSol: 0, volumeUsd: 0,
    uniqueBuyers: [], uniqueSellers: [], firstPriceSol: null, firstPriceUsd: null,
    lastPriceSol: null, lastPriceUsd: null, lastPriceObservedAt: null, highPriceUsd: null, lowPriceUsd: null,
    snapshotsRecorded: [], maxDrawdownPct: null,
    timeToTargetsSeconds: { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null },
    largestBuySol: 0, largestSellSol: 0
  };
  return item.metrics;
}
const SNAPSHOT_SECONDS = [5, 10, 15, 30, 60, 120, 300, 600];

type PumpCurveState = {
  creator: string | null; quoteMint: string | null; complete: boolean;
  virtualTokenRaw: bigint; virtualSolLamports: bigint;
  realTokenRaw: bigint; realSolLamports: bigint; totalSupplyRaw: bigint;
  creatorFeeBps: bigint | null; isHolderReward: boolean | null;
  creatorFeeAccruedRaw: bigint | null; protocolFeesAccruedRaw: bigint | null;
  isMayhemMode: boolean | null; isCashbackCoin: boolean | null;
};
function decodePumpCurve(data: Buffer): PumpCurveState | null {
  // Anchor account: discriminator + five u64 reserves/supply + bool + creator.
  if (data.length < 49) return null;
  const zero = new PublicKey(Buffer.alloc(32)).toBase58();
  const creator = data.length >= 81 ? new PublicKey(data.subarray(49, 81)).toBase58() : null;
  // Current extended layout appends mayhem/cashback flags, then quote_mint.
  const quoteMint = data.length >= 115 ? new PublicKey(data.subarray(83, 115)).toBase58() : null;
  return {
    creator: creator === zero ? null : creator,
    quoteMint: quoteMint === zero ? null : quoteMint,
    virtualTokenRaw: data.readBigUInt64LE(8),
    virtualSolLamports: data.readBigUInt64LE(16),
    realTokenRaw: data.readBigUInt64LE(24),
    realSolLamports: data.readBigUInt64LE(32),
    totalSupplyRaw: data.readBigUInt64LE(40),
    complete: data[48] === 1,
    isMayhemMode: data.length >= 82 ? data[81] === 1 : null,
    isCashbackCoin: data.length >= 83 ? data[82] === 1 : null,
    creatorFeeBps: data.length >= 123 ? data.readBigUInt64LE(115) : null,
    isHolderReward: data.length >= 125 ? data[124] === 1 : null,
    creatorFeeAccruedRaw: data.length >= 133 ? data.readBigUInt64LE(125) : null,
    protocolFeesAccruedRaw: data.length >= 141 ? data.readBigUInt64LE(133) : null
  };
}
async function processCurveState(item: TokenState, data: Buffer, slot: number) {
  const curve = decodePumpCurve(data);
  if (!curve) return;
  // The default pubkey means SOL; a populated quote_mint means an SPL quote asset.
  const quoteMint = curve.quoteMint ?? WRAPPED_SOL_MINT;
  const quoteDecimals = await getMintDecimals(quoteMint);
  if (quoteDecimals == null) {
    await appendTokenEvent(item.mint, { schemaVersion: 4, kind: "curve_state", mint: item.mint, slot, quoteMint, pricingAvailable: false, reason: "Could not resolve quote mint decimals." });
    return;
  }
  const decimals = item.supplyDecimals ?? 6;
  const tokenDivisor = 10 ** decimals, quoteDivisor = 10 ** quoteDecimals;
  const virtualToken = Number(curve.virtualTokenRaw) / tokenDivisor;
  const virtualQuote = Number(curve.virtualSolLamports) / quoteDivisor;
  const realToken = Number(curve.realTokenRaw) / tokenDivisor;
  const realQuote = Number(curve.realSolLamports) / quoteDivisor;
  const supply = Number(curve.totalSupplyRaw) / tokenDivisor;
  if (virtualToken <= 0 || virtualQuote <= 0 || supply <= 0) return;
  const priceQuote = virtualQuote / virtualToken;
  const isSol = quoteMint === WRAPPED_SOL_MINT, isUsdc = quoteMint === USDC_MINT, isUsdt = quoteMint === USDT_MINT;
  const solUsd = isSol ? await getSolUsd() : null;
  const quoteUsd = isSol ? solUsd : (isUsdc || isUsdt ? 1 : null);
  const priceUsd = quoteUsd == null ? null : priceQuote * quoteUsd;
  const priceSol = isSol ? priceQuote : null;
  const quoteSymbol = isSol ? "SOL" : isUsdc ? "USDC" : isUsdt ? "USDT" : "UNKNOWN_SPL";
  const metrics = ensureMetrics(item);
  item.supplyUi = supply;
  if (metrics.priceSource !== "pump_bonding_curve_virtual_reserves" || metrics.quoteMint !== quoteMint) {
    metrics.firstPriceSol = priceSol; metrics.firstPriceUsd = priceUsd; metrics.firstPriceQuote = priceQuote;
    metrics.quoteMint = quoteMint; metrics.quoteSymbol = quoteSymbol; metrics.quoteDecimals = quoteDecimals;
    metrics.timeToTargetsSeconds = { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null };
    metrics.highPriceUsd = priceUsd; metrics.lowPriceUsd = priceUsd; metrics.maxDrawdownPct = null;
  }
  metrics.priceSource = "pump_bonding_curve_virtual_reserves";
  metrics.lastPriceSol = priceSol; metrics.lastPriceUsd = priceUsd; metrics.lastPriceQuote = priceQuote;
  metrics.lastPriceObservedAt = Date.now();
  metrics.curveRealSolReserves = isSol ? realQuote : null;
  metrics.curveRealTokenReserves = realToken;
  metrics.curveVirtualSolReserves = isSol ? virtualQuote : null;
  metrics.curveVirtualTokenReserves = virtualToken;
  metrics.curveRealQuoteReserves = realQuote; metrics.curveVirtualQuoteReserves = virtualQuote;
  metrics.curveComplete = curve.complete; metrics.curveSnapshots = (metrics.curveSnapshots ?? 0) + 1;
  if (priceUsd != null) {
    metrics.highPriceUsd = metrics.highPriceUsd == null ? priceUsd : Math.max(metrics.highPriceUsd, priceUsd);
    metrics.lowPriceUsd = metrics.lowPriceUsd == null ? priceUsd : Math.min(metrics.lowPriceUsd, priceUsd);
    const drawdown = metrics.highPriceUsd > 0 ? ((priceUsd / metrics.highPriceUsd) - 1) * 100 : 0;
    metrics.maxDrawdownPct = Math.min(metrics.maxDrawdownPct ?? 0, drawdown);
    const multiple = metrics.firstPriceUsd && metrics.firstPriceUsd > 0 ? priceUsd / metrics.firstPriceUsd : 1;
    const elapsed = Math.max(0, (Date.now() - item.firstSeenAt) / 1000);
    for (const [target, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2]] as const) {
      if (multiple >= threshold && metrics.timeToTargetsSeconds[target] == null) metrics.timeToTargetsSeconds[target] = elapsed;
    }
  }
  if (curve.creator && item.creator !== curve.creator) { item.creator = curve.creator; await persistState(); }
  await appendTokenEvent(item.mint, {
    schemaVersion: 4, kind: "curve_state", mint: item.mint, slot, observedAt: Date.now(),
    creator: curve.creator, quoteMint, quoteSymbol, quoteDecimals, complete: curve.complete,
    isMayhemMode: curve.isMayhemMode, isCashbackCoin: curve.isCashbackCoin,
    isHolderReward: curve.isHolderReward,
    creatorFeeBps: curve.creatorFeeBps?.toString() ?? null,
    creatorFeeAccruedRaw: curve.creatorFeeAccruedRaw?.toString() ?? null,
    protocolFeesAccruedRaw: curve.protocolFeesAccruedRaw?.toString() ?? null,
    creatorFeeAccruedQuote: curve.creatorFeeAccruedRaw == null ? null : Number(curve.creatorFeeAccruedRaw) / quoteDivisor,
    protocolFeesAccruedQuote: curve.protocolFeesAccruedRaw == null ? null : Number(curve.protocolFeesAccruedRaw) / quoteDivisor,
    virtualTokenReservesRaw: curve.virtualTokenRaw.toString(), virtualQuoteReservesRaw: curve.virtualSolLamports.toString(),
    realTokenReservesRaw: curve.realTokenRaw.toString(), realQuoteReservesRaw: curve.realSolLamports.toString(),
    virtualQuoteReserves: virtualQuote, realQuoteReserves: realQuote,
    totalSupply: supply, tokenDecimals: decimals, priceQuote, priceSol, priceUsd, quoteUsd, solUsd,
    marketCapQuote: marketCap(priceQuote, supply), marketCapSol: isSol ? marketCap(priceQuote, supply) : null,
    marketCapUsd: marketCap(priceUsd, supply), pricingMethod: "pump_bonding_curve_virtual_reserves",
    // Published bonding-curve schedule: 0.95% protocol + 0.30% creator = 1.25%.
    // Custom-pair Holder Rewards can override the creator component; exact event values take precedence.
    estimatedProtocolFeeBps: 95,
    configuredCreatorFeeBps: curve.creatorFeeBps?.toString() ?? null,
    estimatedCreatorFeeBps: curve.isHolderReward ? null : (isSol || isUsdc ? 30 : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? Number(curve.creatorFeeBps) : 30),
    estimatedTotalCurveFeeBps: curve.isHolderReward ? null : 95 + (isSol || isUsdc ? 30 : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? Number(curve.creatorFeeBps) : 30),
    feeRateSource: curve.isHolderReward ? "holder_rewards_rate_not_yet_decoded" : isSol || isUsdc ? "published_sol_usdc_bonding_curve_schedule" : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? "bonding_curve_account_creator_fee_bps_plus_published_protocol_rate" : "published_custom_pair_schedule",
    feeIsEstimateNotExecution: true,
    creatorFeeMayBeOverriddenByHolderRewards: true,
    realTokenReservesUi: realToken, maxDrawdownPct: metrics.maxDrawdownPct,
    timeToTargetsSeconds: metrics.timeToTargetsSeconds
  });
  await recordDueSnapshots(item, Date.now());
  await persistState();
}
async function recordDueSnapshots(item: TokenState, observedAt: number) {
  const metrics = ensureMetrics(item);
  // Wait for the bonding-curve account; do not permanently record empty/estimated snapshots.
  if (metrics.priceSource !== "pump_bonding_curve_virtual_reserves") return;
  const elapsedSeconds = Math.max(0, (observedAt - item.firstSeenAt) / 1000);
  for (const seconds of SNAPSHOT_SECONDS) {
    if (elapsedSeconds < seconds || metrics.snapshotsRecorded.includes(seconds)) continue;
    // Never substitute wallet-balance estimates for the authoritative bonding-curve price.
    const hasCurvePrice = metrics.priceSource === "pump_bonding_curve_virtual_reserves";
    const priceSol = hasCurvePrice ? metrics.lastPriceSol : null;
    const priceUsd = hasCurvePrice ? metrics.lastPriceUsd : null;
    const supply = item.supplyUi ?? null;
    const marketCapSol = marketCap(priceSol, supply);
    const marketCapUsd = marketCap(priceUsd, supply);
    const priceChangePct = metrics.firstPriceQuote && metrics.lastPriceQuote != null
      ? ((metrics.lastPriceQuote / metrics.firstPriceQuote) - 1) * 100 : null;
    await appendTokenEvent(item.mint, {
      schemaVersion: 4, kind: "market_snapshot", mint: item.mint,
      elapsedSeconds: seconds, observedAt, priceSol, priceUsd,
      priceQuote: metrics.lastPriceQuote ?? null, quoteMint: metrics.quoteMint ?? null,
      quoteSymbol: metrics.quoteSymbol ?? null, quoteDecimals: metrics.quoteDecimals ?? null,
      marketCapSol, marketCapUsd, marketCapQuote: marketCap(metrics.lastPriceQuote ?? null, supply), totalSupply: supply,
      priceChangePctFromFirstObservedPrice: priceChangePct,
      tradeCount: metrics.tradeCount, buyCount: metrics.buyCount, sellCount: metrics.sellCount,
      volumeSol: metrics.volumeSol, volumeUsd: metrics.volumeUsd,
      maxDrawdownPct: metrics.maxDrawdownPct, timeToTargetsSeconds: metrics.timeToTargetsSeconds,
      largestBuySol: metrics.largestBuySol, largestSellSol: metrics.largestSellSol,
      uniqueBuyers: metrics.uniqueBuyers.length, uniqueSellers: metrics.uniqueSellers.length,
      priceIsStale: metrics.lastPriceObservedAt == null || observedAt - metrics.lastPriceObservedAt > 5_000,
      pricingMethod: metrics.priceSource ?? "owner_balance_delta_estimate",
      curveComplete: metrics.curveComplete ?? null,
      curveRealSolReserves: metrics.curveRealSolReserves ?? null,
      curveRealQuoteReserves: metrics.curveRealQuoteReserves ?? null,
      curveVirtualQuoteReserves: metrics.curveVirtualQuoteReserves ?? null,
      curveRealTokenReserves: metrics.curveRealTokenReserves ?? null
    });
    metrics.snapshotsRecorded.push(seconds);
    await persistState();
  }
}
async function processTradeMetrics(item: TokenState, tx: ParsedTransactionWithMeta, signature: string, slot: number) {
  const solUsd = await getSolUsd();
  const knownQuoteMint = ensureMetrics(item).quoteMint;
  // Do not guess SOL while the curve account has not yet identified the actual quote asset.
  // The raw transaction is still persisted by the caller for later decoding.
  if (!knownQuoteMint) return;
  const quoteMint = knownQuoteMint;
  const observations = deriveTradeObservations(tx, item.mint, solUsd, quoteMint);
  if (observations.length === 0) return;
  const metrics = ensureMetrics(item);
  for (const trade of observations) {
    metrics.tradeCount++;
    if (trade.side === "buy") {
      metrics.buyCount++;
      if (!metrics.uniqueBuyers.includes(trade.wallet)) metrics.uniqueBuyers.push(trade.wallet);
    } else {
      metrics.sellCount++;
      if (!metrics.uniqueSellers.includes(trade.wallet)) metrics.uniqueSellers.push(trade.wallet);
    }
    metrics.volumeSol += trade.solAmount;
    if (trade.priceUsd != null && trade.quoteMint !== "So11111111111111111111111111111111111111112") metrics.volumeUsd += trade.quoteAmount * trade.priceUsd / trade.priceQuote;
    else if (trade.priceUsd != null) metrics.volumeUsd += trade.quoteAmount * (solUsd ?? 0);
    // Trade-level balance deltas are retained as low-confidence wallet/volume evidence only.
    // Bonding-curve virtual reserves are the sole source for the primary price and market-cap series.
  }
  const latest = observations[observations.length - 1];
  await appendTokenEvent(item.mint, {
    schemaVersion: 3, kind: "trade_metric", mint: item.mint, signature, slot,
    blockTime: tx.blockTime, observations,
    quoteMint, quoteSymbol: metrics.quoteSymbol ?? null,
    tradeVolumeQuote: observations.reduce((sum, trade) => sum + trade.quoteAmount, 0),
    tradeCount: metrics.tradeCount, buyCount: metrics.buyCount, sellCount: metrics.sellCount,
    volumeSol: metrics.volumeSol, volumeUsd: metrics.volumeUsd,
    uniqueBuyers: metrics.uniqueBuyers.length, uniqueSellers: metrics.uniqueSellers.length,
    lastPriceSol: latest.priceSol, lastPriceQuote: latest.priceQuote, lastPriceUsd: latest.priceUsd,
    marketCapQuote: marketCap(latest.priceQuote, item.supplyUi ?? null),
    marketCapSol: latest.priceSol == null ? null : marketCap(latest.priceSol, item.supplyUi ?? null),
    marketCapUsd: marketCap(latest.priceUsd, item.supplyUi ?? null),
    priceChangePctFromFirstTrade: metrics.firstPriceUsd && latest.priceUsd != null
      ? ((latest.priceUsd / metrics.firstPriceUsd) - 1) * 100 : null,
    pricingMethod: "owner_balance_delta_estimate", confidence: "low"
  });
  await recordDueSnapshots(item, Date.now());
  await persistState();
}

async function persistState() {
  await mkdir(DATA_DIR, { recursive: true });
  // Concurrent websocket callbacks may persist simultaneously; unique temp files prevent rename races.
  const tempPath = statePath + "." + randomUUID() + ".tmp";
  await writeFile(tempPath, JSON.stringify(state, null, 2));
  await rename(tempPath, statePath);
  markCollectorStateDirty();
}
async function appendTokenEvent(mint: string, event: Record<string, unknown>) {
  await mkdir(path.join(DATA_DIR, "tokens", mint), { recursive: true });
  await appendFile(path.join(DATA_DIR, "tokens", mint, "events.jsonl"), JSON.stringify(event) + "\n");
  markMintDirty(mint);
}
function getAccountKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key && typeof key === "object" && "pubkey" in key) return String((key as { pubkey: unknown }).pubkey);
  return String(key);
}
function pumpCreateInstructions(tx: ParsedTransactionWithMeta) {
  return findPumpCreateInstructions(
    tx.transaction.message.instructions as unknown as Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>,
    PUMP_PROGRAM.toBase58()
  );
}
function isCreateTransaction(tx: ParsedTransactionWithMeta): boolean {
  return pumpCreateInstructions(tx).length > 0;
}
function createdPumpMints(tx: ParsedTransactionWithMeta): string[] {
  return [...new Set(pumpCreateInstructions(tx).map(instruction => instruction.mint).filter(mint => mint && !INVALID_QUOTE_MINTS.has(mint)))];
}
async function isMintAccount(mint: string): Promise<boolean> {
  try {
    const info = await nextRpc().getAccountInfo(new PublicKey(mint), "confirmed");
    return Boolean(info && TOKEN_PROGRAMS.has(info.owner.toBase58()));
  } catch { return false; }
}
let transactionFetchTail: Promise<void> = Promise.resolve();
const transactionFetches = new Map<string, Promise<ParsedTransactionWithMeta | null>>();
let lastTransactionRequestAt = 0;
const TRANSACTION_REQUEST_INTERVAL_MS = Math.max(250, Number(process.env.HELIUS_TX_MIN_INTERVAL_MS ?? 350));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTransactionWithBackoff(signature: string): Promise<ParsedTransactionWithMeta | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, lastTransactionRequestAt + TRANSACTION_REQUEST_INTERVAL_MS - Date.now());
    if (wait) await sleep(wait);
    lastTransactionRequestAt = Date.now();
    try {
      const tx = await nextRpc().getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 as never });
      if (tx) return tx;
      lastError = new Error("RPC returned a null transaction");
      if (attempt < 2) await sleep(500 * (attempt + 1));
    } catch (error) {
      lastError = error;
      const rateLimited = /429|too many requests|rate.?limit/i.test(String(error));
      const delay = rateLimited ? Math.min(15_000, 1_000 * (2 ** attempt)) : Math.min(5_000, 400 * (attempt + 1));
      await sleep(delay);
    }
  }
  console.error("Transaction fetch exhausted retries; signature remains recoverable:", signature, String(lastError).slice(0, 180));
  return null;
}
function fetchTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
  const existing = transactionFetches.get(signature);
  if (existing) return existing;
  const request = transactionFetchTail.then(() => fetchTransactionWithBackoff(signature));
  transactionFetchTail = request.then(() => undefined, () => undefined);
  transactionFetches.set(signature, request);
  void request.finally(() => transactionFetches.delete(signature));
  return request;
}
async function captureMint(item: TokenState) {
  const { mint, expiresAt } = item;
  if (activeSubscriptions.has(mint) || expiresAt <= Date.now()) return;
  const connection = nextRpc();
  try {
    const id = connection.onLogs(new PublicKey(mint), async (logs: Logs, context) => {
      if (shuttingDown || logs.err) return;
      const observedAt = Date.now();
      if (observedAt > expiresAt) { await stopCapture(mint); return; }
      const tx = await fetchTransaction(logs.signature);
      const item = state.tokens[mint];
      if (tx && item) await processTradeMetrics(item, tx, logs.signature, context.slot);
      if (tx && item) await recordDueSnapshots(item, observedAt);
      await appendTokenEvent(mint, {
        schemaVersion: 2, kind: "token_activity", mint, observedAt, slot: context.slot,
        signature: logs.signature, err: logs.err, logs: logs.logs,
        transaction: tx ? {
          blockTime: tx.blockTime, fee: tx.meta?.fee, feeLamports: tx.meta?.fee,
          signatureCount: tx.transaction.signatures.length,
          baseSignatureFeeLamports: tx.transaction.signatures.length * 5_000,
          estimatedPriorityFeeLamports: Math.max(0, (tx.meta?.fee ?? 0) - tx.transaction.signatures.length * 5_000),
          computeUnitsConsumed: tx.meta?.computeUnitsConsumed,
          loadedAddresses: tx.meta?.loadedAddresses, err: tx.meta?.err,
          accountKeys: tx.transaction.message.accountKeys.map(k => getAccountKey(k)),
          preBalances: tx.meta?.preBalances, postBalances: tx.meta?.postBalances,
          preTokenBalances: tx.meta?.preTokenBalances, postTokenBalances: tx.meta?.postTokenBalances,
          innerInstructions: tx.meta?.innerInstructions, logMessages: tx.meta?.logMessages
        } : null
      });
    }, "confirmed");
    const [curveAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM
    );
    const curveId = connection.onAccountChange(curveAddress, (accountInfo, context) => {
      const current = state.tokens[mint];
      if (!shuttingDown && current && accountInfo.data) {
        void processCurveState(current, accountInfo.data, context.slot).catch(error =>
          console.error("Bonding-curve decode failed:", mint, String(error).slice(0, 160))
        );
      }
    }, "confirmed");
    void connection.getAccountInfo(curveAddress, "confirmed").then(info => {
      const current = state.tokens[mint];
      if (info && current) return processCurveState(current, info.data, 0);
      return undefined;
    }).catch(error => console.warn("Initial bonding-curve read failed:", mint, String(error).slice(0, 120)));
    const timer = setInterval(() => {
      const item = state.tokens[mint];
      if (item) void recordDueSnapshots(item, Date.now()).catch(error => console.error("Snapshot error:", String(error)));
    }, 1_000);
    activeSubscriptions.set(mint, { connection, id, curveId, timer });
    await persistState();
  } catch (error) { console.error("Could not subscribe to mint", mint, String(error)); }
}
async function stopCapture(mint: string) {
  const sub = activeSubscriptions.get(mint);
  if (sub) {
    if (sub.timer) clearInterval(sub.timer);
    try { await sub.connection.removeOnLogsListener(sub.id); } catch {}
    if (sub.curveId != null) { try { await sub.connection.removeAccountChangeListener(sub.curveId); } catch {} }
    activeSubscriptions.delete(mint);
  }
}
async function processLaunch(signature: string, slot: number, logs: string[], tx: ParsedTransactionWithMeta) {
  if (state.seenLaunchSignatures.includes(signature) || tx.meta?.err || !isCreateTransaction(tx)) return;
  const mints = createdPumpMints(tx);
  for (const mint of mints) {
    if (state.tokens[mint] || !await isMintAccount(mint)) continue;
    const feePayer = getAccountKey(tx.transaction.message.accountKeys[0]);
    const firstSeenAt = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    let supplyUi: number | null = null;
    let supplyDecimals: number | null = null;
    try {
      const supply = await nextRpc().getTokenSupply(new PublicKey(mint), "confirmed");
      supplyUi = supply.value.uiAmount;
      supplyDecimals = supply.value.decimals;
    } catch (error) { console.warn("Could not read token supply for", mint, String(error).slice(0, 120)); }
    const createInstruction = pumpCreateInstructions(tx).find(instruction => instruction.mint === mint);
    if (!createInstruction) continue;
    const item: TokenState = {
      mint, creator: null, launchSignature: signature, launchVerified: true, launchInstruction: createInstruction.kind, firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS,
      supplyUi, supplyDecimals
    };
    ensureMetrics(item);
    state.tokens[mint] = item;
    await appendTokenEvent(mint, {
      schemaVersion: 2, kind: "launch_detected", mint, feePayer,
      creator: null, creatorEvidence: "not decoded; fee payer is stored separately",
      totalSupply: supplyUi, supplyDecimals, supplySource: "Solana getTokenSupply",
      launchSignature: signature, launchSlot: slot, firstSeenAt,
      program: PUMP_PROGRAM.toBase58(), instruction: createInstruction.kind, launchVerification: "IDL discriminator + mint account owner", launchLogs: logs
    });
    await persistState();
    await captureMint(item);
    console.log("Verified Pump mint capture started:", mint, "fee payer:", feePayer);
  }
  state.seenLaunchSignatures.push(signature);
  if (state.seenLaunchSignatures.length > 20_000) state.seenLaunchSignatures = state.seenLaunchSignatures.slice(-10_000);
  await persistState();
}
async function handleLiveLaunch(signature: string, logs: Logs, slot: number) {
  if (!CREATE_LOG.test(logs.logs.join("\n")) || state.seenLaunchSignatures.includes(signature)) return;
  const tx = await fetchTransaction(signature);
  if (!tx) { console.warn("Will recover launch transaction during next reconciliation:", signature); return; }
  await processLaunch(signature, slot, logs.logs, tx);
}
async function reconcileMissedLaunches() {
  if (reconciliation) return reconciliation;
  reconciliation = (async () => {
    const connection = nextRpc();
    const head = (await connection.getSignaturesForAddress(PUMP_PROGRAM, { limit: 1 }, "confirmed"))[0];
    if (!head) return;
    if (!state.lastProgramSignature) {
      state.lastProgramSignature = head.signature;
      await persistState();
      console.log("Initialized resumable Pump history cursor at current chain head.");
      return;
    }
    if (!state.reconcileTarget) {
      state.reconcileTarget = head.signature;
      state.reconcileBefore = undefined;
      await persistState();
    }
    let pages = 0;
    let reachedCheckpoint = false;
    while (pages < MAX_RECONCILE_PAGES && !shuttingDown) {
      const options: { limit: number; before?: string; until?: string } = { limit: RECONCILE_PAGE_SIZE };
      if (state.reconcileBefore) options.before = state.reconcileBefore;
      options.until = state.lastProgramSignature;
      const signatures = await connection.getSignaturesForAddress(PUMP_PROGRAM, options, "confirmed");
      if (signatures.length === 0) { reachedCheckpoint = true; break; }
      const page = signatures.filter(s => s.signature !== state.lastProgramSignature);
      if (page.length === 0) { reachedCheckpoint = true; break; }
      // Process oldest first; checkpoint advances only after the entire page is fetched successfully.
      for (const item of [...page].reverse()) {
        const tx = await fetchTransaction(item.signature);
        if (!tx) throw new Error(`Could not fetch reconciliation transaction ${item.signature}; page cursor retained for retry.`);
        if (isCreateTransaction(tx) && !tx.meta?.err) await processLaunch(item.signature, item.slot, tx.meta?.logMessages ?? [], tx);
      }
      state.reconcileBefore = page[page.length - 1].signature;
      await persistState();
      pages++;
      if (page.length < RECONCILE_PAGE_SIZE) { reachedCheckpoint = true; break; }
    }
    if (reachedCheckpoint) {
      state.lastProgramSignature = state.reconcileTarget;
      state.reconcileTarget = undefined;
      state.reconcileBefore = undefined;
      await persistState();
      console.log("Resumable launch reconciliation reached the previous checkpoint.");
    } else {
      console.log("Reconciliation paused at a saved cursor; it will resume on the next run.");
    }
  })().catch(error => console.error("Launch reconciliation paused safely:", String(error).slice(0, 240))).finally(() => { reconciliation = undefined; });
  return reconciliation;
}
async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  await restoreCollectorState(statePath);
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as CollectorState;
    state.tokens ??= {};
    state.seenLaunchSignatures ??= [];
    // Remove known quote assets accidentally admitted by the previous balance-difference heuristic.
    for (const mint of INVALID_QUOTE_MINTS) delete state.tokens[mint];
  } catch (error) {
    console.error("Checkpoint is invalid; starting a clean state without deleting remote data:", String(error).slice(0, 160));
    state = { tokens: {}, seenLaunchSignatures: [] };
    await persistState();
  }
}
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Stopping collector:", reason);
  if (expiryTimer) clearInterval(expiryTimer);
  if (runTimer) clearTimeout(runTimer);
  if (discoverySubscription) {
    try { await discoverySubscription.connection.removeOnLogsListener(discoverySubscription.id); } catch {}
  }
  await Promise.all([...activeSubscriptions.keys()].map(stopCapture));
  if (reconciliation) await reconciliation;
  await persistState();
  await flushHuggingFaceUploads();
  console.log("Collector stopped.");
}
async function main() {
  await loadState();
  const activeTokens = Object.values(state.tokens).filter(item => item.expiresAt > Date.now() && !INVALID_QUOTE_MINTS.has(item.mint));
  await restoreTokenEvents(activeTokens.map(item => item.mint));
  for (const item of activeTokens) await captureMint(item);
  const discovery = new Connection(`https://mainnet.helius-rpc.com/?api-key=${keys[0]}`, "confirmed");
  const id = await discovery.onLogs(PUMP_PROGRAM, async (logs, context) => {
    if (shuttingDown || logs.err || !CREATE_LOG.test(logs.logs.join("\n"))) return;
    await handleLiveLaunch(logs.signature, logs, context.slot);
  }, "confirmed");
  discoverySubscription = { connection: discovery, id };
  console.log("Listening for Pump launches; collecting bonding-curve quote-asset prices (SOL/USDC/custom), market caps, transaction fee telemetry and trade evidence. API keys configured:", keys.length);
  void reconcileMissedLaunches();
  expiryTimer = setInterval(async () => {
    for (const item of Object.values(state.tokens)) if (item.expiresAt <= Date.now()) await stopCapture(item.mint);
  }, 15_000);
  if (RUN_FOR_MS > 0) runTimer = setTimeout(() => { void shutdown("configured run window complete"); }, RUN_FOR_MS);
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
main().catch(async error => { console.error(error); await shutdown("fatal error"); process.exitCode = 1; });
