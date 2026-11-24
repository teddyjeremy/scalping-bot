import "dotenv/config";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findPumpCreateInstructions } from "../src/pump-instructions.js";
import { findStonkFunLaunchInstructions } from "../src/launchlab-instructions.js";
import { decodeProgramTradeEvents } from "../src/trade-events.js";
import { findLaunchLabCpmmMigration, findPumpSwapPoolFromInstructions } from "../src/pool-state.js";
import { extractFundingSources, summarizeWalletCohorts, updateWalletProfile, type WalletProfile } from "../src/wallet-analytics.js";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const STONK_CONFIGS = new Set(["6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt", "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"]);
const START = Math.floor(new Date(process.env.HISTORY_START ?? "2026-11-01T00:00:00Z").getTime() / 1000);
const END = Math.floor(new Date(process.env.HISTORY_END ?? "2026-11-24T00:00:00Z").getTime() / 1000);
const ROOT = process.env.DATA_DIR ?? "./historical-data";
const PAGE_SIZE = 100;
const MAX_PAGES = Math.max(1, Number(process.env.HISTORY_MAX_PAGES_PER_RUN ?? 20));
const CAPTURE_SECONDS = 600;
const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter((v): v is string => Boolean(v));
if (keys.length !== 3 || new Set(keys).size !== 3) throw new Error("Historical archive requires three distinct Helius API keys.");
const connections = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
let rpcCursor = 0;
const cooldown = new Map<number, number>();
const lastStarted = new Map<number, number>();
const rpcTails = new Map<number, Promise<void>>();
async function rpc<T>(method: string, run: (connection: Connection) => Promise<T>): Promise<T> {
  let lastError: unknown;
  const tried = new Set<number>();
  for (let attempt = 0; attempt < connections.length; attempt++) {
    let index = -1;
    for (let n = 0; n < connections.length; n++) {
      const candidate = (rpcCursor + n) % connections.length;
      if (!tried.has(candidate) && (cooldown.get(candidate) ?? 0) <= Date.now()) { index = candidate; break; }
    }
    if (index < 0) { await new Promise(resolve => setTimeout(resolve, 1_000)); continue; }
    tried.add(index);
    rpcCursor = (index + 1) % connections.length;
    const previous = rpcTails.get(index) ?? Promise.resolve();
    const request = previous.then(async () => {
      if ((cooldown.get(index) ?? 0) > Date.now()) throw new Error("RPC key is cooling down");
      const wait = Math.max(0, 100 - (Date.now() - (lastStarted.get(index) ?? 0)));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastStarted.set(index, Date.now());
      return run(connections[index]);
    });
    rpcTails.set(index, request.then(() => undefined, () => undefined));
    try { return await request; }
    catch (error) {
      lastError = error;
      const message = String(error);
      if (/429|rate.?limit|too many requests/i.test(message)) cooldown.set(index, Date.now() + 30_000);
      else if (/401|403|invalid api key/i.test(message)) cooldown.set(index, Date.now() + 3_600_000);
      console.warn(`RPC ${method} failed on key slot ${index + 1}; trying another key:`, message.slice(0, 180));
    }
  }
  throw lastError ?? new Error(`No healthy RPC connection for ${method}`);
}
type TradeSourceCursor = { before?: string; complete: boolean; pages: number };
type MintTradeCursor = { before?: string; complete: boolean; pages: number; sources: Record<string, TradeSourceCursor> };
type Cursor = { schemaVersion: 1; start: number; end: number; programs: Record<string, { before?: string; complete: boolean }>; tradeCursors?: Record<string, MintTradeCursor>; launches: Record<string, { venue: string; mint: string; signature: string; slot: number; blockTime: number; creator: string | null; feePayer: string | null; quoteMint: string | null; pool: string | null }> };
const cursorPath = path.join(ROOT, "checkpoint.json");
let state: Cursor = { schemaVersion: 1, start: START, end: END, programs: {}, tradeCursors: {}, launches: {} };
async function save() {
  await mkdir(ROOT, { recursive: true });
  const temp = cursorPath + ".tmp";
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, cursorPath);
}
async function load() {
  await mkdir(ROOT, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as Cursor;
    if (parsed.schemaVersion !== 1 || parsed.start !== START || parsed.end !== END || !parsed.programs || !parsed.launches) throw new Error("Checkpoint schema/date range mismatch");
    state = parsed;
    state.tradeCursors ??= {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function keyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toBase58" in value && typeof (value as {toBase58?: unknown}).toBase58 === "function") return (value as {toBase58: () => string}).toBase58();
  return String(value ?? "");
}
function instructions(tx: ParsedTransactionWithMeta) {
  const convert = (ix: unknown) => {
    const item = ix as { programId?: unknown; data?: unknown; accounts?: unknown[] };
    return { programId: keyString(item.programId), data: item.data, accounts: Array.isArray(item.accounts) ? item.accounts.map(keyString) : [] };
  };
  const topLevel = tx.transaction.message.instructions.map(convert);
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions.map(convert));
  return [...topLevel, ...inner];
}
async function fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
  return rpc("getParsedTransaction", connection => connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
}
function signers(tx: ParsedTransactionWithMeta): string[] {
  const keys = tx.transaction.message.accountKeys;
  return keys.filter(k => "signer" in k && k.signer).map(k => keyString(k.pubkey));
}
async function writeLaunch(record: Cursor["launches"][string], tx: ParsedTransactionWithMeta) {
  const file = path.join(ROOT, "launches", record.venue, record.mint + ".json");
  await mkdir(path.dirname(file), { recursive: true });
  const launchMintBalances = (tx.meta?.postTokenBalances ?? []).filter(balance => balance.mint === record.mint);
  const observedSupplyRaw = launchMintBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const observedSupplyDecimals = launchMintBalances[0]?.uiTokenAmount.decimals ?? null;
  const payload = {
    schemaVersion: 1, recordType: "historical_launch", historicalWindow: { start: START, end: END },
    ...record, observedAt: new Date().toISOString(),
    transaction: {
      signature: record.signature, slot: record.slot, blockTime: record.blockTime,
      feeLamports: tx.meta?.fee ?? null, computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
      err: tx.meta?.err ?? null, signers: signers(tx),
      preBalances: tx.meta?.preBalances ?? [], postBalances: tx.meta?.postBalances ?? [],
      preTokenBalances: tx.meta?.preTokenBalances ?? [], postTokenBalances: tx.meta?.postTokenBalances ?? [],
      logMessages: tx.meta?.logMessages ?? [],
      launchTransactionObservedMintSupplyRaw: observedSupplyRaw > 0n ? observedSupplyRaw.toString() : null,
      launchTransactionObservedMintDecimals: observedSupplyDecimals
    },
    dataQuality: { launchTransactionFetched: true, historicalMintAuthoritySnapshot: false, historicalHolderSnapshot: false, exactLaunchCurveReserves: false, launchTransactionSupplyMayBePartial: true }
  };
  await writeFile(file, JSON.stringify(payload) + "\n");
}
async function scanProgram(program: string, venue: "pumpfun" | "stonkfun") {
  const progress = state.programs[program] ?? { complete: false };
  if (progress.complete) return;
  let before = progress.before;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const signatures = await rpc("getSignaturesForAddress", c => c.getSignaturesForAddress(new PublicKey(program), { limit: PAGE_SIZE, ...(before ? { before } : {}) }, "confirmed"));
    if (!signatures.length) { progress.complete = true; break; }
    const eligible = signatures.filter(s => s.blockTime != null && s.blockTime >= START && s.blockTime < END).reverse();
    const hydrated = await Promise.all(eligible.map(async entry => ({ entry, tx: await fetchTx(entry.signature) })));
    for (const { entry, tx } of hydrated) {
      if (!tx) throw new Error(`Missing historical transaction ${entry.signature}; checkpoint remains on this page.`);
      if (!tx.meta?.err) {
        const top = instructions(tx);
        const launches = venue === "pumpfun"
          ? findPumpCreateInstructions(top, PUMP).map(x => ({ mint: x.mint, creator: x.creator, feePayer: signers(tx)[0] ?? null, quoteMint: "So11111111111111111111111111111111111111112", pool: null }))
          : findStonkFunLaunchInstructions(top, LAUNCHLAB, STONK_CONFIGS).map(x => ({ mint: x.mint, creator: x.creator, feePayer: x.payer, quoteMint: x.quoteMint, pool: x.pool }));
        for (const launch of launches) {
          if (state.launches[launch.mint]) continue;
          const record = { venue, mint: launch.mint, signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime!, creator: launch.creator, feePayer: launch.feePayer, quoteMint: launch.quoteMint, pool: launch.pool };
          state.launches[launch.mint] = record;
          await writeLaunch(record, tx);
          console.log(`Archived ${venue} launch ${launch.mint} at ${new Date(entry.blockTime! * 1000).toISOString()}`);
        }
      }
    }
    before = signatures[signatures.length - 1].signature;
    progress.before = before;
    state.programs[program] = progress;
    await save();
    pages++;
    const oldest = signatures[signatures.length - 1].blockTime;
    if (oldest != null && oldest < START) { progress.complete = true; await save(); break; }
    if (signatures.length < PAGE_SIZE) { progress.complete = true; await save(); break; }
    console.log(`Historical ${venue}: page ${pages}/${MAX_PAGES}, launches archived=${Object.keys(state.launches).length}`);
  }
  state.programs[program] = progress;
  await save();
}
function impliedQuotePrice(quoteRaw: bigint, tokenRaw: bigint, tokenDecimals: number | null, quoteDecimals: number | null): string | null {
  if (tokenDecimals == null || quoteDecimals == null || tokenRaw <= 0n) return null;
  const scale = 10n ** 18n;
  const numerator = quoteRaw * (10n ** BigInt(tokenDecimals)) * scale;
  const denominator = tokenRaw * (10n ** BigInt(quoteDecimals));
  const value = numerator / denominator;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
async function collectMintTrades(record: Cursor["launches"][string]) {
  const directory = path.join(ROOT, "trades", record.venue, record.mint);
  await mkdir(directory, { recursive: true });
  const until = record.blockTime + CAPTURE_SECONDS;
  const curve = record.venue === "pumpfun"
    ? PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(record.mint).toBuffer()], new PublicKey(PUMP))[0].toBase58()
    : null;
  const addresses = [...new Set([record.mint, record.pool, curve].filter((v): v is string => Boolean(v)))];
  const progress = state.tradeCursors![record.mint] ?? { complete: false, pages: 0, sources: {} };
  progress.sources ??= {};
  for (let sourceIndex = 0; sourceIndex < addresses.length; sourceIndex++) {
    const address = addresses[sourceIndex];
    const source: TradeSourceCursor = progress.sources[address] ?? { complete: false, pages: 0 };
    while (!source.complete && source.pages < MAX_PAGES) {
      const page = await rpc("getSignaturesForAddress(source)", c => c.getSignaturesForAddress(new PublicKey(address), { limit: 100, ...(source.before ? { before: source.before } : {}) }, "confirmed"));
      if (!page.length) { source.complete = true; break; }
      const ordered = [...page].reverse();
      const reachedLaunchBoundary = ordered.some(item => item.blockTime != null && item.blockTime < record.blockTime);
      const candidates = ordered.filter(item => item.blockTime != null && item.blockTime >= record.blockTime && item.blockTime <= until);
      const hydrated = await Promise.all(candidates.map(async item => ({ item, tx: await fetchTx(item.signature) })));
      const lines: string[] = [];
      for (const { item, tx } of hydrated) {
        if (!tx?.meta || tx.meta.err) continue;
        const txInstructions = instructions(tx);
        const pumpPool = findPumpSwapPoolFromInstructions(txInstructions, record.mint);
        const launchLabMigration = findLaunchLabCpmmMigration(txInstructions, record.mint);
        for (const discovered of [pumpPool?.pool, launchLabMigration?.pool]) {
          if (discovered && !addresses.includes(discovered)) addresses.push(discovered);
        }
        const decoded = decodeProgramTradeEvents(tx.meta.logMessages, record.mint, txInstructions);
        for (const event of decoded) {
          const tokenDecimals = tx.meta.preTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals ?? null;
          const quoteDecimals = event.quoteMint === "So11111111111111111111111111111111111111112" ? 9
            : tx.meta.preTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals ?? null;
          lines.push(JSON.stringify({
            schemaVersion: 1, recordType: "historical_trade_event", venue: event.venue, mint: record.mint,
            launchSignature: record.signature, signature: item.signature, sourceAddress: address,
            slot: item.slot, blockTime: item.blockTime!, secondsSinceLaunch: item.blockTime! - record.blockTime,
            eventTimestamp: event.timestamp, side: event.side, user: event.user,
            creator: record.creator, launchFeePayer: record.feePayer, launchSlot: record.slot, launchTime: record.blockTime,
            transactionFeePayer: signers(tx)[0] ?? null, fundingSources: extractFundingSources(tx, event.user),
            tokenAmountRaw: event.tokenAmountRaw.toString(), tokenDecimals,
            quoteMint: event.quoteMint, quoteAmountRaw: event.quoteAmountRaw.toString(), quoteDecimals,
            protocolFeeRaw: event.protocolFeeRaw?.toString() ?? null,
            platformFeeRaw: event.platformFeeRaw?.toString() ?? null,
            lpFeeRaw: event.lpFeeRaw?.toString() ?? null, creatorFeeRaw: event.creatorFeeRaw?.toString() ?? null,
            shareFeeRaw: event.shareFeeRaw?.toString() ?? null, transactionFeeLamports: tx.meta.fee,
            computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? null,
            preTokenBalances: tx.meta.preTokenBalances ?? [], postTokenBalances: tx.meta.postTokenBalances ?? [],
            preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances,
            reserveEvidence: { virtualQuoteReservesRaw: event.virtualQuoteReservesRaw?.toString() ?? null, realQuoteReservesRaw: event.realQuoteReservesRaw?.toString() ?? null, preTradeBaseReserveRaw: event.preTradeBaseReserveRaw?.toString() ?? null, preTradeQuoteReserveRaw: event.preTradeQuoteReserveRaw?.toString() ?? null },
            impliedQuotePrice: impliedQuotePrice(event.quoteAmountRaw, event.tokenAmountRaw, tokenDecimals, quoteDecimals),
            dataQuality: { decodedFromProgramEvent: true, historicalHolderSnapshot: false, priceUsd: null, fdvUsd: null, tokenDecimalsKnown: tokenDecimals != null, quoteDecimalsKnown: quoteDecimals != null }
          }));
        }
      }
      const pageFile = path.join(directory, `source-${sourceIndex}-page-${String(source.pages + 1).padStart(6, "0")}.jsonl`);
      await writeFile(pageFile, lines.length ? lines.join("\n") + "\n" : "");
      source.before = page[page.length - 1].signature;
      source.pages++;
      if (reachedLaunchBoundary || page.length < 100) source.complete = true;
      progress.sources[address] = source;
      progress.pages = Object.values(progress.sources).reduce<number>((sum, item) => sum + item.pages, 0);
      progress.complete = addresses.every(candidate => progress.sources?.[candidate]?.complete);
      state.tradeCursors![record.mint] = progress;
      await save();
    }
    progress.sources[address] = source;
    progress.complete = addresses.every(candidate => progress.sources?.[candidate]?.complete);
    state.tradeCursors![record.mint] = progress;
    await save();
  }
  return progress.complete;
}
async function buildMintResearchSummary(record: Cursor["launches"][string]) {
  const directory = path.join(ROOT, "trades", record.venue, record.mint);
  const names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")).sort();
  const launchData = JSON.parse(await readFile(path.join(ROOT, "launches", record.venue, record.mint + ".json"), "utf8")) as { transaction?: { launchTransactionObservedMintSupplyRaw?: string | null; launchTransactionObservedMintDecimals?: number | null } };
  const observedSupplyRaw = launchData.transaction?.launchTransactionObservedMintSupplyRaw ?? null;
  const observedSupplyDecimals = launchData.transaction?.launchTransactionObservedMintDecimals ?? null;
  const observedSupply = observedSupplyRaw && observedSupplyDecimals != null
    ? Number(BigInt(observedSupplyRaw)) / (10 ** observedSupplyDecimals) : null;
  const profilesByQuoteMint = new Map<string, Record<string, WalletProfile>>();
  const pricesByQuoteMint = new Map<string, Array<{ at: number; price: number; slot: number }>>();
  const seen = new Set<string>();
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buyEvents = 0;
  let sellEvents = 0;
  let missingDecimalEvents = 0;
  let duplicateEvents = 0;
  for (const name of names) {
    const content = await readFile(path.join(directory, name), "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.recordType !== "historical_trade_event") continue;
      const signature = String(event.signature ?? "");
      const user = String(event.user ?? "");
      const side = event.side === "buy" || event.side === "sell" ? event.side : null;
      const quoteMint = String(event.quoteMint ?? "");
      const tokenRaw = BigInt(String(event.tokenAmountRaw ?? "0"));
      const quoteRaw = BigInt(String(event.quoteAmountRaw ?? "0"));
      const dedupe = [signature, user, side, tokenRaw.toString(), quoteRaw.toString(), quoteMint].join(":");
      if (!signature || !user || !side || !quoteMint || tokenRaw <= 0n || quoteRaw <= 0n) continue;
      if (seen.has(dedupe)) { duplicateEvents++; continue; }
      seen.add(dedupe);
      if (side === "buy") { buyEvents++; buyers.add(user); } else { sellEvents++; sellers.add(user); }
      const tokenDecimals = typeof event.tokenDecimals === "number" ? event.tokenDecimals : null;
      const quoteDecimals = typeof event.quoteDecimals === "number" ? event.quoteDecimals : null;
      const tokenAmount = tokenDecimals == null ? null : Number(tokenRaw) / (10 ** tokenDecimals);
      const quoteAmount = quoteDecimals == null ? null : Number(quoteRaw) / (10 ** quoteDecimals);
      const at = Number(event.blockTime) * 1000;
      const slot = Number(event.slot);
      const price = typeof event.impliedQuotePrice === "string" ? Number(event.impliedQuotePrice) : NaN;
      if (Number.isFinite(price) && price > 0) {
        const path = pricesByQuoteMint.get(quoteMint) ?? [];
        path.push({ at, price, slot });
        pricesByQuoteMint.set(quoteMint, path);
      }
      if (tokenAmount == null || quoteAmount == null || !Number.isFinite(tokenAmount) || !Number.isFinite(quoteAmount) || tokenAmount <= 0 || quoteAmount <= 0) {
        missingDecimalEvents++;
        continue;
      }
      const profiles = profilesByQuoteMint.get(quoteMint) ?? {};
      profiles[user] = updateWalletProfile(profiles[user], {
        wallet: user, side, tokenAmount, quoteAmount, confidence: "high"
      }, {
        observedAt: at, slot, launchSlot: record.slot, launchAt: record.blockTime * 1000,
        launchFeePayer: record.feePayer, creator: record.creator,
        fundingSources: Array.isArray(event.fundingSources) ? event.fundingSources.filter((v): v is string => typeof v === "string") : [],
        signature, feePayer: typeof event.transactionFeePayer === "string" ? event.transactionFeePayer : null,
        networkFeeLamports: typeof event.transactionFeeLamports === "number" ? event.transactionFeeLamports : 0
      });
      profilesByQuoteMint.set(quoteMint, profiles);
    }
  }
  const priceSummaryByQuoteMint: Record<string, unknown> = {};
  for (const [quoteMint, points] of pricesByQuoteMint) {
    points.sort((a, b) => a.at - b.at || a.slot - b.slot);
    const first = points[0];
    const last = points[points.length - 1];
    const high = points.reduce((value, point) => Math.max(value, point.price), Number.NEGATIVE_INFINITY);
    const low = points.reduce((value, point) => Math.min(value, point.price), Number.POSITIVE_INFINITY);
    let peak = first.price;
    let maxDrawdownPct = 0;
    for (const point of points) {
      peak = Math.max(peak, point.price);
      maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - point.price) / peak) * 100 : 0);
    }
    const horizons = [30, 60, 120, 180, 300, 600];
    const priceAt = Object.fromEntries(horizons.map(seconds => {
      const point = points.find(p => p.at >= record.blockTime * 1000 + seconds * 1000);
      return [String(seconds), point ? { price: point.price, observedAt: point.at } : null];
    }));
    priceSummaryByQuoteMint[quoteMint] = {
      quoteMint, observationCount: points.length, firstPrice: first.price, lastPrice: last.price,
      highPrice: high, lowPrice: low, returnPct: first.price > 0 ? ((last.price / first.price) - 1) * 100 : null,
      maxDrawdownPct, priceAtSecondsAfterLaunch: priceAt,
      launchTransactionObservedSupplyValuation: observedSupply != null ? { first: first.price * observedSupply, last: last.price * observedSupply, high: high * observedSupply, quoteMint, notVerifiedAsFullMarketCap: true } : null,
      priceUnit: "quote asset " + quoteMint + " per whole token",
      caveat: "Trade-implied price from decoded event amounts; not an oracle USD price or guaranteed executable quote."
    };
  }
  const cohortsByQuoteMint: Record<string, unknown> = {};
  for (const [quoteMint, profiles] of profilesByQuoteMint) {
    const latestPrice = (priceSummaryByQuoteMint[quoteMint] as { lastPrice?: number } | undefined)?.lastPrice ?? null;
    cohortsByQuoteMint[quoteMint] = {
      summary: summarizeWalletCohorts(profiles, latestPrice),
      walletProfiles: Object.values(profiles).sort((a, b) => b.quoteSpent - a.quoteSpent)
    };
  }
  const creatorWallets = [...new Set(Object.values(cohortsByQuoteMint).flatMap(group => {
    const data = group as { walletProfiles?: WalletProfile[] };
    return (data.walletProfiles ?? []).filter(p => p.creator).map(p => p.wallet);
  }))];
  const feePayerWallets = [...new Set(Object.values(cohortsByQuoteMint).flatMap(group => {
    const data = group as { walletProfiles?: WalletProfile[] };
    return (data.walletProfiles ?? []).filter(p => p.launchFeePayer).map(p => p.wallet);
  }))];
  const summary = {
    schemaVersion: 1, recordType: "historical_launch_research_summary", venue: record.venue, mint: record.mint,
    launchSignature: record.signature, launchTime: record.blockTime, launchSlot: record.slot,
    creator: record.creator, launchFeePayer: record.feePayer, quoteMintAtLaunch: record.quoteMint,
    tradeEvents: { total: buyEvents + sellEvents, buys: buyEvents, sells: sellEvents, uniqueBuyers: buyers.size, uniqueSellers: sellers.size, duplicateEventsRemoved: duplicateEvents, missingDecimalEvents },
    developerActivity: { creatorWallets, launchFeePayerWallets: feePayerWallets, profiles: [...creatorWallets, ...feePayerWallets].filter((v, i, a) => a.indexOf(v) === i) },
    priceSummaryByQuoteMint, walletCohortsByQuoteMint: cohortsByQuoteMint,
    dataQuality: {
      historicalUsdPrice: false, historicalFdv: false, historicalTotalSupply: false,
      launchTransactionObservedSupplyRaw: observedSupplyRaw, launchTransactionObservedSupplyMayBePartial: true,
      historicalHolderSnapshots: false, transactionEventAmounts: "decoded program events",
      walletClassification: "heuristics only; bot/sniper/bundle labels are candidates, not proof"
    }
  };
  await writeFile(path.join(ROOT, "launches", record.venue, record.mint + ".summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
async function main() {
  if (!(START < END)) throw new Error("HISTORY_START must be earlier than HISTORY_END.");
  await load();
  console.log(`Historical research archive only. Window ${new Date(START * 1000).toISOString()} to ${new Date(END * 1000).toISOString()}. No trading or order submission.`);
  await scanProgram(PUMP, "pumpfun");
  await scanProgram(LAUNCHLAB, "stonkfun");
  for (const record of Object.values(state.launches)) {
    if (state.tradeCursors?.[record.mint]?.complete) continue;
    await collectMintTrades(record);
    if (state.tradeCursors?.[record.mint]?.complete) await buildMintResearchSummary(record);
  }
  console.log(`Historical pass complete for this run. Launches indexed: ${Object.keys(state.launches).length}. Program scan completion: ${JSON.stringify(Object.fromEntries(Object.entries(state.programs).map(([k,v]) => [k,v.complete])))}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
