import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Connection, PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveTradeObservations, marketCap } from "./metrics.js";
import { extractFundingSources, summarizeWalletCohorts, updateWalletProfile, type WalletProfile } from "./wallet-analytics.js";
import { findPumpCreateInstructions } from "./pump-instructions.js";
import { decodeProgramTradeEvents } from "./trade-events.js";
import { findStonkFunLaunchInstructions } from "./launchlab-instructions.js";
import { getTopLevelInstructions } from "./transaction-instructions.js";
import { decodeLaunchLabPoolState, decodePumpSwapPoolState, decodeRaydiumCpmmPoolState, decodeTokenAccountAmount, findLaunchLabCpmmMigration, findPumpSwapPoolFromInstructions, RAYDIUM_CPMM_PROGRAM } from "./pool-state.js";
import { flushHuggingFaceUploads, markCollectorStateDirty, markMintDirty, markQualityManifestDirty, quarantineRemoteMintFile, restoreCollectorState, restoreQualityManifest, restoreTokenEvents } from "./hf-uploader.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const LAUNCHLAB_PROGRAM = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const STONKFUN_PLATFORM_CONFIGS = new Set([
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"
]);
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const NON_TOKEN_MINTS = new Set([WRAPPED_SOL_MINT, USDC_MINT, USDT_MINT]);
const CREATE_LOG = /Program log: Instruction: Create(?:V2)?\s*$/im;
const STONK_LAUNCH_LOG = /Program log: Instruction: Initialize(?:V2|WithToken2022)?\s*$/im;
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const CAPTURE_MS = Number(process.env.CAPTURE_MINUTES ?? 10) * 60_000;
const RUN_FOR_MS = Number(process.env.RUN_FOR_MINUTES ?? 0) * 60_000;
const RECONCILE_PAGE_SIZE = 100;
const MAX_RECONCILE_PAGES = Number(process.env.MAX_RECONCILE_PAGES_PER_RUN ?? 20);
const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter((v): v is string => Boolean(v));
if (keys.length === 0) throw new Error("Set at least HELIUS_API_KEY_1 in your environment.");
if (keys.length !== 3) console.warn(`Only ${keys.length} Helius API key(s) configured; using available key(s).`);
const rpc = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
const RPC_MIN_INTERVAL_MS = Math.max(250, Number(process.env.HELIUS_RPC_MIN_INTERVAL_MS ?? process.env.HELIUS_TX_MIN_INTERVAL_MS ?? 350));
const rpcTails = new WeakMap<Connection, Promise<void>>();
const rpcLastStartedAt = new WeakMap<Connection, number>();
const RATE_LIMITED_RPC_METHODS = new Set([
  "getAccountInfo", "getParsedAccountInfo", "getTokenSupply", "getSignaturesForAddress",
  "getParsedTransaction", "getTransaction", "getMultipleAccountsInfo", "getProgramAccounts", "getTokenLargestAccounts",
  "onLogs", "onAccountChange"
]);
const rateLimitedConnections = new WeakMap<Connection, Connection>();
function rateLimitConnection(connection: Connection): Connection {
  const existing = rateLimitedConnections.get(connection);
  if (existing) return existing;
  const proxy = new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property !== "string" || !RATE_LIMITED_RPC_METHODS.has(property) || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const previous = rpcTails.get(target) ?? Promise.resolve();
        const request = previous.then(async () => {
          const wait = Math.max(0, (rpcLastStartedAt.get(target) ?? 0) + RPC_MIN_INTERVAL_MS - Date.now());
          if (wait) await new Promise(resolve => setTimeout(resolve, wait));
          let lastError: unknown;
          for (let attempt = 0; attempt < 4; attempt++) {
            rpcLastStartedAt.set(target, Date.now());
            try {
              return await (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
            } catch (error) {
              lastError = error;
              if (!/429|too many requests|rate.?limit/i.test(String(error)) || attempt === 3) throw error;
              const delay = Math.min(20_000, 1_000 * (2 ** attempt));
              console.warn("Helius RPC rate limited; backing off:", property, delay, "ms");
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
          throw lastError;
        });
        rpcTails.set(target, request.then(() => undefined, () => undefined));
        return request;
      };
    }
  });
  rateLimitedConnections.set(connection, proxy);
  return proxy;
}
let rpcCursor = 0;
const nextRpc = () => rateLimitConnection(rpc[(rpcCursor++) % rpc.length]);

type TokenMetrics = {
  tradeCount: number; buyCount: number; sellCount: number;
  buyVolumeQuote?: number; sellVolumeQuote?: number; netFlowQuote?: number;
  volumeSol: number; volumeUsd: number; volumeQuote: number; volumeSolAvailable?: boolean; volumeUsdAvailable?: boolean;
  launchlabReserveRatioQuote?: number | null; launchlabRealBase?: number | null; launchlabRealQuote?: number | null; launchlabPoolStatus?: string | null;
  uniqueBuyers: string[]; uniqueSellers: string[];
  firstPriceSol: number | null; firstPriceUsd: number | null;
  lastPriceSol: number | null; lastPriceUsd: number | null; lastPriceObservedAt: number | null;
  highPriceUsd: number | null; lowPriceUsd: number | null;
  highPriceQuote?: number | null; lowPriceQuote?: number | null;
  snapshotsRecorded: number[];
  maxDrawdownPct: number | null;
  timeToTargetsSeconds: Record<string, number | null>;
  largestBuySol: number;
  largestSellSol: number; largestBuyQuote: number; largestSellQuote: number;
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
  walletProfiles: Record<string, WalletProfile>;
  walletCohorts?: ReturnType<typeof summarizeWalletCohorts>;
  holderSnapshotsRecorded?: number[];
  exactTradeCount?: number; estimatedTradeCount?: number; processedFeeSignatures?: string[]; processedTradeSignatures?: string[]; historicalMetricsBackfillComplete?: boolean; historicalMetricsBackfillProcessedAt?: number; historicalMetricsBackfillSignatureCount?: number;
  networkFeesLamports?: number | null; networkFeeTransactions?: number; estimatedPriorityFeeLamports?: number | null; baseSignatureFeeLamports?: number | null; lastFeePayer?: string | null; walletNetworkFeesLamports?: Record<string, number>; venueTradeFeesQuote?: number | null; venueTradeFeesBase?: number | null; inputTransferFeesQuote?: number | null; outputTransferFeesQuote?: number | null; inputTransferFeesBase?: number | null; outputTransferFeesBase?: number | null; buyPriceImpactSamples?: number[]; sellPriceImpactSamples?: number[]; protocolFeesQuote?: number | null; platformFeesQuote?: number | null; creatorFeesQuote?: number | null; creatorFeesBase?: number | null; tradeFeesQuote?: number | null; tradeFeesBase?: number | null; shareFeesQuote?: number | null; lpFeesQuote?: number | null; cashbackFeesQuote?: number | null; buybackFeesQuote?: number | null;
};
type TokenState = {
  mint: string; creator: string | null; launchSignature: string; launchFeePayer?: string | null; launchSlot?: number;
  launchVerified?: boolean; launchInstruction?: "create" | "create_v2" | "initialize" | "initialize_v2" | "initialize_with_token_2022";
  venue?: "pumpfun" | "stonkfun"; quoteMint?: string; poolAddress?: string; pumpSwapPoolAddress?: string; cpmmPoolAddress?: string; lpLockVaultAddress?: string | null; lpLockLastCheckedAt?: number; lpLockLastAmountRaw?: string | null; lpLockLastOwner?: string | null; lpLockLastSharePct?: number | null; platformConfig?: string;
  firstSeenAt: number; expiresAt: number;
  supplyUi?: number | null; supplyDecimals?: number | null;
  mintAuthority?: string | null; freezeAuthority?: string | null; mintInitialized?: boolean | null; mintMetadataParsed?: boolean;
  tokenProgramOwner?: string | null; tokenExtensions?: Array<{ extension: string; state?: unknown }> | null;
  metrics?: TokenMetrics;
};
type CollectorState = {
  tokens: Record<string, TokenState>;
  seenLaunchSignatures: string[];
  lastProgramSignature?: string;
  reconcileTarget?: string;
  reconcileBefore?: string;
  lastLaunchLabSignature?: string;
  launchLabReconcileTarget?: string;
  launchLabReconcileBefore?: string;
  pendingActivity?: Record<string, Array<{ signature: string; slot: number; observedAt: number; logs: string[] }>>;
};
const statePath = path.join(DATA_DIR, "collector-state.json");
const qualityPath = path.join(DATA_DIR, "quality", "data-quality-manifest.json");
let qualityManifest: { schemaVersion: number; generatedAt: number; rules: string[]; quarantinedMints: Record<string, Record<string, unknown>> } = {
  schemaVersion: 1, generatedAt: Date.now(), rules: [
    "Only launch records whose top-level Pump instruction data matches the official create/create_v2 discriminator and whose first instruction account is a token mint are eligible.",
    "StonkFun launches require a LaunchLab initializer discriminator, the LaunchLab program ID, a known StonkFun platform-config account and a verified token-mint owner.",
    "A mint directory listed in quarantinedMints is excluded from strategy research; raw evidence is retained for audit.",
    "Wallet-balance-delta trade estimates are low confidence and are not execution prices or exact volumes."
  ], quarantinedMints: {}
};
let state: CollectorState = { tokens: {}, seenLaunchSignatures: [] };
const activeSubscriptions = new Map<string, { connection: Connection; id: number; curveId?: number; ammIds?: number[]; ammPoolAddress?: string; timer?: NodeJS.Timeout }>();
const pumpSwapSubscriptionPending = new Set<string>();
const activitySignatures = new Map<string, Set<string>>();
let discoverySubscription: { connection: Connection; id: number } | undefined;
let stonkDiscoverySubscription: { connection: Connection; id: number } | undefined;
let expiryTimer: NodeJS.Timeout | undefined;
let pendingRetryTimer: NodeJS.Timeout | undefined;
let quarantineRetryTimer: NodeJS.Timeout | undefined;
let retryingPendingActivity = false;
let runTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let reconciliation: Promise<void> | undefined;
let stonkReconciliation: Promise<void> | undefined;

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
  const metrics = item.metrics ??= {
    tradeCount: 0, buyCount: 0, sellCount: 0, buyVolumeQuote: 0, sellVolumeQuote: 0, netFlowQuote: 0, volumeSol: 0, volumeUsd: 0, volumeQuote: 0,
    uniqueBuyers: [], uniqueSellers: [], firstPriceSol: null, firstPriceUsd: null,
    lastPriceSol: null, lastPriceUsd: null, lastPriceObservedAt: null, highPriceUsd: null, lowPriceUsd: null, highPriceQuote: null, lowPriceQuote: null,
    snapshotsRecorded: [], maxDrawdownPct: null,
    timeToTargetsSeconds: { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null },
    largestBuySol: 0, largestSellSol: 0, largestBuyQuote: 0, largestSellQuote: 0,
    walletProfiles: {}, holderSnapshotsRecorded: []
  };
  // Upgrade checkpoint metrics written by earlier schema versions without losing accumulated values.
  metrics.volumeSol = Number.isFinite(metrics.volumeSol) ? metrics.volumeSol : 0;
  metrics.volumeUsd = Number.isFinite(metrics.volumeUsd) ? metrics.volumeUsd : 0;
  metrics.volumeSolAvailable ??= false;
  metrics.volumeUsdAvailable ??= false;
  metrics.volumeQuote = Number.isFinite(metrics.volumeQuote) ? metrics.volumeQuote : 0;
  metrics.largestBuySol = Number.isFinite(metrics.largestBuySol) ? metrics.largestBuySol : 0;
  metrics.largestSellSol = Number.isFinite(metrics.largestSellSol) ? metrics.largestSellSol : 0;
  metrics.largestBuyQuote = Number.isFinite(metrics.largestBuyQuote) ? metrics.largestBuyQuote : 0;
  metrics.largestSellQuote = Number.isFinite(metrics.largestSellQuote) ? metrics.largestSellQuote : 0;
  metrics.buyVolumeQuote ??= 0; metrics.sellVolumeQuote ??= 0; metrics.netFlowQuote ??= 0;
  metrics.uniqueBuyers ??= [];
  metrics.uniqueSellers ??= [];
  metrics.walletProfiles ??= {};
  metrics.holderSnapshotsRecorded ??= [];
  metrics.exactTradeCount ??= 0; metrics.estimatedTradeCount ??= 0; metrics.processedFeeSignatures ??= []; metrics.processedTradeSignatures ??= [];
  metrics.networkFeesLamports ??= null; metrics.networkFeeTransactions ??= 0; metrics.venueTradeFeesQuote ??= null; metrics.venueTradeFeesBase ??= null; metrics.inputTransferFeesQuote ??= null; metrics.outputTransferFeesQuote ??= null; metrics.inputTransferFeesBase ??= null; metrics.outputTransferFeesBase ??= null; metrics.buyPriceImpactSamples ??= []; metrics.sellPriceImpactSamples ??= []; metrics.estimatedPriorityFeeLamports ??= null; metrics.baseSignatureFeeLamports ??= null; metrics.lastFeePayer ??= null; metrics.walletNetworkFeesLamports ??= {}; metrics.protocolFeesQuote ??= null; metrics.platformFeesQuote ??= null; metrics.creatorFeesQuote ??= null; metrics.creatorFeesBase ??= null; metrics.tradeFeesQuote ??= null; metrics.tradeFeesBase ??= null; metrics.shareFeesQuote ??= null;
  metrics.lpFeesQuote ??= null; metrics.cashbackFeesQuote ??= null; metrics.buybackFeesQuote ??= null;
  metrics.snapshotsRecorded ??= [];
  metrics.timeToTargetsSeconds ??= { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null };
  return metrics;
}
const SNAPSHOT_SECONDS = [5, 10, 15, 30, 60, 120, 300, 600];

