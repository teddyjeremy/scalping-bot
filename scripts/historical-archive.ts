import "dotenv/config";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findPumpCreateInstructions } from "../src/pump-instructions.js";
import { findStonkFunLaunchInstructions } from "../src/launchlab-instructions.js";
import { normalizeTransactionInstructions, type CompiledOrParsedInstruction } from "../src/transaction-instructions.js";
import { decodeProgramTradeEvents } from "../src/trade-events.js";
import { findLaunchLabCpmmMigration, findPumpSwapPoolFromInstructions } from "../src/pool-state.js";
import { extractFundingSources, summarizeWalletCohorts, updateWalletProfile, type WalletProfile } from "../src/wallet-analytics.js";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PUMP_MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], new PublicKey(PUMP))[0].toBase58();
const STONK_CONFIGS = new Set(["6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt", "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"]);
const START = Math.floor(new Date(process.env.HISTORY_START ?? "2026-11-01T00:00:00Z").getTime() / 1000);
const END = Math.floor(new Date(process.env.HISTORY_END ?? "2026-11-24T00:00:00Z").getTime() / 1000);
const ROOT = process.env.DATA_DIR ?? "./historical-data";
const PAGE_SIZE = 100;
const MAX_PAGES = Math.max(1, Number(process.env.HISTORY_MAX_PAGES_PER_RUN ?? 20));
const MAX_LAUNCHLAB_PAGES = Math.max(1, Number(process.env.HISTORY_MAX_LAUNCHLAB_PAGES_PER_RUN ?? 5));
const MAX_TRADE_COINS_PER_RUN = Math.max(0, Number(process.env.HISTORY_MAX_TRADE_COINS_PER_RUN ?? 0));
const CAPTURE_SECONDS = 600;
const MIN_RPC_INTERVAL_MS = Math.max(100, Number(process.env.HELIUS_RPC_MIN_INTERVAL_MS ?? 2000));
const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter((v): v is string => Boolean(v));
if (keys.length !== 3 || new Set(keys).size !== 3) throw new Error("Historical archive requires three distinct Helius API keys.");
const connections = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
class RpcCoolingDownError extends Error { constructor() { super("All three Helius RPC keys are temporarily rate-limited; checkpoint saved for scheduled resume."); this.name = "RpcCoolingDownError"; } }
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
      const wait = Math.max(0, MIN_RPC_INTERVAL_MS - (Date.now() - (lastStarted.get(index) ?? 0)));
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
  if (connections.every((_, index) => (cooldown.get(index) ?? 0) > Date.now())) throw new RpcCoolingDownError();
  throw lastError ?? new Error(`No healthy RPC connection for ${method}`);
}
type HeliusHistoryRow = {
  signature?: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
  transaction?: unknown;
  meta?: unknown;
};
type HeliusHistoryPage = { data: HeliusHistoryRow[]; paginationToken: string | null };
// Free-tier keys cannot call getTransactionsForAddress (paid-plan endpoint).
// Use standard Solana RPC history pagination from the first request.
let enhancedHistorySupport: boolean | null = false;
function historyRowSignature(row: HeliusHistoryRow): string {
  if (typeof row.signature === "string" && row.signature) return row.signature;
  const transaction = row.transaction as { signatures?: unknown[] } | undefined;
  const first = transaction?.signatures?.[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "signature" in first && typeof (first as { signature?: unknown }).signature === "string") {
    return (first as { signature: string }).signature;
  }
  return "";
}
async function getHeliusHistoryPage(address: string, start: number, end: number, paginationToken?: string): Promise<HeliusHistoryPage | null> {
  if (enhancedHistorySupport === false) return null;
  try {
    const page = await rpc("getTransactionsForAddress", async connection => {
      const keyIndex = connections.indexOf(connection);
      const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${keys[keyIndex]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "historical-archive", method: "getTransactionsForAddress",
          params: [address, {
            transactionDetails: "full", sortOrder: "asc", limit: 100, commitment: "confirmed",
            encoding: "jsonParsed", maxSupportedTransactionVersion: 1,
            ...(paginationToken ? { paginationToken } : {}),
            filters: { blockTime: { gte: start, lt: end }, status: "any" }
          }]
        })
      });
      const responseText = await response.text();
      if (response.status === 429) throw new Error("HTTP 429 Too Many Requests");
      if (!response.ok) throw new Error(`Helius history HTTP ${response.status}: ${responseText.slice(0, 300)}`);
      let body: { result?: HeliusHistoryPage; error?: { code?: number; message?: string } };
      try { body = JSON.parse(responseText) as typeof body; }
      catch { throw new Error(`Helius history returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 120)}`); }
      if (body.error) throw new Error(`Helius history RPC ${body.error.code ?? ""}: ${body.error.message ?? "unknown error"}`);
      if (!body.result || !Array.isArray(body.result.data)) throw new Error("Helius history RPC returned an unexpected response shape.");
      const data = body.result.data.map(row => {
        const signature = historyRowSignature(row);
        if (!signature) throw new Error("Helius full-history row is missing a transaction signature in both the row and transaction.signatures.");
        if (typeof row.slot !== "number") throw new Error("Helius full-history row is missing its slot.");
        return { ...row, signature };
      });
      return { ...body.result, data };
    });
    enhancedHistorySupport = true;
    return page;
  } catch (error) {
    const message = String(error);
    if (/method not found|not available|not supported|unauthorized|forbidden|\\b401\\b|\\b402\\b|\\b403\\b|insufficient credits|credit balance|paid plan/i.test(message)) {
      enhancedHistorySupport = false;
      console.warn("Helius getTransactionsForAddress is unavailable for these keys; using standard RPC history fallback.");
      return null;
    }
    throw error;
  }
}
function asParsedTransaction(row: HeliusHistoryRow): ParsedTransactionWithMeta | null {
  if (!row.transaction || !row.meta) return null;
  return { transaction: row.transaction, meta: row.meta } as ParsedTransactionWithMeta;
}
async function hydrateHistoryRows(rows: HeliusHistoryRow[], label: string) {
  const hydrated: Array<{ entry: { signature: string; slot: number; blockTime: number | null }; tx: ParsedTransactionWithMeta | null; providerRecord: HeliusHistoryRow }> = [];
  const chunkSize = 50;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const result = await Promise.all(chunk.map(async row => ({
      entry: { signature: historyRowSignature(row), slot: row.slot, blockTime: row.blockTime },
      tx: asParsedTransaction(row) ?? await fetchTx(historyRowSignature(row)),
      providerRecord: row
    })));
    hydrated.push(...result);
    console.log(`${label}: hydrated ${Math.min(offset + chunk.length, rows.length)}/${rows.length} transactions`);
  }
  return hydrated;
}
type TradeSourceCursor = { before?: string; paginationToken?: string; complete: boolean; pages: number };
type MintTradeCursor = { before?: string; complete: boolean; pages: number; sources: Record<string, TradeSourceCursor> };
type LaunchLabIndexCursor = { nextPageId?: string; complete: boolean; pages: number; lastCreateAt?: number };
type Cursor = { schemaVersion: 1; start: number; end: number; programs: Record<string, { before?: string; paginationToken?: string; address?: string; complete: boolean }>; tradeCursors?: Record<string, MintTradeCursor>; launchLabIndexes?: Record<string, LaunchLabIndexCursor>; launches: Record<string, { venue: string; mint: string; signature: string; slot: number; blockTime: number; creator: string | null; feePayer: string | null; quoteMint: string | null; pool: string | null }> };
const cursorPath = path.join(ROOT, "checkpoint.json");
const mintShard = (mint: string) => createHash("sha256").update(mint).digest("hex").slice(0, 2);
const launchRecordPath = (record: { venue: string; mint: string }, suffix = ".json") => path.join(ROOT, "launches", record.venue, mintShard(record.mint), record.mint + suffix);
const tradeRecordDirectory = (record: { venue: string; mint: string }) => path.join(ROOT, "trades", record.venue, mintShard(record.mint), record.mint);
let state: Cursor = { schemaVersion: 1, start: START, end: END, programs: {}, tradeCursors: {}, launchLabIndexes: {}, launches: {} };
let saveQueue: Promise<void> = Promise.resolve();
let uploadQueue: Promise<void> = Promise.resolve();
let pagesSinceUpload = 0;
const UPLOAD_EVERY_PAGES = Math.max(1, Number(process.env.HISTORY_UPLOAD_EVERY_PAGES ?? 20));
const dirtyFiles = new Set<string>();
function queueDirtyFile(file: string) { dirtyFiles.add(path.relative(path.resolve(ROOT), path.resolve(file)).replaceAll(path.sep, "/")); }
const UPLOAD_BATCH_COINS = Math.max(1, Number(process.env.HISTORY_UPLOAD_BATCH_COINS ?? 5));
function coinKeyFromLocalPath(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] === "launches" && parts.length >= 4) {
    return parts[1] + "/" + parts[3].replace(/\\.summary\\.json$|\\.json$/, "");
  }
  if (parts[0] === "trades" && parts.length >= 5) return parts[1] + "/" + parts[3];
  return null;
}
async function uploadDirtyFiles(force = false) {
  const run = uploadQueue.then(async () => {
    const allFiles = [...dirtyFiles];
    const coinKeys = [...new Set(allFiles.map(coinKeyFromLocalPath).filter((v): v is string => v !== null))].sort();
    if (!force && coinKeys.length < UPLOAD_BATCH_COINS) {
      console.log(`Remote batch waiting: ${coinKeys.length}/${UPLOAD_BATCH_COINS} coins staged; local checkpoint is already saved.`);
      return;
    }
    const selectedKeys = force ? new Set(coinKeys) : new Set(coinKeys.slice(0, UPLOAD_BATCH_COINS));
    const files = allFiles.filter(file => {
      const key = coinKeyFromLocalPath(file);
      return key !== null && selectedKeys.has(key);
    });
    if (!files.length) return;
    execFileSync("python", ["scripts/hf-dataset-v3-sync.py", "publish-batch", ...files], { stdio: "inherit" });
    for (const file of files) dirtyFiles.delete(file);
  });
  uploadQueue = run.catch(() => undefined);
  await run;
}
async function save() {
  const write = saveQueue.then(async () => {
    await mkdir(ROOT, { recursive: true });
    const temp = cursorPath + ".tmp";
    await writeFile(temp, JSON.stringify(state, null, 2));
    await rename(temp, cursorPath);
  });
  saveQueue = write.catch(() => undefined);
  await write;
}
async function load() {
  await mkdir(ROOT, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(cursorPath, "utf8")) as Cursor;
    if (parsed.schemaVersion !== 1 || parsed.start !== START || parsed.end !== END || !parsed.programs || !parsed.launches) throw new Error("Checkpoint schema/date range mismatch");
    state = parsed;
    state.tradeCursors ??= {};
    state.launchLabIndexes ??= {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function keyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toBase58" in value && typeof (value as {toBase58?: unknown}).toBase58 === "function") return (value as {toBase58: () => string}).toBase58();
  return String(value ?? "");
}
function instructions(tx: ParsedTransactionWithMeta): CompiledOrParsedInstruction[] {
  const message = tx.transaction.message as unknown as {
    accountKeys: readonly unknown[];
    instructions: readonly CompiledOrParsedInstruction[];
  };
  const inner = (tx.meta?.innerInstructions ?? []) as unknown as Array<{ instructions: readonly CompiledOrParsedInstruction[] }>;
  return normalizeTransactionInstructions(message, inner);
}
async function fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
  return rpc("getParsedTransaction", connection => connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 }));
}
function signers(tx: ParsedTransactionWithMeta): string[] {
  const keys = tx.transaction.message.accountKeys;
  return keys.filter(k => "signer" in k && k.signer).map(k => keyString(k.pubkey));
}
async function writeLaunch(record: Cursor["launches"][string], tx: ParsedTransactionWithMeta) {
  const file = launchRecordPath(record);
  await mkdir(path.dirname(file), { recursive: true });
  const launchMintBalances = (tx.meta?.postTokenBalances ?? []).filter(balance => balance.mint === record.mint);
  const touchedBalanceSumRaw = launchMintBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const touchedBalanceDecimals = launchMintBalances[0]?.uiTokenAmount.decimals ?? null;
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
      launchTransactionTouchedAccountBalanceSumRaw: touchedBalanceSumRaw > 0n ? touchedBalanceSumRaw.toString() : null,
      launchTransactionTouchedAccountBalanceDecimals: touchedBalanceDecimals
    },
    dataQuality: { launchTransactionFetched: true, historicalMintAuthoritySnapshot: false, historicalHolderSnapshot: false, exactLaunchCurveReserves: false, launchTransactionTouchedBalanceSumIsNotTotalSupply: true }
  };
  await writeFile(file, JSON.stringify(payload) + "\n");
  queueDirtyFile(file);
}
async function scanProgram(program: string, venue: "pumpfun" | "stonkfun") {
  const queryAddress = program;
  let progress = state.programs[program] ?? { complete: false };
  if ((progress.address && progress.address !== queryAddress) || (venue === "pumpfun" && !progress.address)) {
    progress = { complete: false, address: queryAddress };
  } else {
    progress.address = queryAddress;
  }
  if (progress.complete) return;
  let pages = 0;
  let createInstructionsFound = 0;
  let pumpProgramInstructionsSeen = 0;
  while (pages < MAX_PAGES) {
    const enhanced = await getHeliusHistoryPage(queryAddress, START, END, progress.paginationToken);
    let hydrated: Array<{ entry: { signature: string; slot: number; blockTime: number | null }; tx: ParsedTransactionWithMeta | null }>;
    if (enhanced) {
      if (venue === "pumpfun" && pages === 0 && enhanced.data.length === 0) throw new Error("Pump mint-authority history index returned no transactions for the requested historical window.");
      hydrated = (await hydrateHistoryRows(enhanced.data, `Launch index ${venue} page ${pages + 1}`))
        .filter(row => row.entry.blockTime != null && row.entry.blockTime >= START && row.entry.blockTime < END);
      progress.paginationToken = enhanced.paginationToken ?? undefined;
      if (!enhanced.data.length || !enhanced.paginationToken) progress.complete = true;
    } else {
      const signatures = await rpc("getSignaturesForAddress", c => c.getSignaturesForAddress(new PublicKey(queryAddress), { limit: PAGE_SIZE, ...(progress.before ? { before: progress.before } : {}) }, "confirmed"));
      if (!signatures.length) {
        if (venue === "pumpfun" && pages === 0) throw new Error("Pump mint-authority address has no indexed signatures; refusing to mark the historical scan complete.");
        progress.complete = true; state.programs[program] = progress; await save(); break;
      }
      const eligible = signatures.filter(entry => entry.blockTime != null && entry.blockTime >= START && entry.blockTime < END).reverse();
      hydrated = await Promise.all(eligible.map(async entry => ({ entry: { signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime ?? null }, tx: await fetchTx(entry.signature) })));
      progress.before = signatures[signatures.length - 1].signature;
      const oldest = signatures[signatures.length - 1].blockTime;
      if (oldest != null && oldest < START || signatures.length < PAGE_SIZE) progress.complete = true;
    }
    for (const { entry, tx } of hydrated) {
      if (entry.blockTime == null) continue;
      if (!tx || !tx.meta) throw new Error(`Missing historical transaction metadata for ${entry.signature}; checkpoint remains on this page.`);
      if (!tx.meta.err) {
        const top = instructions(tx);
        if (venue === "pumpfun") pumpProgramInstructionsSeen += top.filter(ix => ix.programId === PUMP).length;
        const launches = venue === "pumpfun"
          ? findPumpCreateInstructions(top, PUMP).map(x => ({ mint: x.mint, creator: x.creator, feePayer: signers(tx)[0] ?? null, quoteMint: "So11111111111111111111111111111111111111112", pool: null }))
          : findStonkFunLaunchInstructions(top, LAUNCHLAB, STONK_CONFIGS).map(x => ({ mint: x.mint, creator: x.creator, feePayer: x.payer, quoteMint: x.quoteMint, pool: x.pool }));
        createInstructionsFound += launches.length;
        for (const launch of launches) {
          const existing = state.launches[launch.mint];
          if (existing) {
            const corrected = { ...existing, creator: launch.creator, feePayer: launch.feePayer, quoteMint: launch.quoteMint, pool: launch.pool ?? existing.pool };
            if (corrected.creator !== existing.creator || corrected.feePayer !== existing.feePayer || corrected.quoteMint !== existing.quoteMint || corrected.pool !== existing.pool) {
              state.launches[launch.mint] = corrected;
              await writeLaunch(corrected, tx);
              console.log(`Corrected launch metadata for ${venue} ${launch.mint}`);
            }
            continue;
          }
          const record = { venue, mint: launch.mint, signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime, creator: launch.creator, feePayer: launch.feePayer, quoteMint: launch.quoteMint, pool: launch.pool };
          state.launches[launch.mint] = record;
          await writeLaunch(record, tx);
          console.log(`Archived ${venue} launch ${launch.mint} at ${new Date(entry.blockTime * 1000).toISOString()}`);
        }
      }
    }
    if (venue === "pumpfun" && pages === 0 && createInstructionsFound === 0) console.warn(`No Pump create instruction was decoded on the first page; continuing pagination. Pump program instructions observed=${pumpProgramInstructionsSeen}.`);
    state.programs[program] = progress;
    await save();
    pages++;
    pagesSinceUpload++;
    if (pagesSinceUpload >= UPLOAD_EVERY_PAGES) {
      await uploadDirtyFiles();
      pagesSinceUpload = 0;
    }
    console.log(`Historical ${venue} launch index ${queryAddress}: page ${pages}/${MAX_PAGES}, launches archived=${Object.keys(state.launches).length}, pageCreateInstructions=${createInstructionsFound}, pumpProgramInstructionsSeen=${pumpProgramInstructionsSeen}, enhancedHistory=${enhancedHistorySupport === true}`);
    if (progress.complete) break;
  }
  state.programs[program] = progress;
  await save();
  if (pagesSinceUpload > 0) {
    await uploadDirtyFiles();
    pagesSinceUpload = 0;
  }
}
type LaunchLabIndexRow = {
  mint?: string;
  createAt?: number | string;
  creator?: string;
  poolId?: string;
  pool?: string;
  id?: string;
  platformInfo?: { pubKey?: string; name?: string };
  mintB?: { address?: string };
};

