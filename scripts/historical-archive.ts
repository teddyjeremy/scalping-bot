import "dotenv/config";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findPumpCreateInstructions } from "../src/pump-instructions.js";
import { findStonkFunLaunchInstructions } from "../src/launchlab-instructions.js";
import { decodeProgramTradeEvents } from "../src/trade-events.js";

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
    tried.add(index); rpcCursor = (index + 1) % connections.length;
    const wait = Math.max(0, 100 - (Date.now() - (lastStarted.get(index) ?? 0)));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastStarted.set(index, Date.now());
    try { return await run(connections[index]); }
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
type TradeSourceCursor = { before?: string; complete: boolean; pages: number };\ntype MintTradeCursor = { before?: string; complete: boolean; pages: number; sources: Record<string, TradeSourceCursor> };\ntype Cursor = { schemaVersion: 1; start: number; end: number; programs: Record<string, { before?: string; complete: boolean }>; tradeCursors?: Record<string, MintTradeCursor>; launches: Record<string, { venue: string; mint: string; signature: string; slot: number; blockTime: number; creator: string | null; quoteMint: string | null; pool: string | null }> };
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
  const payload = {
    schemaVersion: 1, recordType: "historical_launch", historicalWindow: { start: START, end: END },
    ...record, observedAt: new Date().toISOString(),
    transaction: {
      signature: record.signature, slot: record.slot, blockTime: record.blockTime,
      feeLamports: tx.meta?.fee ?? null, computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
      err: tx.meta?.err ?? null, signers: signers(tx),
      preBalances: tx.meta?.preBalances ?? [], postBalances: tx.meta?.postBalances ?? [],
      preTokenBalances: tx.meta?.preTokenBalances ?? [], postTokenBalances: tx.meta?.postTokenBalances ?? [],
      logMessages: tx.meta?.logMessages ?? []
    },
    dataQuality: { launchTransactionFetched: true, historicalMintAuthoritySnapshot: false, historicalHolderSnapshot: false, exactLaunchCurveReserves: false }
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
    const eligible = signatures.filter(s => s.blockTime != null && s.blockTime >= START && s.blockTime < END);
    for (const entry of eligible.reverse()) {
      if (state.processedSignatures.includes(entry.signature)) continue;
      const tx = await fetchTx(entry.signature);
      if (!tx) throw new Error(`Missing historical transaction ${entry.signature}; checkpoint remains on this page.`);
      if (!tx.meta?.err) {
        const top = instructions(tx);
        const launches = venue === "pumpfun"
          ? findPumpCreateInstructions(top, PUMP).map(x => ({ mint: x.mint, creator: signers(tx)[0] ?? null, quoteMint: "So11111111111111111111111111111111111111112", pool: null }))
          : findStonkFunLaunchInstructions(top, LAUNCHLAB, STONK_CONFIGS).map(x => ({ mint: x.mint, creator: x.creator, quoteMint: x.quoteMint, pool: x.pool }));
        for (const launch of launches) {
          if (state.launches[launch.mint]) continue;
          const record = { venue, mint: launch.mint, signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime!, creator: launch.creator, quoteMint: launch.quoteMint, pool: launch.pool };
          state.launches[launch.mint] = record;
          await writeLaunch(record, tx);
          console.log(`Archived ${venue} launch ${launch.mint} at ${new Date(entry.blockTime! * 1000).toISOString()}`);
        }
      }
      state.processedSignatures.push(entry.signature);
      if (state.processedSignatures.length > 100_000) state.processedSignatures = state.processedSignatures.slice(-50_000);
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
      let reachedLaunchBoundary = false;
      const lines: string[] = [];
      for (const item of [...page].reverse()) {
        if (item.blockTime == null) continue;
        if (item.blockTime < record.blockTime) { reachedLaunchBoundary = true; continue; }
        if (item.blockTime > until) continue;
        const tx = await fetchTx(item.signature);
        if (!tx?.meta || tx.meta.err) continue;
        const decoded = decodeProgramTradeEvents(tx.meta.logMessages, record.mint, instructions(tx));
        for (const event of decoded) {
          const tokenDecimals = tx.meta.preTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals ?? null;
          const quoteDecimals = event.quoteMint === "So11111111111111111111111111111111111111112" ? 9
            : tx.meta.preTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals ?? null;
          lines.push(JSON.stringify({
            schemaVersion: 1, recordType: "historical_trade_event", venue: event.venue, mint: record.mint,
            launchSignature: record.signature, signature: item.signature, sourceAddress: address,
            slot: item.slot, blockTime: item.blockTime, secondsSinceLaunch: item.blockTime - record.blockTime,
            eventTimestamp: event.timestamp, side: event.side, user: event.user,
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
async function main() {
  if (!(START < END)) throw new Error("HISTORY_START must be earlier than HISTORY_END.");
  await load();
  console.log(`Historical research archive only. Window ${new Date(START * 1000).toISOString()} to ${new Date(END * 1000).toISOString()}. No trading or order submission.`);
  await scanProgram(PUMP, "pumpfun");
  await scanProgram(LAUNCHLAB, "stonkfun");
  for (const record of Object.values(state.launches)) {
    if (state.tradeCursors?.[record.mint]?.complete) continue;
    await collectMintTrades(record);
  }
  console.log(`Historical pass complete for this run. Launches indexed: ${Object.keys(state.launches).length}. Program scan completion: ${JSON.stringify(Object.fromEntries(Object.entries(state.programs).map(([k,v]) => [k,v.complete])))}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