type PumpCurveState = {
  creator: string | null; quoteMint: string | null; complete: boolean;
  virtualTokenRaw: bigint; virtualSolLamports: bigint;
  realTokenRaw: bigint; realSolLamports: bigint; totalSupplyRaw: bigint;
  creatorFeeBps: bigint | null; isHolderReward: boolean | null;
  creatorFeeAccruedRaw: bigint | null; protocolFeesAccruedRaw: bigint | null;
  isMayhemMode: boolean | null; isCashbackCoin: boolean | null;
  canEditCreatorFee: boolean | null; curveDepth: number | null; initialVirtualQuoteReservesRaw: bigint | null;
  postCompleteBaseOutRaw: bigint | null; postCompleteQuoteInRaw: bigint | null;
};
function decodePumpCurve(data: Buffer): PumpCurveState | null {
  // Anchor account: discriminator + five u64 reserves/supply + bool + creator.
  if (data.length < 49 || !data.subarray(0, 8).equals(Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]))) return null;
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
    protocolFeesAccruedRaw: data.length >= 141 ? data.readBigUInt64LE(133) : null,
    canEditCreatorFee: data.length >= 124 ? data[123] === 1 : null,
    curveDepth: data.length >= 142 ? data[141] : null,
    initialVirtualQuoteReservesRaw: data.length >= 150 ? data.readBigUInt64LE(142) : null,
    postCompleteBaseOutRaw: data.length >= 158 ? data.readBigUInt64LE(150) : null,
    postCompleteQuoteInRaw: data.length >= 166 ? data.readBigUInt64LE(158) : null
  };
}
async function processCurveState(item: TokenState, data: Buffer, slot: number) {
  const curve = decodePumpCurve(data);
  if (!curve) return;
  if (curve.complete && ensureMetrics(item).priceSource === "pumpswap_pool_vault_reserves_plus_virtual_quote") return;
  // The default pubkey means SOL; a populated quote_mint means an SPL quote asset.
  const quoteMint = curve.quoteMint ?? WRAPPED_SOL_MINT;
  const quoteDecimals = await getMintDecimals(quoteMint);
  if (quoteDecimals == null) {
    await appendTokenEvent(item.mint, { schemaVersion: 4, kind: "curve_state", mint: item.mint, slot, quoteMint, pricingAvailable: false, reason: "Could not resolve quote mint decimals." });
    return;
  }
  const decimals = item.supplyDecimals ?? 6;
  if (item.supplyDecimals == null || !Number.isInteger(item.supplyDecimals) || item.supplyDecimals < 0 || item.supplyDecimals > 18) {
    await appendTokenEvent(item.mint, { schemaVersion: 4, kind: "curve_state", mint: item.mint, slot, quoteMint, pricingAvailable: false, reason: "Token decimals are not verified; refusing to assume six decimals." });
    return;
  }
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
  metrics.volumeSolAvailable = isSol;
  metrics.volumeUsdAvailable = isUsdc || isUsdt || (isSol && solUsd != null);
  item.supplyUi = supply;
  if (metrics.priceSource !== "pump_bonding_curve_virtual_reserves" || metrics.quoteMint !== quoteMint) {
    metrics.firstPriceSol = priceSol; metrics.firstPriceUsd = priceUsd; metrics.firstPriceQuote = priceQuote;
    metrics.quoteMint = quoteMint; metrics.quoteSymbol = quoteSymbol; metrics.quoteDecimals = quoteDecimals;
    metrics.timeToTargetsSeconds = { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null };
    metrics.highPriceUsd = priceUsd; metrics.lowPriceUsd = priceUsd; metrics.highPriceQuote = priceQuote; metrics.lowPriceQuote = priceQuote; metrics.maxDrawdownPct = null;
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
  }
  // Percentage drawdown and multiples are quote-currency invariant, so custom SPL pairs are measured too.
  metrics.highPriceQuote = metrics.highPriceQuote == null ? priceQuote : Math.max(metrics.highPriceQuote, priceQuote);
  metrics.lowPriceQuote = metrics.lowPriceQuote == null ? priceQuote : Math.min(metrics.lowPriceQuote, priceQuote);
  const drawdown = metrics.highPriceQuote > 0 ? ((priceQuote / metrics.highPriceQuote) - 1) * 100 : 0;
  metrics.maxDrawdownPct = Math.min(metrics.maxDrawdownPct ?? 0, drawdown);
  const multiple = metrics.firstPriceQuote && metrics.firstPriceQuote > 0 ? priceQuote / metrics.firstPriceQuote : 1;
  const elapsed = Math.max(0, (Date.now() - item.firstSeenAt) / 1000);
  for (const [target, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2]] as const) {
    if (multiple >= threshold && metrics.timeToTargetsSeconds[target] == null) metrics.timeToTargetsSeconds[target] = elapsed;
  }
  if (curve.creator && item.creator !== curve.creator) { item.creator = curve.creator; refreshWalletCohorts(item); await persistState(); }
  await appendTokenEvent(item.mint, {
    schemaVersion: 4, kind: "curve_state", mint: item.mint, slot, observedAt: Date.now(),
    creator: curve.creator, quoteMint, quoteSymbol, quoteDecimals, complete: curve.complete,
    isMayhemMode: curve.isMayhemMode, isCashbackCoin: curve.isCashbackCoin,
    isHolderReward: curve.isHolderReward, canEditCreatorFee: curve.canEditCreatorFee, curveDepth: curve.curveDepth,
    initialVirtualQuoteReservesRaw: curve.initialVirtualQuoteReservesRaw?.toString() ?? null,
    postCompleteBaseOutRaw: curve.postCompleteBaseOutRaw?.toString() ?? null, postCompleteQuoteInRaw: curve.postCompleteQuoteInRaw?.toString() ?? null,
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
    marketCapUsd: marketCap(priceUsd, supply), marketCapBasis: "total_supply_fdv", pricingMethod: "pump_bonding_curve_virtual_reserves",
    // Published bonding-curve schedule: 0.95% protocol + 0.30% creator = 1.25%.
    // Custom-pair Holder Rewards can override the creator component; exact event values take precedence.
    estimatedProtocolFeeBps: 95,
    configuredCreatorFeeBps: curve.creatorFeeBps?.toString() ?? null,
    estimatedCreatorFeeBps: curve.isHolderReward ? null : (isSol || isUsdc ? 30 : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? Number(curve.creatorFeeBps) : 30),
    estimatedTotalCurveFeeBps: curve.isHolderReward ? null : 95 + (isSol || isUsdc ? 30 : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? Number(curve.creatorFeeBps) : 30),
    feeRateSource: curve.isHolderReward ? "holder_rewards_rate_not_yet_decoded" : isSol || isUsdc ? "published_sol_usdc_bonding_curve_schedule" : curve.creatorFeeBps != null && curve.creatorFeeBps > 0n ? "bonding_curve_account_creator_fee_bps_plus_published_protocol_rate" : "published_custom_pair_schedule",
    feeIsEstimateNotExecution: true,
    creatorFeeMayBeOverriddenByHolderRewards: true,
    realTokenReservesUi: realToken, highPriceQuote: metrics.highPriceQuote, lowPriceQuote: metrics.lowPriceQuote, maxDrawdownPct: metrics.maxDrawdownPct,
    timeToTargetsSeconds: metrics.timeToTargetsSeconds
  });
  await recordDueSnapshots(item, Date.now());
  await persistState();
}
async function recordHolderDistributionSnapshot(item: TokenState, elapsedSeconds: number, slot: number | null) {
  if (item.supplyUi == null || item.supplyUi <= 0) return false;
  const connection = nextRpc();
  const largest = await connection.getTokenLargestAccounts(new PublicKey(item.mint), "confirmed");
  const addresses = largest.value.map(entry => entry.address);
  if (addresses.length === 0) return false;
  const accounts = await connection.getMultipleAccountsInfo(addresses, "confirmed");
  const excluded = new Set<string>();
  const excludedOwners = new Set<string>();
  if (item.poolAddress) {
    excludedOwners.add(item.poolAddress);
    try {
      const info = await connection.getAccountInfo(new PublicKey(item.poolAddress), "confirmed");
      if (info) {
        const decoded = decodeLaunchLabPoolState(info.data);
        if (decoded) { excluded.add(decoded.baseVault); excluded.add(decoded.quoteVault); }
      }
    } catch {}
  }
  if (item.venue === "pumpfun") {
    try {
      const [curveAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(item.mint).toBuffer()], PUMP_PROGRAM
      );
      excludedOwners.add(curveAddress.toBase58());
    } catch {}
  }
  if (item.pumpSwapPoolAddress) {
    excludedOwners.add(item.pumpSwapPoolAddress);
    try {
      const info = await connection.getAccountInfo(new PublicKey(item.pumpSwapPoolAddress), "confirmed");
      if (info) {
        const decoded = decodePumpSwapPoolState(info.data);
        if (decoded) { excluded.add(decoded.baseVault); excluded.add(decoded.quoteVault); }
      }
    } catch {}
  }
  const holders = largest.value.flatMap((entry, index) => {
    const account = accounts[index];
    if (!account || account.data.length < 64) return [];
    const address = entry.address.toBase58();
    const owner = new PublicKey(account.data.subarray(32, 64)).toBase58();
    const amount = Number(entry.amount) / (10 ** item.supplyDecimals!);
    if (!Number.isFinite(amount) || amount < 0) return [];
    const isPoolVault = excluded.has(address) || excludedOwners.has(owner);
    return [{ tokenAccount: address, owner, amount, sharePct: amount / item.supplyUi! * 100, isPoolVault }];
  });
  const circulatingCandidates = holders.filter(holder => !holder.isPoolVault);
  const sorted = [...circulatingCandidates].sort((a, b) => b.amount - a.amount);
  const ownerTotals = new Map<string, number>();
  for (const holder of sorted) ownerTotals.set(holder.owner, (ownerTotals.get(holder.owner) ?? 0) + holder.amount);
  const walletHolders = [...ownerTotals.entries()].map(([owner, amount]) => ({
    owner, amount, sharePct: amount / item.supplyUi! * 100
  })).sort((a, b) => b.amount - a.amount);
  const walletShare = (count: number) => walletHolders.slice(0, count).reduce((sum, holder) => sum + holder.sharePct, 0);
  const accountShare = (count: number) => sorted.slice(0, count).reduce((sum, holder) => sum + holder.sharePct, 0);
  const creatorHolding = item.creator ? ownerTotals.has(item.creator) ? ownerTotals.get(item.creator)! / item.supplyUi * 100 : 0 : null;
  const feePayerHolding = item.launchFeePayer ? ownerTotals.has(item.launchFeePayer) ? ownerTotals.get(item.launchFeePayer)! / item.supplyUi * 100 : 0 : null;
  await appendTokenEvent(item.mint, {
    schemaVersion: 7, kind: "holder_distribution_snapshot", mint: item.mint, slot, elapsedSeconds, observedAt: Date.now(),
    holderScope: "top_20_token_accounts_from_getTokenLargestAccounts_aggregated_by_owner",
    holderCountReturned: holders.length, holderCountAfterPoolVaultExclusion: sorted.length,
    uniqueWalletOwnersInTop20: walletHolders.length,
    excludedPoolVaultCount: holders.filter(holder => holder.isPoolVault).length,
    largestHolderSharePct: walletHolders[0]?.sharePct ?? null,
    top5HolderSharePct: walletShare(5), top10HolderSharePct: walletShare(10), top20HolderSharePct: walletShare(20),
    top5AccountSharePct: accountShare(5), top10AccountSharePct: accountShare(10), top20AccountSharePct: accountShare(20),
    creatorShareInTop20Pct: creatorHolding, launchFeePayerShareInTop20Pct: feePayerHolding,
    wallets: walletHolders.map(holder => ({ ...holder, role: holder.owner === item.creator ? "creator" : holder.owner === item.launchFeePayer ? "launch_fee_payer" : "holder" })),
    holders: sorted.map(holder => ({ ...holder, role: holder.owner === item.creator ? "creator" : holder.owner === item.launchFeePayer ? "launch_fee_payer" : "holder" })),
    excludesKnownPoolVaults: true, concentrationIsTop20Only: true,
    note: "Top 20 token accounts only, aggregated by wallet owner for wallet concentration; accounts outside the top 20 and off-token-account custody are not included."
  });
  return true;
}
async function recordDueSnapshots(item: TokenState, observedAt: number, skipHolderSnapshots = false) {
  const metrics = ensureMetrics(item);
  const isStonkFun = item.venue === "stonkfun";
  const hasPrimaryPrice = metrics.priceSource === "pump_bonding_curve_virtual_reserves" || metrics.priceSource === "pumpswap_pool_vault_reserves_plus_virtual_quote" || metrics.priceSource === "raydium_cpmm_vault_reserves" || metrics.priceSource === "decoded_program_trade_event";
  if (!hasPrimaryPrice && !isStonkFun && item.supplyUi == null) return;
  const elapsedSeconds = Math.max(0, (observedAt - item.firstSeenAt) / 1000);
  metrics.walletCohorts = summarizeWalletCohorts(metrics.walletProfiles, metrics.lastPriceQuote);
  metrics.holderSnapshotsRecorded ??= [];
  for (const seconds of SNAPSHOT_SECONDS) {
    if (elapsedSeconds < seconds) continue;
    if (!metrics.snapshotsRecorded.includes(seconds) && (hasPrimaryPrice || isStonkFun)) {
      const priceSol = hasPrimaryPrice ? metrics.lastPriceSol : null;
      const priceUsd = hasPrimaryPrice ? metrics.lastPriceUsd : null;
      const supply = item.supplyUi ?? null;
      const marketCapSol = marketCap(priceSol, supply);
      const marketCapUsd = marketCap(priceUsd, supply);
      const priceChangePct = metrics.firstPriceQuote && metrics.lastPriceQuote != null
        ? ((metrics.lastPriceQuote / metrics.firstPriceQuote) - 1) * 100 : null;
      const isStonkReferenceOnly = isStonkFun && metrics.priceSource !== "decoded_program_trade_event" && metrics.priceSource !== "raydium_cpmm_vault_reserves";
      await appendTokenEvent(item.mint, {
        schemaVersion: 7, kind: "market_snapshot", mint: item.mint,
        elapsedSeconds: seconds, observedAt, priceSol, priceUsd,
        priceQuote: isStonkReferenceOnly ? null : metrics.lastPriceQuote ?? null,
        ownerBalancePriceQuoteEstimate: isStonkReferenceOnly && metrics.priceSource === "owner_balance_delta_estimate" ? metrics.lastPriceQuote ?? null : null,
        reserveRatioQuotePerBase: isStonkFun ? metrics.launchlabReserveRatioQuote ?? null : null,
        reserveRatioIsSpotPrice: false,
        quoteMint: metrics.quoteMint ?? null,
        quoteSymbol: metrics.quoteSymbol ?? null, quoteDecimals: metrics.quoteDecimals ?? null,
        pricingMethod: isStonkReferenceOnly ? "launchlab_pool_reserve_ratio_reference_only" : metrics.priceSource,
        marketCapSol, marketCapUsd, marketCapQuote: isStonkReferenceOnly ? null : marketCap(metrics.lastPriceQuote ?? null, supply),
        marketCapBasis: "total_supply_fdv", totalSupply: supply,
        priceChangePctFromFirstObservedPrice: isStonkReferenceOnly ? null : priceChangePct,
        launchlabRealBase: isStonkFun ? metrics.launchlabRealBase ?? null : null,
        launchlabRealQuote: isStonkFun ? metrics.launchlabRealQuote ?? null : null,
        launchlabPoolStatus: isStonkFun ? metrics.launchlabPoolStatus ?? null : null,
        tradeCount: metrics.tradeCount, buyCount: metrics.buyCount, sellCount: metrics.sellCount,
        buyVolumeQuote: metrics.buyVolumeQuote, sellVolumeQuote: metrics.sellVolumeQuote, netFlowQuote: metrics.netFlowQuote,
        buySellVolumeRatio: (metrics.sellVolumeQuote ?? 0) > 0 ? (metrics.buyVolumeQuote ?? 0) / (metrics.sellVolumeQuote ?? 0) : null,
        averageBuySizeQuote: metrics.buyCount > 0 ? (metrics.buyVolumeQuote ?? 0) / metrics.buyCount : null,
        averageSellSizeQuote: metrics.sellCount > 0 ? (metrics.sellVolumeQuote ?? 0) / metrics.sellCount : null,
        volumeSol: metrics.volumeSolAvailable ? metrics.volumeSol : null,
        volumeUsd: metrics.volumeUsdAvailable ? metrics.volumeUsd : null, volumeQuote: metrics.volumeQuote,
        tradeCountIsEstimate: (metrics.estimatedTradeCount ?? 0) > 0,
    exactTradeCount: metrics.exactTradeCount ?? 0, estimatedTradeCount: metrics.estimatedTradeCount ?? 0,
    tradeCountDefinition: "decoded_program_events_preferred_owner_balance_delta_fallback",
        maxDrawdownPct: metrics.maxDrawdownPct, timeToTargetsSeconds: metrics.timeToTargetsSeconds,
        largestBuySol: metrics.largestBuySol, largestSellSol: metrics.largestSellSol,
        largestBuyQuote: metrics.largestBuyQuote, largestSellQuote: metrics.largestSellQuote,
        uniqueBuyers: metrics.uniqueBuyers.length, uniqueSellers: metrics.uniqueSellers.length,
        walletCohorts: metrics.walletCohorts ?? summarizeWalletCohorts(metrics.walletProfiles, metrics.lastPriceQuote),
        networkFeesLamports: metrics.networkFeesLamports,
        networkFeeTransactions: metrics.networkFeeTransactions ?? 0,
        estimatedPriorityFeeLamports: metrics.estimatedPriorityFeeLamports,
        baseSignatureFeeLamports: metrics.baseSignatureFeeLamports,
        lastFeePayer: metrics.lastFeePayer ?? null,
        walletNetworkFeesLamports: metrics.walletNetworkFeesLamports ?? {},
        launchFeePayerNetworkFeesLamports: item.launchFeePayer ? metrics.walletNetworkFeesLamports?.[item.launchFeePayer] ?? 0 : null,
        creatorNetworkFeesLamports: item.creator ? metrics.walletNetworkFeesLamports?.[item.creator] ?? 0 : null,
        protocolFeesQuote: metrics.protocolFeesQuote, platformFeesQuote: metrics.platformFeesQuote,
        creatorFeesQuote: metrics.creatorFeesQuote, creatorFeesBase: metrics.creatorFeesBase,
        tradeFeesQuote: metrics.tradeFeesQuote, tradeFeesBase: metrics.tradeFeesBase,
        shareFeesQuote: metrics.shareFeesQuote, lpFeesQuote: metrics.lpFeesQuote, cashbackFeesQuote: metrics.cashbackFeesQuote,
        buybackFeesQuote: metrics.buybackFeesQuote,
        venueTradeFeesQuote: metrics.venueTradeFeesQuote, venueTradeFeesBase: metrics.venueTradeFeesBase,
        inputTransferFeesQuote: metrics.inputTransferFeesQuote, outputTransferFeesQuote: metrics.outputTransferFeesQuote,
        inputTransferFeesBase: metrics.inputTransferFeesBase, outputTransferFeesBase: metrics.outputTransferFeesBase,
        avgBuyPriceImpactPct: metrics.buyPriceImpactSamples?.length ? metrics.buyPriceImpactSamples.reduce((a, b) => a + b, 0) / metrics.buyPriceImpactSamples.length : null,
        avgSellPriceImpactPct: metrics.sellPriceImpactSamples?.length ? metrics.sellPriceImpactSamples.reduce((a, b) => a + b, 0) / metrics.sellPriceImpactSamples.length : null,
        maxBuyPriceImpactPct: metrics.buyPriceImpactSamples?.length ? Math.max(...metrics.buyPriceImpactSamples) : null,
        maxSellPriceImpactPct: metrics.sellPriceImpactSamples?.length ? Math.max(...metrics.sellPriceImpactSamples) : null,
        priceIsStale: metrics.lastPriceObservedAt == null || observedAt - metrics.lastPriceObservedAt > 5_000,
        curveComplete: metrics.curveComplete ?? null,
        curveRealSolReserves: metrics.curveRealSolReserves ?? null,
        curveRealQuoteReserves: metrics.curveRealQuoteReserves ?? null,
        curveVirtualQuoteReserves: metrics.curveVirtualQuoteReserves ?? null,
        curveRealTokenReserves: metrics.curveRealTokenReserves ?? null
      });
      metrics.snapshotsRecorded.push(seconds);
      await persistState();
    }
    if (!skipHolderSnapshots && !metrics.holderSnapshotsRecorded.includes(seconds)) {
      try {
        const recorded = await recordHolderDistributionSnapshot(item, seconds, null);
        if (recorded) {
          metrics.holderSnapshotsRecorded.push(seconds);
          await persistState();
        }
      } catch (error) {
        console.warn("Holder distribution snapshot failed; will retry:", item.mint, seconds, String(error).slice(0, 140));
      }
    }
  }
}
function refreshWalletCohorts(item: TokenState) {
  const metrics = ensureMetrics(item);
  for (const profile of Object.values(metrics.walletProfiles)) {
    profile.creator = profile.wallet === item.creator;
    profile.launchFeePayer = profile.wallet === item.launchFeePayer;
  }
  metrics.walletCohorts = summarizeWalletCohorts(metrics.walletProfiles, metrics.lastPriceQuote ?? null);
}
async function recordTransactionFeeMetrics(item: TokenState, tx: ParsedTransactionWithMeta, signature: string, slot: number) {
  const metrics = ensureMetrics(item);
  if (metrics.processedFeeSignatures!.includes(signature)) return;
  const fee = tx.meta?.fee;
  if (typeof fee !== "number" || !Number.isFinite(fee)) return;
  const feePayer = feePayerForTrade(tx);
  const message = tx.transaction.message as unknown as { header?: { numRequiredSignatures?: number } };
  const signerCount = message.header?.numRequiredSignatures ?? 1;
  const baseSignatureFeeLamports = Math.min(fee, signerCount * 5_000);
  const estimatedPriorityFeeLamports = Math.max(0, fee - baseSignatureFeeLamports);
  metrics.networkFeesLamports = (metrics.networkFeesLamports ?? 0) + fee;
  metrics.networkFeeTransactions = (metrics.networkFeeTransactions ?? 0) + 1;
  metrics.baseSignatureFeeLamports = (metrics.baseSignatureFeeLamports ?? 0) + baseSignatureFeeLamports;
  metrics.estimatedPriorityFeeLamports = (metrics.estimatedPriorityFeeLamports ?? 0) + estimatedPriorityFeeLamports;
  metrics.lastFeePayer = feePayer;
  if (feePayer) metrics.walletNetworkFeesLamports![feePayer] = (metrics.walletNetworkFeesLamports![feePayer] ?? 0) + fee;
  metrics.processedFeeSignatures!.push(signature);
  if (metrics.processedFeeSignatures!.length > 20_000) metrics.processedFeeSignatures = metrics.processedFeeSignatures!.slice(-10_000);
  await appendTokenEvent(item.mint, {
    schemaVersion: 1, kind: "transaction_fee", mint: item.mint, signature, slot, blockTime: tx.blockTime,
    feePayer, networkFeeLamports: fee, signerCount, baseSignatureFeeLamports,
    estimatedPriorityFeeLamports, computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    transactionFailed: tx.meta?.err != null, transactionError: tx.meta?.err ?? null,
    feeModelNote: "Base signature fee is estimated at 5000 lamports per required signer; remainder is an estimated priority fee and may include other fee components."
  });
}
async function processTradeMetrics(item: TokenState, tx: ParsedTransactionWithMeta, signature: string, slot: number, allowEstimated = true, historicalReplay = false) {
  const allInstructions = allTransactionInstructions(tx);
  let migrationDetected = false;
  if (item.venue === "stonkfun") {
    const migration = findLaunchLabCpmmMigration(allInstructions, item.mint);
    if (migration) {
      migrationDetected = true;
      item.cpmmPoolAddress = migration.pool;
      item.lpLockVaultAddress = migration.lockLpVault;
      item.quoteMint = migration.quoteMint;
      const metrics = ensureMetrics(item);
      metrics.quoteMint = migration.quoteMint;
      const decimals = await getMintDecimals(migration.quoteMint);
      if (decimals != null) metrics.quoteDecimals = decimals;
      await persistState();
      void subscribeRaydiumCpmmPool(item, migration.pool);
    }
  }
  if (item.venue === "pumpfun") {
    const poolDiscovery = findPumpSwapPoolFromInstructions(allInstructions, item.mint);
    if (poolDiscovery && (!item.quoteMint || item.quoteMint === poolDiscovery.quoteMint)) {
      if (item.pumpSwapPoolAddress !== poolDiscovery.pool) item.pumpSwapPoolAddress = poolDiscovery.pool;
      if (!item.quoteMint) {
        item.quoteMint = poolDiscovery.quoteMint;
        const decimals = await getMintDecimals(poolDiscovery.quoteMint);
        if (decimals != null) {
          const metrics = ensureMetrics(item);
          metrics.quoteMint = poolDiscovery.quoteMint;
          metrics.quoteDecimals = decimals;
          metrics.quoteSymbol = poolDiscovery.quoteMint === WRAPPED_SOL_MINT ? "SOL" : poolDiscovery.quoteMint === USDC_MINT ? "USDC" : poolDiscovery.quoteMint === USDT_MINT ? "USDT" : "UNKNOWN_SPL";
        }
      }
      await persistState();
      void subscribePumpSwapPool(item, poolDiscovery.pool);
    }
  }
  const metrics = ensureMetrics(item);
  await recordTransactionFeeMetrics(item, tx, signature, slot);
  if (metrics.processedTradeSignatures!.includes(signature)) return;
  const solUsd = await getSolUsd();
  const knownQuoteMint = item.quoteMint ?? metrics.quoteMint;
  const decodedEvents = decodeProgramTradeEvents(tx.meta?.logMessages, item.mint, allInstructions);
  const observations: import("./metrics.js").TradeObservation[] = [];
  if (decodedEvents.length > 0 && item.supplyDecimals != null) {
    for (const event of decodedEvents) {
      const quoteMint = event.venue === "pumpswap" ? (knownQuoteMint ?? event.quoteMint) : event.quoteMint;
      const quoteDecimals = await getMintDecimals(quoteMint);
      if (quoteDecimals == null) continue;
      const tokenAmount = Number(event.tokenAmountRaw) / (10 ** item.supplyDecimals);
      const quoteAmount = Number(event.quoteAmountRaw) / (10 ** quoteDecimals);
      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || !Number.isFinite(quoteAmount) || quoteAmount <= 0) continue;
      const priceQuote = quoteAmount / tokenAmount;
      const isSol = quoteMint === WRAPPED_SOL_MINT;
      const isStable = quoteMint === USDC_MINT || quoteMint === USDT_MINT;
      const quoteUsd = isSol ? solUsd : isStable ? 1 : null;
      if (event.creator && item.creator !== event.creator) item.creator = event.creator;
      if (item.quoteMint == null) item.quoteMint = quoteMint;
      metrics.quoteMint = quoteMint;
      metrics.quoteDecimals = quoteDecimals;
      metrics.quoteSymbol = isSol ? "SOL" : quoteMint === USDC_MINT ? "USDC" : quoteMint === USDT_MINT ? "USDT" : "UNKNOWN_SPL";
      metrics.volumeSolAvailable = isSol;
      metrics.volumeUsdAvailable = quoteUsd != null;
      const preBase = event.preTradeBaseReserveRaw != null ? Number(event.preTradeBaseReserveRaw) / (10 ** item.supplyDecimals) : null;
      const preQuote = event.preTradeQuoteReserveRaw != null ? Number(event.preTradeQuoteReserveRaw) / (10 ** quoteDecimals) : null;
      const preTradeSpotPriceQuote = preBase != null && preBase > 0 && preQuote != null && preQuote > 0 ? preQuote / preBase : null;
      const priceImpactPct = preTradeSpotPriceQuote != null ? (event.side === "buy" ? (priceQuote / preTradeSpotPriceQuote - 1) * 100 : (preTradeSpotPriceQuote / priceQuote - 1) * 100) : null;
      const feeUi = (raw: bigint | null) => raw == null ? null : Number(raw) / (10 ** quoteDecimals);
      const baseFeeUi = (raw: bigint | null) => raw == null || item.supplyDecimals == null ? null : Number(raw) / (10 ** item.supplyDecimals);
      observations.push({
        wallet: event.user, side: event.side, tokenAmount, quoteMint, quoteAmount, priceQuote,
        solAmount: isSol ? quoteAmount : 0, priceSol: isSol ? priceQuote : null,
        priceUsd: quoteUsd == null ? null : priceQuote * quoteUsd,
        feeLamports: tx.meta?.fee ?? 0, pricingMethod: "decoded_program_trade_event", confidence: "high",
        eventName: event.eventName, protocolFeeQuote: feeUi(event.protocolFeeRaw),
        platformFeeQuote: feeUi(event.platformFeeRaw), shareFeeQuote: feeUi(event.shareFeeRaw),
        lpFeeQuote: feeUi(event.lpFeeRaw),
        creatorFeeQuote: event.creatorFeeMint ? (event.creatorFeeMint === quoteMint ? feeUi(event.creatorFeeRaw) : null) : feeUi(event.creatorFeeRaw),
        creatorFeeBase: event.creatorFeeMint === item.mint ? baseFeeUi(event.creatorFeeRaw) : null,
        tradeFeeQuote: event.tradeFeeMint === quoteMint ? feeUi(event.tradeFeeRaw ?? null) : null,
        tradeFeeBase: event.tradeFeeMint === item.mint ? baseFeeUi(event.tradeFeeRaw ?? null) : null,
        tradeFeeMint: event.tradeFeeMint ?? null, creatorFeeMint: event.creatorFeeMint ?? null,
        venueTradeFeeQuote: event.venueTradeFeeMint === quoteMint ? feeUi(event.venueTradeFeeRaw ?? null) : null,
        venueTradeFeeBase: event.venueTradeFeeMint === item.mint ? baseFeeUi(event.venueTradeFeeRaw ?? null) : null,
        venueTradeFeeMint: event.venueTradeFeeMint ?? null,
        inputTransferFeeQuote: event.side === "buy" ? feeUi(event.inputTransferFeeRaw ?? null) : null,
        outputTransferFeeQuote: event.side === "sell" ? feeUi(event.outputTransferFeeRaw ?? null) : null,
        inputTransferFeeBase: event.side === "sell" ? baseFeeUi(event.inputTransferFeeRaw ?? null) : null,
        outputTransferFeeBase: event.side === "buy" ? baseFeeUi(event.outputTransferFeeRaw ?? null) : null,
        inputTransferFeeRaw: event.inputTransferFeeRaw?.toString() ?? null,
        outputTransferFeeRaw: event.outputTransferFeeRaw?.toString() ?? null,
        preTradeSpotPriceQuote, priceImpactPct,
        cashbackFeeQuote: feeUi(event.cashbackRaw), buybackFeeQuote: feeUi(event.buybackFeeRaw),
        protocolFeeBps: event.protocolFeeBps == null ? null : Number(event.protocolFeeBps),
        lpFeeBps: event.lpFeeBps == null ? null : Number(event.lpFeeBps),
        creatorFeeBps: event.creatorFeeBps == null ? null : Number(event.creatorFeeBps)
      });
    }
  }
  const usedExactEvents = observations.length > 0;
  const quoteMint = observations[0]?.quoteMint ?? knownQuoteMint;
  if (!usedExactEvents) {
    if (!allowEstimated || !knownQuoteMint || migrationDetected) return;
    observations.push(...deriveTradeObservations(tx, item.mint, solUsd, knownQuoteMint));
  }
  if (observations.length === 0) return;

  const observedAt = tx.blockTime ? tx.blockTime * 1000 : Date.now();
  for (const trade of observations) {
    const fundingSources = extractFundingSources(tx, trade.wallet);
    metrics.walletProfiles[trade.wallet] = updateWalletProfile(metrics.walletProfiles[trade.wallet], { ...trade, confidence: trade.confidence }, {
      observedAt, slot, launchSlot: item.launchSlot ?? slot, launchAt: item.firstSeenAt,
      launchFeePayer: item.launchFeePayer ?? null, creator: item.creator, signature,
      feePayer: feePayerForTrade(tx), networkFeeLamports: feePayerForTrade(tx) === trade.wallet ? (tx.meta?.fee ?? 0) : 0, fundingSources
    });
    if (trade.pricingMethod === "decoded_program_trade_event") metrics.exactTradeCount = (metrics.exactTradeCount ?? 0) + 1;
    else metrics.estimatedTradeCount = (metrics.estimatedTradeCount ?? 0) + 1;
    if (trade.protocolFeeQuote != null) metrics.protocolFeesQuote = (metrics.protocolFeesQuote ?? 0) + trade.protocolFeeQuote;
    if (trade.platformFeeQuote != null) metrics.platformFeesQuote = (metrics.platformFeesQuote ?? 0) + trade.platformFeeQuote;
    if (trade.shareFeeQuote != null) metrics.shareFeesQuote = (metrics.shareFeesQuote ?? 0) + trade.shareFeeQuote;
    if (trade.creatorFeeQuote != null) metrics.creatorFeesQuote = (metrics.creatorFeesQuote ?? 0) + trade.creatorFeeQuote;
    if (trade.creatorFeeBase != null) metrics.creatorFeesBase = (metrics.creatorFeesBase ?? 0) + trade.creatorFeeBase;
    if (trade.tradeFeeQuote != null) metrics.tradeFeesQuote = (metrics.tradeFeesQuote ?? 0) + trade.tradeFeeQuote;
    if (trade.tradeFeeBase != null) metrics.tradeFeesBase = (metrics.tradeFeesBase ?? 0) + trade.tradeFeeBase;
    if (trade.lpFeeQuote != null) metrics.lpFeesQuote = (metrics.lpFeesQuote ?? 0) + trade.lpFeeQuote;
    if (trade.cashbackFeeQuote != null) metrics.cashbackFeesQuote = (metrics.cashbackFeesQuote ?? 0) + trade.cashbackFeeQuote;
    if (trade.buybackFeeQuote != null) metrics.buybackFeesQuote = (metrics.buybackFeesQuote ?? 0) + trade.buybackFeeQuote;
    if (trade.priceImpactPct != null) {
      const samples = trade.side === "buy" ? metrics.buyPriceImpactSamples! : metrics.sellPriceImpactSamples!;
      samples.push(trade.priceImpactPct);
      if (samples.length > 2_000) samples.splice(0, samples.length - 2_000);
    }
    if (trade.venueTradeFeeQuote != null) metrics.venueTradeFeesQuote = (metrics.venueTradeFeesQuote ?? 0) + trade.venueTradeFeeQuote;
    if (trade.venueTradeFeeBase != null) metrics.venueTradeFeesBase = (metrics.venueTradeFeesBase ?? 0) + trade.venueTradeFeeBase;
    if (trade.inputTransferFeeBase != null) metrics.inputTransferFeesBase = (metrics.inputTransferFeesBase ?? 0) + trade.inputTransferFeeBase;
    if (trade.outputTransferFeeBase != null) metrics.outputTransferFeesBase = (metrics.outputTransferFeesBase ?? 0) + trade.outputTransferFeeBase;
    if (trade.inputTransferFeeQuote != null) metrics.inputTransferFeesQuote = (metrics.inputTransferFeesQuote ?? 0) + trade.inputTransferFeeQuote;
    if (trade.outputTransferFeeQuote != null) metrics.outputTransferFeesQuote = (metrics.outputTransferFeesQuote ?? 0) + trade.outputTransferFeeQuote;
    const profile = metrics.walletProfiles[trade.wallet];
    await appendTokenEvent(item.mint, {
      schemaVersion: 7, kind: "wallet_activity", mint: item.mint, signature, slot, blockTime: tx.blockTime,
      wallet: trade.wallet, side: trade.side, tokenAmount: trade.tokenAmount, quoteAmount: trade.quoteAmount,
      quoteMint: trade.quoteMint, observedAt, firstBuyElapsedSeconds: profile.firstBuyElapsedSeconds,
      isCreator: profile.creator, isLaunchFeePayer: profile.launchFeePayer,
      sniperCandidate: profile.sniperCandidate, bundleCandidate: profile.bundleCandidate,
      botScore: profile.botScore, botSignals: profile.botSignals,
      fundingSources: profile.fundingSources, confidence: trade.confidence, pricingMethod: trade.pricingMethod
    });
    metrics.tradeCount++;
    metrics.volumeQuote += trade.quoteAmount;
    if (trade.side === "buy") {
      metrics.buyCount++;
      metrics.buyVolumeQuote = (metrics.buyVolumeQuote ?? 0) + trade.quoteAmount;
      metrics.netFlowQuote = (metrics.netFlowQuote ?? 0) + trade.quoteAmount;
      if (!metrics.uniqueBuyers.includes(trade.wallet)) metrics.uniqueBuyers.push(trade.wallet);
      metrics.largestBuyQuote = Math.max(metrics.largestBuyQuote, trade.quoteAmount);
      metrics.largestBuySol = Math.max(metrics.largestBuySol, trade.solAmount);
    } else {
      metrics.sellCount++;
      metrics.sellVolumeQuote = (metrics.sellVolumeQuote ?? 0) + trade.quoteAmount;
      metrics.netFlowQuote = (metrics.netFlowQuote ?? 0) - trade.quoteAmount;
      if (!metrics.uniqueSellers.includes(trade.wallet)) metrics.uniqueSellers.push(trade.wallet);
      metrics.largestSellQuote = Math.max(metrics.largestSellQuote, trade.quoteAmount);
      metrics.largestSellSol = Math.max(metrics.largestSellSol, trade.solAmount);
    }
    if (trade.quoteMint === WRAPPED_SOL_MINT) {
      metrics.volumeSol += trade.quoteAmount;
      metrics.volumeSolAvailable = true;
    }
    if (trade.priceUsd != null) {
      metrics.volumeUsd += trade.quoteMint === WRAPPED_SOL_MINT
        ? trade.quoteAmount * (solUsd ?? 0)
        : trade.quoteAmount * trade.priceUsd / trade.priceQuote;
      metrics.volumeUsdAvailable = true;
    }
    // Trade-level balance deltas are retained as low-confidence wallet/volume evidence only.
    // Bonding-curve virtual reserves are the sole source for the primary price and market-cap series.
  }
  refreshWalletCohorts(item);
  const latest = observations[observations.length - 1];
  if (usedExactEvents && metrics.priceSource !== "pump_bonding_curve_virtual_reserves" && metrics.priceSource !== "pumpswap_pool_vault_reserves_plus_virtual_quote") {
    metrics.firstPriceQuote ??= latest.priceQuote;
    metrics.firstPriceSol ??= latest.priceSol;
    metrics.firstPriceUsd ??= latest.priceUsd;
    metrics.lastPriceQuote = latest.priceQuote;
    metrics.lastPriceSol = latest.priceSol;
    metrics.lastPriceUsd = latest.priceUsd;
    metrics.lastPriceObservedAt = Date.now();
    metrics.priceSource = "decoded_program_trade_event";
  } else if (!usedExactEvents && (item.venue === "stonkfun" || (metrics.priceSource !== "pump_bonding_curve_virtual_reserves" && metrics.priceSource !== "pumpswap_pool_vault_reserves_plus_virtual_quote"))) {
    metrics.firstPriceQuote ??= latest.priceQuote;
    metrics.firstPriceSol ??= latest.priceSol;
    metrics.firstPriceUsd ??= latest.priceUsd;
    metrics.lastPriceQuote = latest.priceQuote;
    metrics.lastPriceSol = latest.priceSol;
    metrics.lastPriceUsd = latest.priceUsd;
    metrics.lastPriceObservedAt = Date.now();
    metrics.priceSource = "owner_balance_delta_estimate";
    metrics.highPriceQuote = metrics.highPriceQuote == null ? latest.priceQuote : Math.max(metrics.highPriceQuote, latest.priceQuote);
    metrics.lowPriceQuote = metrics.lowPriceQuote == null ? latest.priceQuote : Math.min(metrics.lowPriceQuote, latest.priceQuote);
    const multiple = metrics.firstPriceQuote && metrics.firstPriceQuote > 0 ? latest.priceQuote / metrics.firstPriceQuote : 1;
    const elapsed = Math.max(0, (Date.now() - item.firstSeenAt) / 1000);
    for (const [target, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2]] as const) {
      if (multiple >= threshold && metrics.timeToTargetsSeconds[target] == null) metrics.timeToTargetsSeconds[target] = elapsed;
    }
    const drawdown = metrics.highPriceQuote > 0 ? ((latest.priceQuote / metrics.highPriceQuote) - 1) * 100 : 0;
    metrics.maxDrawdownPct = Math.min(metrics.maxDrawdownPct ?? 0, drawdown);
  }
  await appendTokenEvent(item.mint, {
    schemaVersion: 7, kind: "trade_metric", mint: item.mint, signature, slot,
    blockTime: tx.blockTime, observations,
    quoteMint, quoteSymbol: metrics.quoteSymbol ?? null,
    tradeVolumeQuote: observations.reduce((sum, trade) => sum + trade.quoteAmount, 0),
    buyVolumeQuote: metrics.buyVolumeQuote, sellVolumeQuote: metrics.sellVolumeQuote,
    netFlowQuote: metrics.netFlowQuote,
    buySellVolumeRatio: (metrics.sellVolumeQuote ?? 0) > 0 ? (metrics.buyVolumeQuote ?? 0) / (metrics.sellVolumeQuote ?? 0) : null,
    averageBuySizeQuote: metrics.buyCount > 0 ? (metrics.buyVolumeQuote ?? 0) / metrics.buyCount : null,
    averageSellSizeQuote: metrics.sellCount > 0 ? (metrics.sellVolumeQuote ?? 0) / metrics.sellCount : null,
    tradeCount: metrics.tradeCount, buyCount: metrics.buyCount, sellCount: metrics.sellCount,
    volumeSol: metrics.volumeSolAvailable ? metrics.volumeSol : null, volumeUsd: metrics.volumeUsdAvailable ? metrics.volumeUsd : null, volumeQuote: metrics.volumeQuote,
    largestBuySol: metrics.largestBuySol, largestSellSol: metrics.largestSellSol, largestBuyQuote: metrics.largestBuyQuote, largestSellQuote: metrics.largestSellQuote,
    tradeCountIsEstimate: (metrics.estimatedTradeCount ?? 0) > 0,
    exactTradeCount: metrics.exactTradeCount ?? 0, estimatedTradeCount: metrics.estimatedTradeCount ?? 0,
    tradeCountDefinition: "decoded_program_events_preferred_owner_balance_delta_fallback",
    uniqueBuyers: metrics.uniqueBuyers.length, uniqueSellers: metrics.uniqueSellers.length,
    walletCohorts: metrics.walletCohorts, walletProfileCount: Object.keys(metrics.walletProfiles).length,
    networkFeeLamports: tx.meta?.fee ?? 0, protocolFeesQuote: metrics.protocolFeesQuote,
    platformFeesQuote: metrics.platformFeesQuote, creatorFeesQuote: metrics.creatorFeesQuote,
    creatorFeesBase: metrics.creatorFeesBase, tradeFeesQuote: metrics.tradeFeesQuote, tradeFeesBase: metrics.tradeFeesBase,
    shareFeesQuote: metrics.shareFeesQuote, lpFeesQuote: metrics.lpFeesQuote,
    cashbackFeesQuote: metrics.cashbackFeesQuote, buybackFeesQuote: metrics.buybackFeesQuote,
    lastPriceSol: latest.priceSol, lastPriceQuote: latest.priceQuote, lastPriceUsd: latest.priceUsd,
    marketCapQuote: marketCap(latest.priceQuote, item.supplyUi ?? null),
    marketCapSol: latest.priceSol == null ? null : marketCap(latest.priceSol, item.supplyUi ?? null),
    marketCapUsd: marketCap(latest.priceUsd, item.supplyUi ?? null), marketCapBasis: "total_supply_fdv",
    priceChangePctFromFirstTrade: metrics.firstPriceUsd && latest.priceUsd != null
      ? ((latest.priceUsd / metrics.firstPriceUsd) - 1) * 100 : null,
    pricingMethod: usedExactEvents ? "decoded_program_trade_event" : "owner_balance_delta_estimate", confidence: usedExactEvents ? "high" : "low"
  });
  metrics.processedTradeSignatures!.push(signature);
  if (metrics.processedTradeSignatures!.length > 20_000) metrics.processedTradeSignatures = metrics.processedTradeSignatures!.slice(-10_000);
  await recordDueSnapshots(item, historicalReplay ? observedAt : Date.now(), historicalReplay);
  await persistState();
}