async function fetchLaunchLabIndexPage(platformConfig: string, nextPageId?: string) {
  const params = new URLSearchParams({
    platformId: platformConfig,
    sort: "new",
    size: "100",
    mintType: "default",
    includeNsfw: "false"
  });
  if (nextPageId) params.set("nextPageId", nextPageId);
  const response = await fetch(`https://launch-mint-v1.raydium.io/get/list?${params.toString()}`, {
    headers: { accept: "application/json", "user-agent": "solana-research-archive/1.0" },
    signal: AbortSignal.timeout(25_000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Raydium LaunchLab index HTTP ${response.status}: ${raw.slice(0, 250)}`);
  let body: { success?: boolean; msg?: string; data?: { rows?: LaunchLabIndexRow[]; nextPageId?: string | null } };
  try { body = JSON.parse(raw) as typeof body; }
  catch { throw new Error("Raydium LaunchLab index returned invalid JSON."); }
  if (body.success !== true || !Array.isArray(body.data?.rows)) {
    throw new Error(`Raydium LaunchLab index response was not successful: ${body.msg ?? "unexpected response shape"}`);
  }
  return { rows: body.data.rows, nextPageId: body.data.nextPageId ?? undefined };
}

async function verifyAndPersistStonkFunLaunch(row: LaunchLabIndexRow, platformConfig: string) {
  const mint = typeof row.mint === "string" ? row.mint : "";
  const createAtMs = Number(row.createAt);
  if (!mint || !Number.isFinite(createAtMs)) throw new Error("LaunchLab index row is missing mint or createAt.");
  if (row.platformInfo?.pubKey !== platformConfig) {
    throw new Error(`LaunchLab platform mismatch for ${mint}: expected ${platformConfig}, got ${row.platformInfo?.pubKey ?? "missing"}`);
  }

  const expectedBlockTime = Math.floor(createAtMs / 1000);
  let before: string | undefined;
  let launchFound = false;
  for (let pageNumber = 1; pageNumber <= 10 && !launchFound; pageNumber++) {
    const signatures = await rpc("getSignaturesForAddress(StonkFun mint)", connection =>
      connection.getSignaturesForAddress(new PublicKey(mint), {
        limit: 1000,
        ...(before ? { before } : {})
      }, "confirmed")
    );
    if (!signatures.length) break;

    const candidates = signatures.filter(entry =>
      entry.blockTime != null && Math.abs(entry.blockTime - expectedBlockTime) <= 30
    );
    for (const entry of candidates) {
      const tx = await fetchTx(entry.signature);
      if (!tx?.meta) throw new Error(`Missing transaction metadata for StonkFun mint ${mint} signature ${entry.signature}; page cursor remains unchanged.`);
      if (tx.meta.err) continue;
      const launch = findStonkFunLaunchInstructions(instructions(tx), LAUNCHLAB, STONK_CONFIGS)
        .find(item => item.mint === mint && item.platformConfig === platformConfig);
      if (!launch) continue;

      const apiPool = row.poolId ?? row.pool ?? row.id ?? null;
      if (apiPool && launch.pool !== apiPool) {
        throw new Error(`LaunchLab pool mismatch for ${mint}: API=${apiPool}, decoded=${launch.pool}`);
      }
      const apiCreator = row.creator ?? null;
      if (apiCreator && launch.creator !== apiCreator) {
        throw new Error(`LaunchLab creator mismatch for ${mint}: API=${apiCreator}, decoded=${launch.creator}`);
      }
      const apiQuoteMint = row.mintB?.address ?? null;
      if (apiQuoteMint && launch.quoteMint !== apiQuoteMint) {
        throw new Error(`LaunchLab quote mint mismatch for ${mint}: API=${apiQuoteMint}, decoded=${launch.quoteMint}`);
      }

      const record = {
        venue: "stonkfun",
        mint,
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime!,
        creator: launch.creator,
        feePayer: launch.payer,
        quoteMint: launch.quoteMint,
        pool: launch.pool
      };
      state.launches[mint] = record;
      await writeLaunch(record, tx);
      await save();
      await uploadDirtyFiles();
      console.log(`Archived verified StonkFun launch ${mint} at ${new Date(record.blockTime * 1000).toISOString()} config=${platformConfig}`);
      launchFound = true;
      break;
    }

    const oldest = signatures[signatures.length - 1];
    if (!oldest?.signature || oldest.blockTime == null || oldest.blockTime <= expectedBlockTime + 30) break;
    before = oldest.signature;
  }

  if (!launchFound) {
    throw new Error(`Could not verify StonkFun LaunchLab initialize instruction for ${mint} at ${new Date(createAtMs).toISOString()} under config ${platformConfig}; index cursor remains on this page.`);
  }
}

async function scanStonkFunIndex() {
  const platformConfigs = [...STONK_CONFIGS];
  for (const platformConfig of platformConfigs) {
    let progress = state.launchLabIndexes![platformConfig] ?? { complete: false, pages: 0 };
    if (progress.complete) continue;
    let pagesThisRun = 0;

    while (pagesThisRun < MAX_LAUNCHLAB_PAGES && !progress.complete) {
      const page = await fetchLaunchLabIndexPage(platformConfig, progress.nextPageId);
      if (!page.rows.length) {
        throw new Error(`StonkFun LaunchLab index returned an empty page before proving the November 1 boundary for config ${platformConfig}.`);
      }

      const timestamps = page.rows.map(row => Number(row.createAt));
      if (timestamps.some(value => !Number.isFinite(value))) {
        throw new Error(`StonkFun LaunchLab index page contains a row without createAt for config ${platformConfig}.`);
      }
      const pageNewest = Math.max(...timestamps);
      const pageOldest = Math.min(...timestamps);
      if (progress.lastCreateAt != null && pageNewest > progress.lastCreateAt) {
        throw new Error(`StonkFun LaunchLab pagination moved forward in time for config ${platformConfig}; refusing to advance cursor.`);
      }

      for (const row of page.rows) {
        const mint = row.mint;
        const createdAt = Number(row.createAt);
        if (!mint || row.platformInfo?.pubKey !== platformConfig) {
          throw new Error(`StonkFun LaunchLab index returned a malformed or cross-platform row for config ${platformConfig}.`);
        }
        if (createdAt < START * 1000 || createdAt >= END * 1000) continue;
        if (state.launches[mint]?.venue === "stonkfun") continue;
        await verifyAndPersistStonkFunLaunch(row, platformConfig);
      }

      progress.pages++;
      pagesThisRun++;
      progress.lastCreateAt = pageOldest;
      progress.nextPageId = page.nextPageId;
      progress.complete = pageOldest <= START * 1000;
      if (!progress.complete && !progress.nextPageId) {
        throw new Error(`StonkFun LaunchLab index ended before the November 1 boundary for config ${platformConfig}.`);
      }
      state.launchLabIndexes![platformConfig] = progress;
      await save();
      await uploadDirtyFiles();
      console.log(`StonkFun index config=${platformConfig} page=${progress.pages} launches=${Object.values(state.launches).filter(item => item.venue === "stonkfun").length} complete=${progress.complete}`);
    }
  }
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
  const directory = tradeRecordDirectory(record);
  await mkdir(directory, { recursive: true });
  const until = record.blockTime + CAPTURE_SECONDS;
  const curve = record.venue === "pumpfun"
    ? PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(record.mint).toBuffer()], new PublicKey(PUMP))[0].toBase58()
    : null;
  const addresses = [...new Set([record.mint, record.pool, curve].filter((v): v is string => Boolean(v)))];
  const progress: MintTradeCursor = state.tradeCursors![record.mint] ?? { complete: false, pages: 0, sources: {} };
  progress.sources ??= {};
  for (const persistedAddress of Object.keys(progress.sources)) if (!addresses.includes(persistedAddress)) addresses.push(persistedAddress);
  for (let sourceIndex = 0; sourceIndex < addresses.length; sourceIndex++) {
    const address = addresses[sourceIndex];
    const source: TradeSourceCursor = progress.sources[address] ?? { complete: false, pages: 0 };
    let pagesThisRun = 0;
    while (!source.complete && pagesThisRun < MAX_PAGES) {
      const enhanced = await getHeliusHistoryPage(address, record.blockTime, until, source.paginationToken);
      let hydrated: Array<{ item: { signature: string; slot: number; blockTime: number | null }; tx: ParsedTransactionWithMeta | null; providerRecord: HeliusHistoryRow | null }>;
      let reachedLaunchBoundary = false;
      if (enhanced) {
        const pageRows = await hydrateHistoryRows(enhanced.data, `Trade history ${record.venue} ${record.mint}`);
        hydrated = pageRows.map(row => ({ item: row.entry, tx: row.tx, providerRecord: row.providerRecord }));
        source.paginationToken = enhanced.paginationToken ?? undefined;
        if (!enhanced.data.length || !enhanced.paginationToken) source.complete = true;
      } else {
        const page = await rpc("getSignaturesForAddress(source)", c => c.getSignaturesForAddress(new PublicKey(address), { limit: 100, ...(source.before ? { before: source.before } : {}) }, "confirmed"));
        if (!page.length) { source.complete = true; progress.sources[address] = source; state.tradeCursors![record.mint] = progress; await save(); break; }
        const ordered = [...page].reverse();
        reachedLaunchBoundary = ordered.some(item => item.blockTime != null && item.blockTime < record.blockTime);
        const candidates = ordered.filter(item => item.blockTime != null && item.blockTime >= record.blockTime && item.blockTime <= until);
        hydrated = await Promise.all(candidates.map(async item => ({ item: { signature: item.signature, slot: item.slot, blockTime: item.blockTime ?? null }, tx: await fetchTx(item.signature), providerRecord: null })));
        source.before = page[page.length - 1].signature;
        if (reachedLaunchBoundary || page.length < 100) source.complete = true;
      }
      const lines: string[] = [];
      for (const { item, tx, providerRecord } of hydrated) {
        if (item.blockTime == null) continue;
        if (!tx || !tx.meta) throw new Error(`Missing historical transaction metadata for ${item.signature}; checkpoint remains on this page.`);
        lines.push(JSON.stringify({
          schemaVersion: 1, recordType: "historical_transaction_observation",
          venue: record.venue, mint: record.mint, signature: item.signature,
          slot: item.slot, blockTime: item.blockTime,
          secondsSinceLaunch: item.blockTime - record.blockTime, sourceAddress: address,
          successful: !tx.meta.err, signers: signers(tx),
          transactionFeeLamports: tx.meta.fee ?? null,
          computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? null,
          preBalances: tx.meta.preBalances ?? [], postBalances: tx.meta.postBalances ?? [],
          preTokenBalances: tx.meta.preTokenBalances ?? [], postTokenBalances: tx.meta.postTokenBalances ?? [],
          logMessages: tx.meta.logMessages ?? [],
          transaction: tx.transaction,
          metaError: tx.meta.err ?? null,
          providerSource: providerRecord ? "helius_getTransactionsForAddress" : "solana_getParsedTransaction_fallback",
          rawProviderRecord: providerRecord ?? null
        }));
        if (tx.meta.err) {
          lines.push(JSON.stringify({ schemaVersion: 1, recordType: "historical_failed_transaction", venue: record.venue, mint: record.mint, signature: item.signature, slot: item.slot, blockTime: item.blockTime, secondsSinceLaunch: item.blockTime - record.blockTime, sourceAddress: address, err: tx.meta.err, transactionFeeLamports: tx.meta.fee, computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? null, signers: signers(tx), logMessages: tx.meta.logMessages ?? [] }));
          continue;
        }
        const txInstructions = instructions(tx);
        const pumpPool = findPumpSwapPoolFromInstructions(txInstructions, record.mint);
        const launchLabMigration = findLaunchLabCpmmMigration(txInstructions, record.mint);
        for (const discovered of [pumpPool?.pool, launchLabMigration?.pool]) {
          if (discovered && !addresses.includes(discovered)) addresses.push(discovered);
        }
        const decoded = decodeProgramTradeEvents(tx.meta.logMessages, record.mint, txInstructions);
        for (let eventIndex = 0; eventIndex < decoded.length; eventIndex++) {
          const event = decoded[eventIndex];
          const tokenDecimals = tx.meta.preTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === record.mint)?.uiTokenAmount.decimals ?? null;
          const quoteDecimals = event.quoteMint === "So11111111111111111111111111111111111111112" ? 9
            : tx.meta.preTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals
            ?? tx.meta.postTokenBalances?.find(x => x.mint === event.quoteMint)?.uiTokenAmount.decimals ?? null;
          lines.push(JSON.stringify({
            schemaVersion: 1, recordType: "historical_trade_event", venue: event.venue, mint: record.mint,
            launchSignature: record.signature, signature: item.signature, sourceAddress: address,
            slot: item.slot, blockTime: item.blockTime, secondsSinceLaunch: item.blockTime - record.blockTime, eventIndex,
            eventTimestamp: event.timestamp, side: event.side, user: event.user,
            creator: record.creator, launchFeePayer: record.feePayer, launchSlot: record.slot, launchTime: record.blockTime,
            transactionFeePayer: signers(tx)[0] ?? null, fundingSources: extractFundingSources(tx, event.user),
            tokenAmountRaw: event.tokenAmountRaw.toString(), tokenDecimals,
            quoteMint: event.quoteMint, quoteAmountRaw: event.quoteAmountRaw.toString(), quoteDecimals,
            protocolFeeRaw: event.protocolFeeRaw?.toString() ?? null,
            platformFeeRaw: event.platformFeeRaw?.toString() ?? null,
            lpFeeRaw: event.lpFeeRaw?.toString() ?? null,
            creatorFeeRaw: event.creatorFeeRaw?.toString() ?? null,
            shareFeeRaw: event.shareFeeRaw?.toString() ?? null,
            cashbackRaw: event.cashbackRaw?.toString() ?? null,
            buybackFeeRaw: event.buybackFeeRaw?.toString() ?? null,
            tradeFeeRaw: event.tradeFeeRaw?.toString() ?? null,
            tradeFeeMint: event.tradeFeeMint ?? null,
            venueTradeFeeRaw: event.venueTradeFeeRaw?.toString() ?? null,
            venueTradeFeeMint: event.venueTradeFeeMint ?? null,
            creatorFeeMint: event.creatorFeeMint ?? null,
            inputTransferFeeRaw: event.inputTransferFeeRaw?.toString() ?? null,
            outputTransferFeeRaw: event.outputTransferFeeRaw?.toString() ?? null,
            protocolFeeBps: event.protocolFeeBps?.toString() ?? null,
            lpFeeBps: event.lpFeeBps?.toString() ?? null,
            creatorFeeBps: event.creatorFeeBps?.toString() ?? null,
            eventName: event.eventName, instructionName: event.instructionName,
            pool: event.pool, eventCreator: event.creator, feeRecipient: event.feeRecipient,
            transactionFeeLamports: tx.meta.fee,
            computeUnitsConsumed: tx.meta.computeUnitsConsumed ?? null,
            preTokenBalances: tx.meta.preTokenBalances ?? [], postTokenBalances: tx.meta.postTokenBalances ?? [],
            preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances,
            reserveEvidence: { virtualQuoteReservesRaw: event.virtualQuoteReservesRaw?.toString() ?? null, realQuoteReservesRaw: event.realQuoteReservesRaw?.toString() ?? null, preTradeBaseReserveRaw: event.preTradeBaseReserveRaw?.toString() ?? null, preTradeQuoteReserveRaw: event.preTradeQuoteReserveRaw?.toString() ?? null },
            impliedQuotePrice: impliedQuotePrice(event.quoteAmountRaw, event.tokenAmountRaw, tokenDecimals, quoteDecimals),
            dataQuality: { decodedFromProgramEvent: true, historicalHolderSnapshot: false, priceUsd: null, fdvUsd: null, tokenDecimalsKnown: tokenDecimals != null, quoteDecimalsKnown: quoteDecimals != null }
          }));
        }
      }
      // Stable source IDs prevent page overwrites when a migration pool is discovered later.
      const sourceId = createHash("sha256").update(address).digest("hex").slice(0, 16);
      const pageFile = path.join(directory, `source-${sourceId}-page-${String(source.pages + 1).padStart(6, "0")}.jsonl`);
      await writeFile(pageFile, lines.length ? lines.join("\n") + "\n" : "");
      queueDirtyFile(pageFile);
      source.pages++;
      pagesThisRun++;
      if (!enhanced && (reachedLaunchBoundary || hydrated.length < 100)) source.complete = true;
      progress.sources[address] = source;
      progress.pages = Object.values(progress.sources).reduce<number>((sum, item) => sum + item.pages, 0);
      progress.complete = addresses.every(candidate => progress.sources[candidate]?.complete === true);
      state.tradeCursors![record.mint] = progress;
      await save();
      // Rebuild after every raw page, even when the 10-minute capture is incomplete.
      await buildMintResearchSummary(record);
      queueDirtyFile(launchRecordPath(record, ".summary.json"));
      await uploadDirtyFiles();
      console.log(`Trade capture ${record.venue} ${record.mint}: source ${sourceId}, page ${source.pages}, events=${lines.length}, complete=${progress.complete}`);
    }
    progress.sources[address] = source;
    progress.complete = addresses.every(candidate => progress.sources[candidate]?.complete === true);
    state.tradeCursors![record.mint] = progress;
    await save();
  }
  return progress.complete;
}
async function buildMintResearchSummary(record: Cursor["launches"][string]) {
  const directory = tradeRecordDirectory(record);
  const names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")).sort();
  const profilesByQuoteMint = new Map<string, Record<string, WalletProfile>>();
  const pricesByQuoteMint = new Map<string, Array<{ at: number; price: number; slot: number }>>();
  const launchEvidence = JSON.parse(await readFile(launchRecordPath(record), "utf8")) as { transaction?: { feeLamports?: number | null } };
  const sourceHash = createHash("sha256");
  const seen = new Set<string>();
  const failedSeen = new Set<string>();
  const tradeFees = new Map<string, number>();
  const failedFees = new Map<string, number>();
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let buyEvents = 0;
  let sellEvents = 0;
  let transactionObservations = 0;
  const observedTransactions = new Set<string>();
  const feeTotalsByMint = new Map<string, Map<string, bigint>>();
  const coverageBuckets = new Map<number, number>();
  let earliestObservedOffset: number | null = null;
  let latestObservedOffset: number | null = null;
  let missingDecimalEvents = 0;
  let duplicateEvents = 0;
  for (const name of names) {
    const content = await readFile(path.join(directory, name), "utf8");
    sourceHash.update(name);
    sourceHash.update(content);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      const signature = String(event.signature ?? "");
      if (event.recordType === "historical_transaction_observation") {
        transactionObservations++;
        if (signature) observedTransactions.add(signature);
        const offset = Number(event.secondsSinceLaunch);
        if (Number.isFinite(offset) && offset >= 0 && offset <= CAPTURE_SECONDS) {
          earliestObservedOffset = earliestObservedOffset == null ? offset : Math.min(earliestObservedOffset, offset);
          latestObservedOffset = latestObservedOffset == null ? offset : Math.max(latestObservedOffset, offset);
          const bucket = Math.min(Math.floor(offset / 10), 59);
          coverageBuckets.set(bucket, (coverageBuckets.get(bucket) ?? 0) + 1);
        }
        continue;
      }
      if (event.recordType === "historical_failed_transaction") {
        if (signature && !failedSeen.has(signature)) {
          failedSeen.add(signature);
          failedFees.set(signature, typeof event.transactionFeeLamports === "number" ? event.transactionFeeLamports : 0);
        }
        continue;
      }
      if (event.recordType !== "historical_trade_event") continue;
      const user = String(event.user ?? "");
      const side = event.side === "buy" || event.side === "sell" ? event.side : null;
      const quoteMint = String(event.quoteMint ?? "");
      const tokenRaw = BigInt(String(event.tokenAmountRaw ?? "0"));
      const quoteRaw = BigInt(String(event.quoteAmountRaw ?? "0"));
      const dedupe = [signature, event.eventIndex ?? 0, user, side, tokenRaw.toString(), quoteRaw.toString(), quoteMint].join(":");
      if (!signature || !user || !side || !quoteMint || tokenRaw <= 0n || quoteRaw <= 0n) continue;
      if (seen.has(dedupe)) { duplicateEvents++; continue; }
      seen.add(dedupe);
      const feeFields: Array<[string, unknown, unknown]> = [
        ["protocol", event.protocolFeeRaw, event.quoteMint],
        ["platform", event.platformFeeRaw, event.quoteMint],
        ["lp", event.lpFeeRaw, event.quoteMint],
        ["creator", event.creatorFeeRaw, event.creatorFeeMint ?? event.quoteMint],
        ["share", event.shareFeeRaw, event.quoteMint],
        ["cashback", event.cashbackRaw, event.quoteMint],
        ["buyback", event.buybackFeeRaw, event.quoteMint],
        ["trade", event.tradeFeeRaw, event.tradeFeeMint ?? event.quoteMint],
        ["venueTrade", event.venueTradeFeeRaw, event.venueTradeFeeMint ?? event.quoteMint],
        ["inputTransfer", event.inputTransferFeeRaw, event.quoteMint],
        ["outputTransfer", event.outputTransferFeeRaw, event.quoteMint]
      ];
      for (const [feeName, rawFee, feeMint] of feeFields) {
        if (typeof rawFee !== "string" || !feeMint || !/^\d+$/.test(rawFee)) continue;
        const mint = String(feeMint);
        const totals = feeTotalsByMint.get(mint) ?? new Map<string, bigint>();
        totals.set(feeName, (totals.get(feeName) ?? 0n) + BigInt(rawFee));
        feeTotalsByMint.set(mint, totals);
      }
      if (typeof event.transactionFeeLamports === "number") tradeFees.set(signature, event.transactionFeeLamports);
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
  const feeSummaryByMint = Object.fromEntries([...feeTotalsByMint.entries()].map(([mint, totals]) => [
    mint, Object.fromEntries([...totals.entries()].map(([name, raw]) => [name + "FeeRaw", raw.toString()]))
  ]));
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
  const sourcePageFingerprint = sourceHash.digest("hex");
  const derivedPumpCurve = record.venue === "pumpfun"
    ? PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(record.mint).toBuffer()], new PublicKey(PUMP))[0].toBase58()
    : null;
  const sourceAddressClassification = Object.fromEntries(Object.entries(state.tradeCursors?.[record.mint]?.sources ?? {}).map(([address, cursor]) => [
    address,
    {
      role: address === record.mint ? "mint_account_history"
        : address === record.pool ? "launch_pool_reference"
        : address === derivedPumpCurve ? "pump_bonding_curve_pda"
        : "pool_discovered_from_swap_or_migration_instruction",
      paginationComplete: cursor.complete,
      pages: cursor.pages
    }
  ]));
  const summary = {
    schemaVersion: 1, recordType: "historical_launch_research_summary", venue: record.venue, mint: record.mint,
    sourcePageCount: names.length, sourcePageFiles: names, sourcePageFingerprint,
    launchSignature: record.signature, launchTime: record.blockTime, launchSlot: record.slot,
    creator: record.creator, launchFeePayer: record.feePayer, quoteMintAtLaunch: record.quoteMint,
    transactionObservations: { rows: transactionObservations, distinctSignatures: observedTransactions.size },
    tradeEvents: { total: buyEvents + sellEvents, buys: buyEvents, sells: sellEvents, uniqueBuyers: buyers.size, uniqueSellers: sellers.size, duplicateEventsRemoved: duplicateEvents, missingDecimalEvents },
    capture: {
      windowSeconds: CAPTURE_SECONDS,
      timeCoverage: {
        bucketSeconds: 10,
        bucketCount: 60,
        observedTransactionCount: observedTransactions.size,
        observedBuckets: [...coverageBuckets.keys()].sort((a, b) => a - b),
        emptyBuckets: Array.from({ length: 60 }, (_, index) => index).filter(index => !coverageBuckets.has(index)),
        earliestObservedSecondsAfterLaunch: earliestObservedOffset,
        latestObservedSecondsAfterLaunch: latestObservedOffset,
        gapAccountingComplete: state.tradeCursors?.[record.mint]?.complete === true,
        bucketInterpretation: "A zero-count bucket means no transaction was returned for the scanned mint, curve, or discovered pool addresses; it is not proof that no off-address activity occurred."
      },
      transactionHistoryComplete: state.tradeCursors?.[record.mint]?.complete === true,
      complete: false,
      researchReady: false,
      completionBlockers: [
        "historical_usd_price_unavailable_without_a_verified_historical_price_source",
        "historical_fdv_and_total_supply_not_verified",
        "historical_holder_snapshots_not_available_from_standard_transaction_history",
        "locked_liquidity_state_requires_historical_pool_or_curve_account_evidence"
      ],
      totalSourcePages: state.tradeCursors?.[record.mint]?.pages ?? names.length,
      sources: Object.fromEntries(Object.entries(state.tradeCursors?.[record.mint]?.sources ?? {}).map(([address, cursor]) => [address, { complete: cursor.complete, pages: cursor.pages }]))
    },
    networkFees: { launchTransactionFeeLamports: launchEvidence.transaction?.feeLamports ?? null, uniqueTradeTransactions: tradeFees.size, tradeTransactionFeeLamportsTotal: [...tradeFees.values()].reduce((sum, value) => sum + value, 0), failedTransactions: failedFees.size, failedTransactionFeeLamportsTotal: [...failedFees.values()].reduce((sum, value) => sum + value, 0) },
    protocolAndVenueFeesByMintRaw: feeSummaryByMint,
    developerActivity: { creatorWallets, launchFeePayerWallets: feePayerWallets, profiles: [...creatorWallets, ...feePayerWallets].filter((v, i, a) => a.indexOf(v) === i) },
    venueStateClassification: {
      launchVenue: record.venue,
      bondingCurveAddress: derivedPumpCurve,
      launchPoolAddress: record.pool,
      sourceAddresses: sourceAddressClassification,
      bondingCurveStatus: record.venue === "pumpfun" ? "derived_address_not_historically_account_verified" : "not_applicable",
      launchPoolStatus: record.venue === "stonkfun" ? "launch_instruction_reference_not_historically_account_verified" : "unknown_until_migration_pool_is_discovered",
      reserveStatus: "event_evidence_only_not_full_historical_account_snapshot",
      lockedLiquidityStatus: "unavailable_not_verified",
      safetyClassification: "unverified"
    },
    priceSummaryByQuoteMint, walletCohortsByQuoteMint: cohortsByQuoteMint,
    dataQuality: {
      historicalUsdPrice: { status: "unavailable", reason: "No verified historical SOL/USD and quote-asset price source is wired into this collector." },
      historicalFdv: { status: "unavailable", reason: "Requires historical USD price and verified circulating/total supply at the observation time." },
      historicalTotalSupply: { status: "unavailable", reason: "Launch-transaction touched-account balances are not total supply; no historical mint-account snapshot provider is wired." },
      historicalHolderSnapshots: { status: "unavailable", reason: "Historical token-account holder enumeration is not provided by standard transaction history." },
      reserveEvidence: { status: "event_dependent", reason: "Only reserves emitted in decoded program events are retained; absence is not treated as zero or verified state." },
      liquidityLockStatus: { status: "unavailable", reason: "No historical lock/burn verification adapter is wired for migrated pools." },
      transactionEventAmounts: "decoded program events",
      rawTransactionObservations: "full parsed transaction and metadata persisted for every transaction returned by scanned source addresses",
      walletClassification: "heuristics only; bot/sniper/bundle labels are candidates, not proof"
    }
  };
  await writeFile(launchRecordPath(record, ".summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
async function summaryNeedsRefresh(record: Cursor["launches"][string]): Promise<boolean> {
  const summaryPath = launchRecordPath(record, ".summary.json");
  try {
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { sourcePageCount?: number; sourcePageFingerprint?: string; creator?: string | null; launchFeePayer?: string | null };
    const directory = tradeRecordDirectory(record);
    const names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")).sort();
    const hash = createHash("sha256");
    for (const name of names) { hash.update(name); hash.update(await readFile(path.join(directory, name))); }
    return summary.sourcePageCount !== names.length || summary.sourcePageFingerprint !== hash.digest("hex") || summary.creator !== record.creator || summary.launchFeePayer !== record.feePayer;
  } catch {
    return true;
  }
}
async function finishBatch(results: PromiseSettledResult<unknown>[]) {
  const paused = results.find(result => result.status === "rejected" && result.reason instanceof RpcCoolingDownError);
  if (paused) {
    await save();
    console.warn("rate_limit_pause: all Helius keys are throttled; saved cursors will resume on the next scheduled run.");
    return true;
  }
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return false;
}
async function main() {
  if (!(START < END)) throw new Error("HISTORY_START must be earlier than HISTORY_END.");
  await load();
  console.log(`Historical research archive only. Window ${new Date(START * 1000).toISOString()} to ${new Date(END * 1000).toISOString()}. No trading or order submission. RPC pacing per key: ${MIN_RPC_INTERVAL_MS}ms.`);
  // One coordinator owns checkpoint and Hub commits. Transaction hydration still
  // fans out requests across the three independently paced Helius keys.
  if (process.env.HISTORY_SKIP_PUMP_INDEX === "true") {
    console.log("Pump.fun launch index skipped by explicit partial-archive configuration.");
  } else {
    const pumpScan = await Promise.allSettled([scanProgram(PUMP, "pumpfun")]);
    if (await finishBatch(pumpScan)) return;
  }
  const stonkScan = await Promise.allSettled([scanStonkFunIndex()]);
  if (await finishBatch(stonkScan)) return;
  if (process.env.HISTORY_DISCOVERY_ONLY === "true") {
    if (dirtyFiles.size > 0) await uploadDirtyFiles(true);
    console.log(`Launch indexing only. Detailed trade capture is paused until the historical initial-screen stage is enabled. Launches indexed: ${Object.keys(state.launches).length}.`);
    return;
  }
  const records = Object.values(state.launches);
  let nextRecord = 0;
  const workerCount = Math.min(1, records.length);
  let tradeCoinsStarted = 0;
  const tradeResults = await Promise.allSettled(Array.from({ length: workerCount }, async () => {
    while (nextRecord < records.length) {
      const record = records[nextRecord++];
      if (!state.tradeCursors?.[record.mint]?.complete) {
        if (MAX_TRADE_COINS_PER_RUN > 0 && tradeCoinsStarted >= MAX_TRADE_COINS_PER_RUN) break;
        tradeCoinsStarted++;
        await collectMintTrades(record);
      }
      if (await summaryNeedsRefresh(record)) {
        await buildMintResearchSummary(record);
        queueDirtyFile(launchRecordPath(record, ".summary.json"));
        await uploadDirtyFiles();
      }
    }
  }));
  if (await finishBatch(tradeResults)) return;
  console.log(`Historical pass complete for this run. Launches indexed: ${Object.keys(state.launches).length}. Program scan completion: ${JSON.stringify(Object.fromEntries(Object.entries(state.programs).map(([k,v]) => [k,v.complete]))) }`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
