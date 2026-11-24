import "dotenv/config";
import { Connection, PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { flushHuggingFaceUploads, markCollectorStateDirty, markMintDirty, restoreCollectorState, restoreTokenEvents } from "./hf-uploader.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const INVALID_QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);
const CREATE_LOG = /Program log: Instruction: Create(?:V2)?/i;
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

type TokenState = { mint: string; creator: string | null; launchSignature: string; firstSeenAt: number; expiresAt: number };
type CollectorState = {
  tokens: Record<string, TokenState>;
  seenLaunchSignatures: string[];
  lastProgramSignature?: string;
  reconcileTarget?: string;
  reconcileBefore?: string;
};
const statePath = path.join(DATA_DIR, "collector-state.json");
let state: CollectorState = { tokens: {}, seenLaunchSignatures: [] };
const activeSubscriptions = new Map<string, { connection: Connection; id: number }>();
let discoverySubscription: { connection: Connection; id: number } | undefined;
let expiryTimer: NodeJS.Timeout | undefined;
let runTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let reconciliation: Promise<void> | undefined;

async function persistState() {
  await mkdir(DATA_DIR, { recursive: true });
  const tempPath = statePath + ".tmp";
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
function isCreateTransaction(tx: ParsedTransactionWithMeta): boolean {
  return (tx.meta?.logMessages ?? []).some(line => CREATE_LOG.test(line));
}
function createdPumpMints(tx: ParsedTransactionWithMeta): string[] {
  const found = new Set<string>();
  // The official Pump IDL defines the first account of both create and create_v2 as the new mint.
  for (const instruction of tx.transaction.message.instructions) {
    if (!("accounts" in instruction)) continue;
    const programId = "programId" in instruction ? String(instruction.programId) : "";
    if (programId !== PUMP_PROGRAM.toBase58()) continue;
    const mint = instruction.accounts[0] ? getAccountKey(instruction.accounts[0]) : "";
    if (mint && !INVALID_QUOTE_MINTS.has(mint)) found.add(mint);
  }
  return [...found];
}
async function isMintAccount(mint: string): Promise<boolean> {
  try {
    const info = await nextRpc().getAccountInfo(new PublicKey(mint), "confirmed");
    return Boolean(info && TOKEN_PROGRAMS.has(info.owner.toBase58()));
  } catch { return false; }
}
async function fetchTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(rpc.length, 3); attempt++) {
    try {
      const tx = await nextRpc().getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) return tx;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (lastError) console.error("Transaction fetch failed:", String(lastError).slice(0, 180));
  return null;
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
      await appendTokenEvent(mint, {
        schemaVersion: 2, kind: "token_activity", mint, observedAt, slot: context.slot,
        signature: logs.signature, err: logs.err, logs: logs.logs,
        transaction: tx ? {
          blockTime: tx.blockTime, fee: tx.meta?.fee, err: tx.meta?.err,
          accountKeys: tx.transaction.message.accountKeys.map(k => getAccountKey(k)),
          preBalances: tx.meta?.preBalances, postBalances: tx.meta?.postBalances,
          preTokenBalances: tx.meta?.preTokenBalances, postTokenBalances: tx.meta?.postTokenBalances,
          innerInstructions: tx.meta?.innerInstructions, logMessages: tx.meta?.logMessages
        } : null
      });
    }, "confirmed");
    activeSubscriptions.set(mint, { connection, id });
    await persistState();
  } catch (error) { console.error("Could not subscribe to mint", mint, String(error)); }
}
async function stopCapture(mint: string) {
  const sub = activeSubscriptions.get(mint);
  if (sub) {
    try { await sub.connection.removeOnLogsListener(sub.id); } catch {}
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
    const item: TokenState = { mint, creator: null, launchSignature: signature, firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS };
    state.tokens[mint] = item;
    await appendTokenEvent(mint, {
      schemaVersion: 2, kind: "launch_detected", mint, feePayer,
      creator: null, creatorEvidence: "not decoded; fee payer is stored separately",
      launchSignature: signature, launchSlot: slot, firstSeenAt,
      program: PUMP_PROGRAM.toBase58(), instruction: "create_or_create_v2", launchLogs: logs
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
  console.log("Listening for verified Pump create/create_v2 instructions. API keys configured:", keys.length);
  void reconcileMissedLaunches();
  expiryTimer = setInterval(async () => {
    for (const item of Object.values(state.tokens)) if (item.expiresAt <= Date.now()) await stopCapture(item.mint);
  }, 15_000);
  if (RUN_FOR_MS > 0) runTimer = setTimeout(() => { void shutdown("configured run window complete"); }, RUN_FOR_MS);
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
main().catch(async error => { console.error(error); await shutdown("fatal error"); process.exitCode = 1; });