async function recordPumpSwapPoolSnapshot(item: TokenState, poolAddress: string, connection: Connection, slot: number) {
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"))) return;
  const pool = decodePumpSwapPoolState(poolInfo.data);
  if (!pool || pool.baseMint !== item.mint || ((item.quoteMint ?? item.metrics?.quoteMint) && pool.quoteMint !== (item.quoteMint ?? item.metrics?.quoteMint))) return;
  const [baseVaultInfo, quoteVaultInfo, quoteDecimals] = await Promise.all([
    connection.getAccountInfo(new PublicKey(pool.baseVault), "confirmed"),
    connection.getAccountInfo(new PublicKey(pool.quoteVault), "confirmed"),
    getMintDecimals(pool.quoteMint)
  ]);
  if (!baseVaultInfo || !quoteVaultInfo || quoteDecimals == null || item.supplyDecimals == null) return;
  const baseRaw = decodeTokenAccountAmount(baseVaultInfo.data, item.mint);
  const quoteRaw = decodeTokenAccountAmount(quoteVaultInfo.data, pool.quoteMint);
  if (baseRaw == null || quoteRaw == null || baseRaw <= 0n) return;
  const effectiveQuoteRaw = quoteRaw + pool.virtualQuoteReservesRaw;
  if (effectiveQuoteRaw <= 0n) return;
  const baseAmount = Number(baseRaw) / (10 ** item.supplyDecimals);
  const quoteAmount = Number(effectiveQuoteRaw) / (10 ** quoteDecimals);
  const priceQuote = quoteAmount / baseAmount;
  if (!Number.isFinite(priceQuote) || priceQuote <= 0) return;
  const isSol = pool.quoteMint === WRAPPED_SOL_MINT;
  const isStable = pool.quoteMint === USDC_MINT || pool.quoteMint === USDT_MINT;
  const solUsd = isSol ? await getSolUsd() : null;
  const quoteUsd = isSol ? solUsd : isStable ? 1 : null;
  const priceUsd = quoteUsd == null ? null : priceQuote * quoteUsd;
  const priceSol = isSol ? priceQuote : null;
  const metrics = ensureMetrics(item);
  metrics.quoteMint = pool.quoteMint;
  metrics.quoteDecimals = quoteDecimals;
  metrics.quoteSymbol = isSol ? "SOL" : pool.quoteMint === USDC_MINT ? "USDC" : pool.quoteMint === USDT_MINT ? "USDT" : "UNKNOWN_SPL";
  metrics.volumeSolAvailable = isSol;
  metrics.volumeUsdAvailable = quoteUsd != null;
  metrics.firstPriceQuote ??= priceQuote;
  metrics.firstPriceSol ??= priceSol;
  metrics.firstPriceUsd ??= priceUsd;
  metrics.lastPriceQuote = priceQuote;
  metrics.lastPriceSol = priceSol;
  metrics.lastPriceUsd = priceUsd;
  metrics.lastPriceObservedAt = Date.now();
  metrics.priceSource = "pumpswap_pool_vault_reserves_plus_virtual_quote";
  metrics.curveComplete = true;
  metrics.highPriceQuote = metrics.highPriceQuote == null ? priceQuote : Math.max(metrics.highPriceQuote, priceQuote);
  metrics.lowPriceQuote = metrics.lowPriceQuote == null ? priceQuote : Math.min(metrics.lowPriceQuote, priceQuote);
  if (priceUsd != null) {
    metrics.highPriceUsd = metrics.highPriceUsd == null ? priceUsd : Math.max(metrics.highPriceUsd, priceUsd);
    metrics.lowPriceUsd = metrics.lowPriceUsd == null ? priceUsd : Math.min(metrics.lowPriceUsd, priceUsd);
  }
  const drawdown = metrics.highPriceQuote > 0 ? ((priceQuote / metrics.highPriceQuote) - 1) * 100 : 0;
  metrics.maxDrawdownPct = Math.min(metrics.maxDrawdownPct ?? 0, drawdown);
  const multiple = metrics.firstPriceQuote && metrics.firstPriceQuote > 0 ? priceQuote / metrics.firstPriceQuote : 1;
  const elapsed = Math.max(0, (Date.now() - item.firstSeenAt) / 1000);
  for (const [target, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2]] as const) {
    if (multiple >= threshold && metrics.timeToTargetsSeconds[target] == null) metrics.timeToTargetsSeconds[target] = elapsed;
  }
  await appendTokenEvent(item.mint, {
    schemaVersion: 6, kind: "pumpswap_pool_state", mint: item.mint, poolAddress,
    slot, poolOwner: poolInfo.owner.toBase58(), creator: pool.creator, coinCreator: pool.coinCreator,
    baseMint: pool.baseMint, quoteMint: pool.quoteMint, lpMint: pool.lpMint,
    baseVault: pool.baseVault, quoteVault: pool.quoteVault, lpSupplyRaw: pool.lpSupplyRaw.toString(),
    isMayhemMode: pool.isMayhemMode, isCashbackCoin: pool.isCashbackCoin,
    virtualQuoteReservesRaw: pool.virtualQuoteReservesRaw.toString(),
    baseVaultAmountRaw: baseRaw.toString(), quoteVaultAmountRaw: quoteRaw.toString(),
    effectiveQuoteReservesRaw: effectiveQuoteRaw.toString(),
    baseVaultAmount: baseAmount, effectiveQuoteReserves: quoteAmount,
    priceQuote, priceSol, priceUsd, quoteUsd,
    marketCapQuote: marketCap(priceQuote, item.supplyUi ?? null),
    marketCapSol: marketCap(priceSol, item.supplyUi ?? null),
    marketCapUsd: marketCap(priceUsd, item.supplyUi ?? null), marketCapBasis: "total_supply_fdv",
    pricingMethod: "pumpswap_pool_vault_reserves_plus_virtual_quote",
    executionQuote: false, note: "Reserve-ratio spot reference; actual fill differs due to AMM fees, slippage and route costs."
  });
  await recordDueSnapshots(item, Date.now());
  await persistState();
}

async function subscribePumpSwapPool(item: TokenState, poolAddress: string) {
  const sub = activeSubscriptions.get(item.mint);
  if (!sub || (sub.ammPoolAddress === poolAddress && (sub.ammIds?.length ?? 0) > 0) || pumpSwapSubscriptionPending.has(item.mint)) return;
  pumpSwapSubscriptionPending.add(item.mint);
  if (sub.ammIds) {
    for (const id of sub.ammIds) { try { await sub.connection.removeAccountChangeListener(id); } catch {} }
  }
  sub.ammIds = [];
  const refresh = (slot: number) => {
    void recordPumpSwapPoolSnapshot(item, poolAddress, sub.connection, slot).catch(error =>
      console.warn("PumpSwap pool snapshot failed:", item.mint, String(error).slice(0, 160))
    );
  };
  try {
    const poolInfo = await sub.connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
    if (!poolInfo) return;
    const pool = decodePumpSwapPoolState(poolInfo.data);
    if (!pool || pool.baseMint !== item.mint || ((item.quoteMint ?? item.metrics?.quoteMint) && pool.quoteMint !== (item.quoteMint ?? item.metrics?.quoteMint))) return;
    const poolId = await sub.connection.onAccountChange(new PublicKey(poolAddress), (_info, context) => refresh(context.slot), "confirmed");
    const baseVaultId = await sub.connection.onAccountChange(new PublicKey(pool.baseVault), (_info, context) => refresh(context.slot), "confirmed");
    const quoteVaultId = await sub.connection.onAccountChange(new PublicKey(pool.quoteVault), (_info, context) => refresh(context.slot), "confirmed");
    sub.ammIds = [poolId, baseVaultId, quoteVaultId];
    sub.ammPoolAddress = poolAddress;
    refresh(0);
    console.log("PumpSwap post-graduation pool tracking started:", item.mint, poolAddress);
  } catch (error) {
    console.warn("Could not subscribe to PumpSwap pool:", item.mint, String(error).slice(0, 160));
  } finally {
    pumpSwapSubscriptionPending.delete(item.mint);
  }
}

async function recordRaydiumCpmmPoolSnapshot(item: TokenState, poolAddress: string, connection: Connection, slot: number) {
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(new PublicKey(RAYDIUM_CPMM_PROGRAM))) return;
  const pool = decodeRaydiumCpmmPoolState(poolInfo.data);
  if (!pool || (pool.token0Mint !== item.mint && pool.token1Mint !== item.mint)) return;
  const baseIsToken0 = pool.token0Mint === item.mint;
  const baseVault = baseIsToken0 ? pool.token0Vault : pool.token1Vault;
  const quoteVault = baseIsToken0 ? pool.token1Vault : pool.token0Vault;
  const quoteMint = baseIsToken0 ? pool.token1Mint : pool.token0Mint;
  const baseDecimals = baseIsToken0 ? pool.token0Decimals : pool.token1Decimals;
  const quoteDecimals = baseIsToken0 ? pool.token1Decimals : pool.token0Decimals;
  if (item.quoteMint && item.quoteMint !== quoteMint) return;
  const [baseInfo, quoteInfo] = await Promise.all([
    connection.getAccountInfo(new PublicKey(baseVault), "confirmed"),
    connection.getAccountInfo(new PublicKey(quoteVault), "confirmed")
  ]);
  if (!baseInfo || !quoteInfo) return;
  const baseRaw = decodeTokenAccountAmount(baseInfo.data, item.mint);
  const quoteRaw = decodeTokenAccountAmount(quoteInfo.data, quoteMint);
  if (baseRaw == null || quoteRaw == null || baseRaw <= 0n) return;
  const baseAmount = Number(baseRaw) / (10 ** baseDecimals);
  const quoteAmount = Number(quoteRaw) / (10 ** quoteDecimals);
  const priceQuote = quoteAmount / baseAmount;
  if (!Number.isFinite(priceQuote) || priceQuote <= 0) return;
  const isSol = quoteMint === WRAPPED_SOL_MINT;
  const isStable = quoteMint === USDC_MINT || quoteMint === USDT_MINT;
  const solUsd = isSol ? await getSolUsd() : null;
  const quoteUsd = isSol ? solUsd : isStable ? 1 : null;
  const priceUsd = quoteUsd == null ? null : priceQuote * quoteUsd;
  const priceSol = isSol ? priceQuote : null;
  const metrics = ensureMetrics(item);
  item.quoteMint = quoteMint;
  metrics.quoteMint = quoteMint;
  metrics.quoteDecimals = quoteDecimals;
  metrics.quoteSymbol = isSol ? "SOL" : quoteMint === USDC_MINT ? "USDC" : quoteMint === USDT_MINT ? "USDT" : "UNKNOWN_SPL";
  metrics.volumeSolAvailable = isSol;
  metrics.volumeUsdAvailable = quoteUsd != null;
  metrics.firstPriceQuote ??= priceQuote;
  metrics.firstPriceSol ??= priceSol;
  metrics.firstPriceUsd ??= priceUsd;
  metrics.lastPriceQuote = priceQuote;
  metrics.lastPriceSol = priceSol;
  metrics.lastPriceUsd = priceUsd;
  metrics.lastPriceObservedAt = Date.now();
  metrics.priceSource = "raydium_cpmm_vault_reserves";
  metrics.curveComplete = true;
  metrics.highPriceQuote = metrics.highPriceQuote == null ? priceQuote : Math.max(metrics.highPriceQuote, priceQuote);
  metrics.lowPriceQuote = metrics.lowPriceQuote == null ? priceQuote : Math.min(metrics.lowPriceQuote, priceQuote);
  if (priceUsd != null) {
    metrics.highPriceUsd = metrics.highPriceUsd == null ? priceUsd : Math.max(metrics.highPriceUsd, priceUsd);
    metrics.lowPriceUsd = metrics.lowPriceUsd == null ? priceUsd : Math.min(metrics.lowPriceUsd, priceUsd);
  }
  const drawdown = metrics.highPriceQuote > 0 ? ((priceQuote / metrics.highPriceQuote) - 1) * 100 : 0;
  metrics.maxDrawdownPct = Math.min(metrics.maxDrawdownPct ?? 0, drawdown);
  const multiple = metrics.firstPriceQuote && metrics.firstPriceQuote > 0 ? priceQuote / metrics.firstPriceQuote : 1;
  const elapsed = Math.max(0, (Date.now() - item.firstSeenAt) / 1000);
  for (const [target, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2]] as const) {
    if (multiple >= threshold && metrics.timeToTargetsSeconds[target] == null) metrics.timeToTargetsSeconds[target] = elapsed;
  }
  if (item.lpLockVaultAddress && Date.now() - (item.lpLockLastCheckedAt ?? 0) >= 30_000) {
    try {
      const lockInfo = await connection.getAccountInfo(new PublicKey(item.lpLockVaultAddress), "confirmed");
      if (lockInfo) {
        const lockAmount = decodeTokenAccountAmount(lockInfo.data, pool.lpMint);
        const lockOwner = lockInfo.data.length >= 64 ? new PublicKey(lockInfo.data.subarray(32, 64)).toBase58() : null;
        item.lpLockLastAmountRaw = lockAmount?.toString() ?? null;
        item.lpLockLastOwner = lockOwner;
        item.lpLockLastSharePct = lockAmount != null && pool.lpSupplyRaw > 0n ? Number(lockAmount) / Number(pool.lpSupplyRaw) * 100 : null;
        item.lpLockLastCheckedAt = Date.now();
      }
    } catch (error) {
      console.warn("LP lock vault verification failed:", item.mint, String(error).slice(0, 120));
    }
  }
  const lpLockSnapshot = item.lpLockVaultAddress ? {
    vault: item.lpLockVaultAddress,
    tokenAccountOwner: item.lpLockLastOwner ?? null,
    amountRaw: item.lpLockLastAmountRaw ?? null,
    sharePct: item.lpLockLastSharePct ?? null,
    checkedAt: item.lpLockLastCheckedAt ?? null
  } : null;
  await appendTokenEvent(item.mint, {
    schemaVersion: 8, kind: "raydium_cpmm_pool_state", mint: item.mint, poolAddress, slot,
    poolOwner: poolInfo.owner.toBase58(), poolCreator: pool.poolCreator,
    token0Mint: pool.token0Mint, token1Mint: pool.token1Mint,
    token0Vault: pool.token0Vault, token1Vault: pool.token1Vault,
    baseVault, quoteVault, baseMint: item.mint, quoteMint,
    baseDecimals, quoteDecimals, baseVaultAmountRaw: baseRaw.toString(), quoteVaultAmountRaw: quoteRaw.toString(),
    baseVaultAmount: baseAmount, quoteVaultAmount: quoteAmount, priceQuote, priceSol, priceUsd, quoteUsd,
    lpMint: pool.lpMint, lpMintDecimals: pool.lpMintDecimals, lpSupplyRaw: pool.lpSupplyRaw.toString(), openTime: pool.openTime.toString(),
    lpLockVaultAddress: item.lpLockVaultAddress ?? null, lpLockSnapshot,
    lpLockShareIsVerifiedTokenAccountBalance: lpLockSnapshot?.amountRaw != null,
    status: pool.status, creatorFeeOn: pool.creatorFeeOn, enableCreatorFee: pool.enableCreatorFee,
    protocolFeesToken0Raw: pool.protocolFeesToken0Raw.toString(), protocolFeesToken1Raw: pool.protocolFeesToken1Raw.toString(),
    fundFeesToken0Raw: pool.fundFeesToken0Raw.toString(), fundFeesToken1Raw: pool.fundFeesToken1Raw.toString(),
    creatorFeesToken0Raw: pool.creatorFeesToken0Raw.toString(), creatorFeesToken1Raw: pool.creatorFeesToken1Raw.toString(),
    marketCapQuote: marketCap(priceQuote, item.supplyUi ?? null),
    marketCapSol: marketCap(priceSol, item.supplyUi ?? null),
    marketCapUsd: marketCap(priceUsd, item.supplyUi ?? null), marketCapBasis: "total_supply_fdv",
    pricingMethod: "raydium_cpmm_vault_reserves", executionQuote: false,
    note: "CPMM reserve-ratio reference; not a fill quote and does not measure locked LP ownership."
  });
  await recordDueSnapshots(item, Date.now());
  await persistState();
}

async function subscribeRaydiumCpmmPool(item: TokenState, poolAddress: string) {
  const sub = activeSubscriptions.get(item.mint);
  if (!sub || (sub.ammPoolAddress === poolAddress && (sub.ammIds?.length ?? 0) > 0) || pumpSwapSubscriptionPending.has(item.mint)) return;
  pumpSwapSubscriptionPending.add(item.mint);
  if (sub.ammIds) for (const id of sub.ammIds) { try { await sub.connection.removeAccountChangeListener(id); } catch {} }
  sub.ammIds = [];
  const refresh = (slot: number) => {
    void recordRaydiumCpmmPoolSnapshot(item, poolAddress, sub.connection, slot).catch(error =>
      console.warn("Raydium CPMM pool snapshot failed:", item.mint, String(error).slice(0, 160))
    );
  };
  try {
    const poolInfo = await sub.connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
    if (!poolInfo || !poolInfo.owner.equals(new PublicKey(RAYDIUM_CPMM_PROGRAM))) return;
    const pool = decodeRaydiumCpmmPoolState(poolInfo.data);
    if (!pool || (pool.token0Mint !== item.mint && pool.token1Mint !== item.mint)) return;
    const poolId = await sub.connection.onAccountChange(new PublicKey(poolAddress), (_info, context) => refresh(context.slot), "confirmed");
    const vault0Id = await sub.connection.onAccountChange(new PublicKey(pool.token0Vault), (_info, context) => refresh(context.slot), "confirmed");
    const vault1Id = await sub.connection.onAccountChange(new PublicKey(pool.token1Vault), (_info, context) => refresh(context.slot), "confirmed");
    sub.ammIds = [poolId, vault0Id, vault1Id];
    sub.ammPoolAddress = poolAddress;
    refresh(0);
    console.log("StonkFun post-graduation CPMM tracking started:", item.mint, poolAddress);
  } catch (error) {
    console.warn("Could not subscribe to Raydium CPMM pool:", item.mint, String(error).slice(0, 160));
  } finally {
    pumpSwapSubscriptionPending.delete(item.mint);
  }
}

async function retryPendingActivityTransactions() {
  if (retryingPendingActivity || shuttingDown) return;
  retryingPendingActivity = true;
  let changed = false;
  try {
    state.pendingActivity ??= {};
    for (const [mint, pending] of Object.entries(state.pendingActivity)) {
      const item = state.tokens[mint];
      if (!item) {
        delete state.pendingActivity[mint];
        changed = true;
        continue;
      }
      for (const entry of [...pending]) {
        const tx = await fetchTransaction(entry.signature);
        if (!tx) continue;
        if (!(item.quoteMint ?? item.metrics?.quoteMint)) continue;
        await processTradeMetrics(item, tx, entry.signature, entry.slot);
        await appendTokenEvent(mint, {
          schemaVersion: 2, kind: "token_activity_enriched", mint, observedAt: entry.observedAt,
          slot: entry.slot, signature: entry.signature, logs: entry.logs,
          transaction: {
            blockTime: tx.blockTime, feeLamports: tx.meta?.fee,
            signatureCount: tx.transaction.signatures.length,
            baseSignatureFeeLamports: tx.transaction.signatures.length * 5_000,
            estimatedPriorityFeeLamports: Math.max(0, (tx.meta?.fee ?? 0) - tx.transaction.signatures.length * 5_000),
            computeUnitsConsumed: tx.meta?.computeUnitsConsumed, loadedAddresses: tx.meta?.loadedAddresses,
            err: tx.meta?.err, accountKeys: tx.transaction.message.accountKeys.map(k => getAccountKey(k)),
            preBalances: tx.meta?.preBalances, postBalances: tx.meta?.postBalances,
            preTokenBalances: tx.meta?.preTokenBalances, postTokenBalances: tx.meta?.postTokenBalances,
            innerInstructions: tx.meta?.innerInstructions, logMessages: tx.meta?.logMessages
          }
        });
        const index = pending.findIndex(candidate => candidate.signature === entry.signature);
        if (index >= 0) pending.splice(index, 1);
        changed = true;
      }
      if (pending.length === 0) delete state.pendingActivity[mint];
    }
    if (changed) await persistState();
  } catch (error) {
    console.error("Pending activity enrichment paused; signatures remain checkpointed:", String(error).slice(0, 200));
  } finally {
    retryingPendingActivity = false;
  }
}

async function migrateQuarantinedMint(mint: string) {
  const entry = qualityManifest.quarantinedMints[mint];
  if (!entry || entry.rawMovedToQuarantine === true || entry.status === "deleted" || entry.status === "delete_pending") return;
  const reason = String(entry.reason ?? "Failed strict launch verification.");
  const moved = await quarantineRemoteMintFile(mint, reason);
  if (moved) {
    entry.rawMovedToQuarantine = true;
    await persistQualityManifest();
  }
}

async function persistQualityManifest() {
  await mkdir(path.dirname(qualityPath), { recursive: true });
  qualityManifest.generatedAt = Date.now();
  await writeFile(qualityPath, JSON.stringify(qualityManifest, null, 2));
  markQualityManifestDirty();
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
  markMintDirty(mint, state.tokens[mint]?.venue ?? "pumpfun");
}
function getAccountKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key && typeof key === "object" && "pubkey" in key) return String((key as { pubkey: unknown }).pubkey);
  return String(key);
}
function transactionInstructions(tx: ParsedTransactionWithMeta) {
  // Only message-level instructions can prove a launch; CPI instructions are not launch evidence.
  return getTopLevelInstructions(tx.transaction.message as unknown as { instructions: Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }> });
}
function feePayerForTrade(tx: ParsedTransactionWithMeta): string | null {
  const message = tx.transaction.message as unknown as { accountKeys?: Array<unknown> };
  const first = message.accountKeys?.[0] as { pubkey?: unknown } | string | undefined;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "pubkey" in first) return String(first.pubkey);
  return null;
}
function allTransactionInstructions(tx: ParsedTransactionWithMeta) {
  const topLevel = transactionInstructions(tx);
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(group =>
    group.instructions as unknown as Array<{ programId?: unknown; data?: unknown; accounts?: unknown[] }>
  );
  return [...topLevel, ...inner];
}
function pumpCreateInstructions(tx: ParsedTransactionWithMeta) {
  return findPumpCreateInstructions(transactionInstructions(tx), PUMP_PROGRAM.toBase58());
}
function stonkFunLaunchInstructions(tx: ParsedTransactionWithMeta) {
  return findStonkFunLaunchInstructions(transactionInstructions(tx), LAUNCHLAB_PROGRAM.toBase58(), STONKFUN_PLATFORM_CONFIGS);
}
function isCreateTransaction(tx: ParsedTransactionWithMeta): boolean {
  return pumpCreateInstructions(tx).length > 0;
}
function createdPumpMints(tx: ParsedTransactionWithMeta): string[] {
  return [...new Set(pumpCreateInstructions(tx).map(instruction => instruction.mint).filter(mint => mint && !NON_TOKEN_MINTS.has(mint)))];
}
async function isMintAccount(mint: string): Promise<boolean | null> {
  try {
    const info = await nextRpc().getAccountInfo(new PublicKey(mint), "confirmed");
    return Boolean(info && TOKEN_PROGRAMS.has(info.owner.toBase58()));
  } catch (error) {
    console.warn("Mint-owner verification RPC failed; preserving launch for retry:", mint, String(error).slice(0, 120));
    return null;
  }
}
const transactionFetches = new Map<string, Promise<ParsedTransactionWithMeta | null>>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTransactionWithBackoff(signature: string): Promise<ParsedTransactionWithMeta | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
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
  // Per-key RPC queues enforce provider pacing while allowing three configured
  // Helius keys to make independent progress instead of one global bottleneck.
  const request = fetchTransactionWithBackoff(signature);
  transactionFetches.set(signature, request);
  void request.finally(() => transactionFetches.delete(signature));
  return request;
}
async function loadActivitySignatures(item: TokenState) {
  const seen = new Set<string>();
  try {
    const content = await readFile(path.join(DATA_DIR, "tokens", item.mint, "events.jsonl"), "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { signature?: unknown };
        if (typeof event.signature === "string") seen.add(event.signature);
      } catch { /* Ignore one malformed historical line; preserve the rest. */ }
    }
  } catch { /* New token has no local event file yet. */ }
  activitySignatures.set(item.mint, seen);
}

async function backfillActiveMintActivity(item: TokenState) {
  if (item.expiresAt <= Date.now()) return;
  const seen = activitySignatures.get(item.mint) ?? new Set<string>();
  activitySignatures.set(item.mint, seen);
  try {
    const signatures = await nextRpc().getSignaturesForAddress(new PublicKey(item.mint), { limit: 100 }, "confirmed");
    const eligible = signatures.filter(entry =>
      entry.signature !== item.launchSignature &&
      entry.blockTime != null &&
      entry.blockTime * 1000 >= item.firstSeenAt &&
      entry.blockTime * 1000 <= item.expiresAt
    ).reverse();
    let pendingChanged = false;
    for (const entry of eligible) {
      if (seen.has(entry.signature)) continue;
      seen.add(entry.signature);
      const tx = await fetchTransaction(entry.signature);
      const observedAt = (entry.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
      const logs = tx?.meta?.logMessages ?? [];
      if (tx && (item.quoteMint ?? item.metrics?.quoteMint)) {
        await processTradeMetrics(item, tx, entry.signature, entry.slot);
      } else {
        state.pendingActivity ??= {};
        const pending = state.pendingActivity[item.mint] ??= [];
        if (!pending.some(candidate => candidate.signature === entry.signature) && pending.length < 500) {
          pending.push({ signature: entry.signature, slot: entry.slot, observedAt, logs });
          pendingChanged = true;
        }
      }
      await appendTokenEvent(item.mint, {
        schemaVersion: 2, kind: "token_activity_backfill", mint: item.mint, observedAt,
        slot: entry.slot, signature: entry.signature, backfillWindowStart: item.firstSeenAt,
        backfillWindowEnd: item.expiresAt, logs,
        transaction: tx ? {
          blockTime: tx.blockTime, feeLamports: tx.meta?.fee,
          signatureCount: tx.transaction.signatures.length,
          baseSignatureFeeLamports: tx.transaction.signatures.length * 5_000,
          estimatedPriorityFeeLamports: Math.max(0, (tx.meta?.fee ?? 0) - tx.transaction.signatures.length * 5_000),
          computeUnitsConsumed: tx.meta?.computeUnitsConsumed, loadedAddresses: tx.meta?.loadedAddresses,
          err: tx.meta?.err, accountKeys: tx.transaction.message.accountKeys.map(k => getAccountKey(k)),
          preBalances: tx.meta?.preBalances, postBalances: tx.meta?.postBalances,
          preTokenBalances: tx.meta?.preTokenBalances, postTokenBalances: tx.meta?.postTokenBalances,
          innerInstructions: tx.meta?.innerInstructions, logMessages: tx.meta?.logMessages
        } : null
      });
    }
    if (pendingChanged) await persistState();
    if (eligible.length > 0) console.log("Backfilled recent mint activity:", item.mint, "signatures:", eligible.length);
  } catch (error) {
    console.warn("Recent mint activity backfill paused:", item.mint, String(error).slice(0, 160));
  }
}

async function captureMint(item: TokenState) {
  const { mint, expiresAt } = item;
  if (activeSubscriptions.has(mint) || expiresAt <= Date.now()) return;
  const connection = nextRpc();
  try {
    const id = connection.onLogs(new PublicKey(mint), async (logs: Logs, context) => {
      if (shuttingDown || logs.err) return;
      const seen = activitySignatures.get(mint) ?? new Set<string>();
      activitySignatures.set(mint, seen);
      if (seen.has(logs.signature)) return;
      seen.add(logs.signature);
      const observedAt = Date.now();
      if (observedAt > expiresAt) { await stopCapture(mint); return; }
      const tx = await fetchTransaction(logs.signature);
      const item = state.tokens[mint];
      if (tx && item && (item.quoteMint ?? item.metrics?.quoteMint)) await processTradeMetrics(item, tx, logs.signature, context.slot);
      if (tx && item) await recordDueSnapshots(item, observedAt);
      if (!tx || (item && !(item.quoteMint ?? item.metrics?.quoteMint))) {
        state.pendingActivity ??= {};
        const pending = state.pendingActivity[mint] ??= [];
        if (!pending.some(entry => entry.signature === logs.signature) && pending.length < 500) {
          pending.push({ signature: logs.signature, slot: context.slot, observedAt, logs: logs.logs });
          await persistState();
        }
      }
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
    let curveId: number | undefined;
    if (item.venue === "stonkfun" && item.poolAddress) {
      const poolAddress = new PublicKey(item.poolAddress);
      const recordPoolState = (info: { owner: PublicKey; lamports: number; data: Buffer }, slot: number) => {
        const decoded = info.owner.equals(LAUNCHLAB_PROGRAM) ? decodeLaunchLabPoolState(info.data) : null;
        const identityValid = Boolean(decoded && decoded.baseMint === mint && decoded.quoteMint === item.quoteMint && decoded.platformConfig === item.platformConfig);
        const realBaseUi = identityValid && decoded ? Number(decoded.realBaseRaw) / (10 ** decoded.baseDecimals) : null;
        const realQuoteUi = identityValid && decoded ? Number(decoded.realQuoteRaw) / (10 ** decoded.quoteDecimals) : null;
        const reserveRatioQuotePerBase = realBaseUi != null && realBaseUi > 0 && realQuoteUi != null
          ? realQuoteUi / realBaseUi : null;
        if (identityValid && decoded) {
          const metrics = ensureMetrics(item);
          metrics.launchlabReserveRatioQuote = reserveRatioQuotePerBase;
          metrics.launchlabRealBase = realBaseUi;
          metrics.launchlabRealQuote = realQuoteUi;
          metrics.launchlabPoolStatus = decoded.statusName;
          void recordDueSnapshots(item, Date.now());
        }
        void appendTokenEvent(mint, {
          schemaVersion: 6, kind: "launchlab_pool_state", mint, poolAddress: item.poolAddress,
          slot, owner: info.owner.toBase58(), lamports: info.lamports, dataBase64: info.data.toString("base64"),
          decodeStatus: !decoded ? "unrecognized_layout_or_owner" : identityValid ? "decoded_identity_verified" : "decoded_identity_mismatch",
          poolStatus: identityValid ? decoded?.statusName : null,
          migrateType: identityValid ? decoded?.migrateTypeName : null,
          baseMint: identityValid ? decoded?.baseMint : null, quoteMint: identityValid ? decoded?.quoteMint : null,
          baseDecimals: identityValid ? decoded?.baseDecimals : null, quoteDecimals: identityValid ? decoded?.quoteDecimals : null,
          supplyRaw: identityValid ? decoded?.supplyRaw.toString() : null,
          totalBaseSellRaw: identityValid ? decoded?.totalBaseSellRaw.toString() : null,
          virtualBaseRaw: identityValid ? decoded?.virtualBaseRaw.toString() : null,
          virtualQuoteRaw: identityValid ? decoded?.virtualQuoteRaw.toString() : null,
          realBaseRaw: identityValid ? decoded?.realBaseRaw.toString() : null,
          realQuoteRaw: identityValid ? decoded?.realQuoteRaw.toString() : null,
          realBaseUi, realQuoteUi, reserveRatioQuotePerBase,
          reserveRatioIsSpotPrice: false,
          platformFeeRaw: identityValid ? decoded?.platformFeeRaw.toString() : null,
          quoteProtocolFeeRaw: identityValid ? decoded?.quoteProtocolFeeRaw.toString() : null,
          baseVault: identityValid ? decoded?.baseVault : null, quoteVault: identityValid ? decoded?.quoteVault : null,
          creator: identityValid ? decoded?.creator : null
        });
      };
      curveId = connection.onAccountChange(poolAddress, (accountInfo, context) => {
        if (!shuttingDown && state.tokens[mint]) recordPoolState(accountInfo, context.slot);
      }, "confirmed");
      void connection.getAccountInfo(poolAddress, "confirmed").then(info => {
        if (info) recordPoolState(info, 0);
      }).catch(error => console.warn("Initial LaunchLab pool read failed:", mint, String(error).slice(0, 120)));
    } else {
      const [curveAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM
      );
      curveId = connection.onAccountChange(curveAddress, (accountInfo, context) => {
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
    }
    const timer = setInterval(() => {
      const item = state.tokens[mint];
      if (item) void recordDueSnapshots(item, Date.now()).catch(error => console.error("Snapshot error:", String(error)));
    }, 1_000);
    activeSubscriptions.set(mint, { connection, id, curveId, timer });
    if (item.pumpSwapPoolAddress) void subscribePumpSwapPool(item, item.pumpSwapPoolAddress);
    if (item.cpmmPoolAddress) void subscribeRaydiumCpmmPool(item, item.cpmmPoolAddress);
    await persistState();
  } catch (error) { console.error("Could not subscribe to mint", mint, String(error)); }
}
async function stopCapture(mint: string) {
  const sub = activeSubscriptions.get(mint);
  if (sub) {
    if (sub.timer) clearInterval(sub.timer);
    try { await sub.connection.removeOnLogsListener(sub.id); } catch {}
    if (sub.curveId != null) { try { await sub.connection.removeAccountChangeListener(sub.curveId); } catch {} }
    if (sub.ammIds) for (const id of sub.ammIds) { try { await sub.connection.removeAccountChangeListener(id); } catch {} }
    activeSubscriptions.delete(mint);
  }
}
async function fetchMintRiskMetadata(mint: string): Promise<{
  mintAuthority: string | null; freezeAuthority: string | null; mintInitialized: boolean | null; mintMetadataParsed: boolean;
  tokenProgramOwner: string | null; tokenExtensions: Array<{ extension: string; state?: unknown }> | null;
}> {
  try {
    const response = await nextRpc().getParsedAccountInfo(new PublicKey(mint), "confirmed");
    if (!response.value) return { mintAuthority: null, freezeAuthority: null, mintInitialized: null, mintMetadataParsed: false, tokenProgramOwner: null, tokenExtensions: null };
    const accountData = response.value.data as unknown as { parsed?: { info?: Record<string, unknown> } };
    const info = accountData.parsed?.info;
    if (!info) return { mintAuthority: null, freezeAuthority: null, mintInitialized: null, mintMetadataParsed: false, tokenProgramOwner: response.value.owner.toBase58(), tokenExtensions: null };
    const rawExtensions = Array.isArray(info.extensions) ? info.extensions : null;
    const tokenExtensions = rawExtensions?.map(value => {
      const extension = value as Record<string, unknown>;
      return { extension: String(extension.extension ?? extension.type ?? "unknown"), state: extension.state ?? extension };
    }) ?? null;
    return {
      mintAuthority: info.mintAuthority ? String(info.mintAuthority) : null,
      freezeAuthority: info.freezeAuthority ? String(info.freezeAuthority) : null,
      mintInitialized: typeof info.isInitialized === "boolean" ? info.isInitialized : null,
      mintMetadataParsed: true,
      tokenProgramOwner: response.value.owner.toBase58(),
      tokenExtensions
    };
  } catch (error) {
    console.warn("Could not read mint authority/extensions:", mint, String(error).slice(0, 120));
    return { mintAuthority: null, freezeAuthority: null, mintInitialized: null, mintMetadataParsed: false, tokenProgramOwner: null, tokenExtensions: null };
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
    const mintRisk = await fetchMintRiskMetadata(mint);
    const item: TokenState = {
      mint, ...mintRisk, creator: null, launchSignature: signature, launchFeePayer: feePayer, launchSlot: slot, launchVerified: true, launchInstruction: createInstruction.kind, venue: "pumpfun", firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS,
      supplyUi, supplyDecimals
    };
    ensureMetrics(item);
    state.tokens[mint] = item;
    await appendTokenEvent(mint, {
      schemaVersion: 2, kind: "launch_detected", mint, feePayer,
      creator: null, creatorEvidence: "not decoded; fee payer is stored separately",
      totalSupply: supplyUi, supplyDecimals, supplySource: "Solana getTokenSupply",
      ...mintRisk, mintMetadataParsed: mintRisk.mintMetadataParsed,
      mintAuthorityRenounced: mintRisk.mintMetadataParsed ? mintRisk.mintAuthority == null : null,
      freezeAuthorityRenounced: mintRisk.mintMetadataParsed ? mintRisk.freezeAuthority == null : null,
      launchSignature: signature, launchSlot: slot, firstSeenAt,
      program: PUMP_PROGRAM.toBase58(), instruction: createInstruction.kind, launchVerification: "IDL discriminator + mint account owner", launchLogs: logs
    });
    await persistState();
    await processTradeMetrics(item, tx, signature, slot, false);
    await captureMint(item);
    console.log("Verified Pump mint capture started:", mint, "fee payer:", feePayer);
  }
  state.seenLaunchSignatures.push(signature);
  if (state.seenLaunchSignatures.length > 20_000) state.seenLaunchSignatures = state.seenLaunchSignatures.slice(-10_000);
  await persistState();
}
async function processStonkLaunch(signature: string, slot: number, logs: string[], tx: ParsedTransactionWithMeta) {
  if (state.seenLaunchSignatures.includes(signature) || tx.meta?.err) return;
  const launches = stonkFunLaunchInstructions(tx);
  for (const launch of launches) {
    const { mint, quoteMint, pool, platformConfig, kind, creator } = launch;
    if (state.tokens[mint] || !await isMintAccount(mint)) continue;
    const feePayer = getAccountKey(tx.transaction.message.accountKeys[0]);
    const firstSeenAt = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    let supplyUi: number | null = null;
    let supplyDecimals: number | null = null;
    try {
      const supply = await nextRpc().getTokenSupply(new PublicKey(mint), "confirmed");
      supplyUi = supply.value.uiAmount;
      supplyDecimals = supply.value.decimals;
    } catch (error) { console.warn("Could not read StonkFun token supply:", mint, String(error).slice(0, 120)); }
    const quoteDecimals = await getMintDecimals(quoteMint);
    const quoteSymbol = quoteMint === WRAPPED_SOL_MINT ? "SOL" : quoteMint === USDC_MINT ? "USDC" : quoteMint === USDT_MINT ? "USDT" : "UNKNOWN_SPL";
    const mintRisk = await fetchMintRiskMetadata(mint);
    const item: TokenState = {
      mint, ...mintRisk, creator, launchSignature: signature, launchFeePayer: feePayer, launchSlot: slot, launchVerified: true, launchInstruction: kind,
      venue: "stonkfun", quoteMint, poolAddress: pool, platformConfig,
      firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS, supplyUi, supplyDecimals
    };
    const metrics = ensureMetrics(item);
    metrics.quoteMint = quoteMint;
    metrics.quoteSymbol = quoteSymbol;
    metrics.quoteDecimals = quoteDecimals;
    metrics.volumeSolAvailable = quoteMint === WRAPPED_SOL_MINT;
    metrics.volumeUsdAvailable = quoteMint === WRAPPED_SOL_MINT || quoteMint === USDC_MINT || quoteMint === USDT_MINT;
    metrics.priceSource = "owner_balance_delta_estimate";
    state.tokens[mint] = item;
    await appendTokenEvent(mint, {
      schemaVersion: 2, kind: "launch_detected", venue: "stonkfun", mint, creator, feePayer,
      launchSignature: signature, launchSlot: slot, firstSeenAt, instruction: kind,
      program: LAUNCHLAB_PROGRAM.toBase58(), platformConfig, poolAddress: pool,
      quoteMint, quoteSymbol, quoteDecimals,
      totalSupply: supplyUi, supplyDecimals, supplySource: "Solana getTokenSupply",
      ...mintRisk, mintAuthorityRenounced: mintRisk.mintAuthority == null,
      freezeAuthorityRenounced: mintRisk.freezeAuthority == null,
      launchVerification: "LaunchLab initializer discriminator + verified StonkFun platform config + token-mint owner",
      launchLogs: logs
    });
    await persistState();
    await processTradeMetrics(item, tx, signature, slot, false);
    await captureMint(item);
    console.log("Verified StonkFun LaunchLab capture started:", mint, "quote:", quoteMint);
  }
  state.seenLaunchSignatures.push(signature);
  if (state.seenLaunchSignatures.length > 20_000) state.seenLaunchSignatures = state.seenLaunchSignatures.slice(-10_000);
  await persistState();
}

async function handleLiveStonkLaunch(signature: string, logs: Logs, slot: number) {
  if (!STONK_LAUNCH_LOG.test(logs.logs.join("\n")) || state.seenLaunchSignatures.includes(signature)) return;
  const tx = await fetchTransaction(signature);
  if (!tx) { console.warn("Will recover StonkFun launch transaction during LaunchLab reconciliation:", signature); return; }
  await processStonkLaunch(signature, slot, logs.logs, tx);
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
async function reconcileMissedStonkLaunches() {
  if (stonkReconciliation) return stonkReconciliation;
  stonkReconciliation = (async () => {
    const connection = nextRpc();
    const head = (await connection.getSignaturesForAddress(LAUNCHLAB_PROGRAM, { limit: 1 }, "confirmed"))[0];
    if (!head) return;
    if (!state.lastLaunchLabSignature) {
      state.lastLaunchLabSignature = head.signature;
      await persistState();
      console.log("Initialized resumable StonkFun LaunchLab cursor at current chain head.");
      return;
    }
    if (!state.launchLabReconcileTarget) {
      state.launchLabReconcileTarget = head.signature;
      state.launchLabReconcileBefore = undefined;
      await persistState();
    }
    let pages = 0;
    let reachedCheckpoint = false;
    while (pages < MAX_RECONCILE_PAGES && !shuttingDown) {
      const options: { limit: number; before?: string; until?: string } = { limit: RECONCILE_PAGE_SIZE };
      if (state.launchLabReconcileBefore) options.before = state.launchLabReconcileBefore;
      options.until = state.lastLaunchLabSignature;
      const signatures = await connection.getSignaturesForAddress(LAUNCHLAB_PROGRAM, options, "confirmed");
      if (signatures.length === 0) { reachedCheckpoint = true; break; }
      const page = signatures.filter(entry => entry.signature !== state.lastLaunchLabSignature);
      if (page.length === 0) { reachedCheckpoint = true; break; }
      for (const entry of [...page].reverse()) {
        const tx = await fetchTransaction(entry.signature);
        if (!tx) throw new Error(`Could not fetch LaunchLab reconciliation transaction ${entry.signature}; cursor retained.`);
        if (!tx.meta?.err && stonkFunLaunchInstructions(tx).length > 0) {
          await processStonkLaunch(entry.signature, entry.slot, tx.meta?.logMessages ?? [], tx);
        }
      }
      state.launchLabReconcileBefore = page[page.length - 1].signature;
      await persistState();
      pages++;
      if (page.length < RECONCILE_PAGE_SIZE) { reachedCheckpoint = true; break; }
    }
    if (reachedCheckpoint) {
      state.lastLaunchLabSignature = state.launchLabReconcileTarget;
      state.launchLabReconcileTarget = undefined;
      state.launchLabReconcileBefore = undefined;
      await persistState();
      console.log("StonkFun LaunchLab reconciliation reached the previous checkpoint.");
    } else {
      console.log("StonkFun reconciliation paused at a saved cursor; it will resume on the next run.");
    }
  })().catch(error => console.error("StonkFun reconciliation paused safely:", String(error).slice(0, 240)))
    .finally(() => { stonkReconciliation = undefined; });
  return stonkReconciliation;
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  await restoreCollectorState(statePath);
  await restoreQualityManifest(qualityPath);
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as CollectorState;
    state.tokens ??= {};
    state.seenLaunchSignatures ??= [];
    state.pendingActivity ??= {};
    try {
      qualityManifest = JSON.parse(await readFile(qualityPath, "utf8")) as typeof qualityManifest;
      qualityManifest.quarantinedMints ??= {};
      qualityManifest.rules ??= [];
      const stonkRule = "StonkFun launches require a LaunchLab initializer discriminator, the LaunchLab program ID, a known StonkFun platform-config account and a verified token-mint owner.";
      if (!qualityManifest.rules.includes(stonkRule)) qualityManifest.rules.push(stonkRule);
    } catch { /* A new manifest is created below. */ }
    qualityManifest.quarantinedMints[WRAPPED_SOL_MINT] ??= {
      status: "delete_pending", reason: "Confirmed false launch: wrapped SOL was stored as the mint; inspected launch signature is a Pump buy, not create/create_v2. A guarded dataset cleanup workflow removes the invalid raw file.",
      launchSignature: "3mR3oyYXHEPWWCUhv3URSCjVXABTUoGDv4eowDGJp5Dv522sghdc66janYMgm7KU4uLYwRmvTXV5CQuV6voRwQUw",
      rawPath: `raw/pumpfun/${WRAPPED_SOL_MINT}/events.jsonl`, rawDeleted: false, retainedForAudit: false
    };
    for (const mint of NON_TOKEN_MINTS) {
      if (state.tokens[mint]) qualityManifest.quarantinedMints[mint] = {
        status: mint === WRAPPED_SOL_MINT ? "delete_pending" : "excluded",
        reason: "Quote asset is not a newly launched Pump token.",
        rawPath: `raw/pumpfun/${mint}/events.jsonl`, retainedForAudit: mint !== WRAPPED_SOL_MINT
      };
      delete state.tokens[mint];
    }
    for (const mint of Object.keys(qualityManifest.quarantinedMints)) await migrateQuarantinedMint(mint);
    await persistQualityManifest();
  } catch (error) {
    console.error("Checkpoint is invalid; starting a clean state without deleting remote data:", String(error).slice(0, 160));
    state = { tokens: {}, seenLaunchSignatures: [], pendingActivity: {} };
    await persistState();
  }
}
async function auditExistingLaunches() {
  let changed = false;
  for (const item of Object.values(state.tokens)) {
    const tx = await fetchTransaction(item.launchSignature);
    if (!tx || !tx.meta) {
      console.warn("Existing token awaits launch-transaction metadata; preserving checkpoint for retry:", item.mint);
      continue;
    }
    const transactionSucceeded = !tx.meta.err;
    const validMint = await isMintAccount(item.mint);
    if (validMint == null) {
      console.warn("Existing token awaits mint-owner RPC verification; preserving checkpoint:", item.mint);
      continue;
    }
    const isStonk = item.venue === "stonkfun";
    const pumpCreate = isStonk ? undefined : pumpCreateInstructions(tx).find(instruction => instruction.mint === item.mint);
    const stonkLaunch = isStonk ? stonkFunLaunchInstructions(tx).find(instruction => instruction.mint === item.mint) : undefined;
    const validInstruction = transactionSucceeded && (isStonk
      ? Boolean(stonkLaunch && stonkLaunch.pool === item.poolAddress && stonkLaunch.quoteMint === item.quoteMint)
      : Boolean(pumpCreate));
    if (!validInstruction || !validMint) {
      qualityManifest.quarantinedMints[item.mint] = {
        status: "excluded", reason: isStonk
          ? "Stored StonkFun launch does not match a top-level LaunchLab initializer, configured StonkFun platform config, stored pool/quote mint and token-mint owner."
          : "Stored launch signature does not contain a matching top-level Pump create/create_v2 instruction and token-mint owner.",
        launchSignature: item.launchSignature, venue: item.venue ?? "pumpfun",
        rawPath: `raw/${item.venue ?? "pumpfun"}/${item.mint}/events.jsonl`, retainedForAudit: true
      };
      delete state.tokens[item.mint];
      changed = true;
      console.warn("Quarantined launch that failed strict revalidation:", item.mint);
    } else {
      item.launchVerified = true;
      if (pumpCreate) item.launchInstruction = pumpCreate.kind;
      if (stonkLaunch) item.launchInstruction = stonkLaunch.kind;
      changed = true;
      console.log("Revalidated stored launch against top-level venue initializer:", item.mint);
    }
  }
  if (changed) await persistState();
  for (const mint of Object.keys(qualityManifest.quarantinedMints)) await migrateQuarantinedMint(mint);
  await persistQualityManifest();
}

async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Stopping collector:", reason);
  if (expiryTimer) clearInterval(expiryTimer);
  if (pendingRetryTimer) clearInterval(pendingRetryTimer);
  if (quarantineRetryTimer) clearInterval(quarantineRetryTimer);
  if (runTimer) clearTimeout(runTimer);
  if (discoverySubscription) {
    try { await discoverySubscription.connection.removeOnLogsListener(discoverySubscription.id); } catch {}
  }
  if (stonkDiscoverySubscription) {
    try { await stonkDiscoverySubscription.connection.removeOnLogsListener(stonkDiscoverySubscription.id); } catch {}
  }
  await Promise.all([...activeSubscriptions.keys()].map(stopCapture));
  if (reconciliation) await reconciliation;
  if (stonkReconciliation) await stonkReconciliation;
  await persistState();
  await flushHuggingFaceUploads(true);
  console.log("Collector stopped.");
}
async function main() {
  await loadState();
  await auditExistingLaunches();
  const activeTokens = Object.values(state.tokens).filter(item => item.expiresAt > Date.now() && item.launchVerified === true && !NON_TOKEN_MINTS.has(item.mint));
  const restoreTokens = Object.values(state.tokens).filter(item => item.expiresAt > Date.now() || (state.pendingActivity?.[item.mint]?.length ?? 0) > 0);
  await restoreTokenEvents(restoreTokens.map(item => ({ mint: item.mint, venue: item.venue })));
  await retryPendingActivityTransactions();
  for (const item of activeTokens) {
    await loadActivitySignatures(item);
    await captureMint(item);
  }
  for (const item of activeTokens) await backfillActiveMintActivity(item);
  const discovery = nextRpc();
  const id = await discovery.onLogs(PUMP_PROGRAM, async (logs, context) => {
    if (shuttingDown || logs.err || !CREATE_LOG.test(logs.logs.join("\n"))) return;
    await handleLiveLaunch(logs.signature, logs, context.slot);
  }, "confirmed");
  discoverySubscription = { connection: discovery, id };
  const launchLabDiscovery = nextRpc();
  const stonkId = await launchLabDiscovery.onLogs(LAUNCHLAB_PROGRAM, async (logs, context) => {
    if (shuttingDown || logs.err || !STONK_LAUNCH_LOG.test(logs.logs.join("\n"))) return;
    await handleLiveStonkLaunch(logs.signature, logs, context.slot);
  }, "confirmed");
  stonkDiscoverySubscription = { connection: launchLabDiscovery, id: stonkId };
  console.log("Listening for verified Pump.fun and StonkFun launches; collecting quote-asset prices, pool state, transaction fee telemetry and trade evidence. API keys configured:", keys.length);
  void reconcileMissedLaunches();
  void reconcileMissedStonkLaunches();
  pendingRetryTimer = setInterval(() => { void retryPendingActivityTransactions(); }, 30_000);
  quarantineRetryTimer = setInterval(() => {
    void Promise.all(Object.keys(qualityManifest.quarantinedMints).map(migrateQuarantinedMint));
  }, 120_000);
  expiryTimer = setInterval(async () => {
    for (const item of Object.values(state.tokens)) if (item.expiresAt <= Date.now()) await stopCapture(item.mint);
  }, 15_000);
  if (RUN_FOR_MS > 0) runTimer = setTimeout(() => { void shutdown("configured run window complete"); }, RUN_FOR_MS);
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
main().catch(async error => { console.error(error); await shutdown("fatal error"); process.exitCode = 1; });
