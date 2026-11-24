import "dotenv/config";
import { Connection, PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { flushHuggingFaceUploads, markCollectorStateDirty, markMintDirty, restoreCollectorState, restoreTokenEvents } from "./hf-uploader.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const CAPTURE_MS = Number(process.env.CAPTURE_MINUTES ?? 10) * 60_000;
const RUN_FOR_MS = Number(process.env.RUN_FOR_MINUTES ?? 0) * 60_000;
const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter((v): v is string => Boolean(v));
if (keys.length === 0) throw new Error("Set at least HELIUS_API_KEY_1 in your environment.");
if (keys.length !== 3) console.warn(`Only ${keys.length} Helius API key(s) configured; using available key(s).`);
const rpc = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
let rpcCursor = 0;
const nextRpc = () => rpc[(rpcCursor++) % rpc.length];

type TokenState = { mint: string; creator: string | null; launchSignature: string; firstSeenAt: number; expiresAt: number; subscriptionId?: number };
type CollectorState = { tokens: Record<string, TokenState>; seenLaunchSignatures: string[] };
const statePath = path.join(DATA_DIR, "collector-state.json");
let state: CollectorState = { tokens: {}, seenLaunchSignatures: [] };
const activeSubscriptions = new Map<string, { connection: Connection; id: number }>();
let discoverySubscription: { connection: Connection; id: number } | undefined;
let expiryTimer: NodeJS.Timeout | undefined;
let runTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function persistState() {
  await writeFile(statePath, JSON.stringify(state, null, 2));
  markCollectorStateDirty();
}
async function appendTokenEvent(mint: string, event: Record<string, unknown>) {
  await mkdir(path.join(DATA_DIR, "tokens", mint), { recursive: true });
  await appendFile(path.join(DATA_DIR, "tokens", mint, "events.jsonl"), JSON.stringify(event) + "\n");
  markMintDirty(mint);
}
function getAccountKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (key && typeof key === "object" && "pubkey" in key) return String((key as {pubkey: unknown}).pubkey);
  return String(key);
}
function newMints(tx: ParsedTransactionWithMeta): string[] {
  const before = new Set((tx.meta?.preTokenBalances ?? []).map(x => x.mint));
  return [...new Set((tx.meta?.postTokenBalances ?? []).map(x => x.mint).filter(m => !before.has(m)))];
}
async function fetchTransaction(signature: string) {
  for (let attempt = 0; attempt < rpc.length; attempt++) {
    try {
      const tx = await nextRpc().getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) return tx;
    } catch (error) {
      console.error("Transaction fetch failed:", String(error).slice(0, 180));
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  return null;
}
async function captureMint(item: TokenState) {
  const { mint, expiresAt } = item;
  if (activeSubscriptions.has(mint)) return;
  const connection = nextRpc();
  try {
    const id = connection.onLogs(new PublicKey(mint), async (logs: Logs, context) => {
      if (shuttingDown) return;
      const observedAt = Date.now();
      if (observedAt > expiresAt) { await stopCapture(mint); return; }
      const tx = await fetchTransaction(logs.signature);
      await appendTokenEvent(mint, {
        schemaVersion: 1, kind: "token_activity", mint, observedAt, slot: context.slot,
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
    state.tokens[mint].subscriptionId = id;
    await persistState();
  } catch (error) { console.error("Could not subscribe to mint", mint, String(error)); }
}
async function stopCapture(mint: string) {
  const sub = activeSubscriptions.get(mint);
  if (sub) {
    try { await sub.connection.removeOnLogsListener(sub.id); } catch {}
    activeSubscriptions.delete(mint);
  }
  if (state.tokens[mint]) { delete state.tokens[mint].subscriptionId; await persistState(); }
}
async function handleLaunch(signature: string, logs: Logs, slot: number) {
  if (state.seenLaunchSignatures.includes(signature)) return;
  state.seenLaunchSignatures.push(signature);
  if (state.seenLaunchSignatures.length > 20_000) state.seenLaunchSignatures = state.seenLaunchSignatures.slice(-10_000);
  await persistState();
  const tx = await fetchTransaction(signature);
  if (!tx || tx.meta?.err) return;
  const mints = newMints(tx);
  if (!mints.length) return;
  const creator = getAccountKey(tx.transaction.message.accountKeys[0]);
  const firstSeenAt = tx.blockTime ? tx.blockTime * 1000 : Date.now();
  for (const mint of mints) {
    if (state.tokens[mint]) continue;
    const item: TokenState = { mint, creator, launchSignature: signature, firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS };
    state.tokens[mint] = item;
    await appendTokenEvent(mint, { schemaVersion: 1, kind: "launch_detected", mint, creator, launchSignature: signature, launchSlot: slot, firstSeenAt, program: PUMP_PROGRAM.toBase58(), launchLogs: logs.logs });
    await persistState();
    await captureMint(item);
    console.log("Capturing token:", mint, "creator:", creator);
  }
}
async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  await restoreCollectorState(statePath);
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as CollectorState;
    state.tokens ??= {};
    state.seenLaunchSignatures ??= [];
  } catch { await persistState(); }
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
  await flushHuggingFaceUploads();
  console.log("Collector stopped.");
}
async function main() {
  await loadState();
  const activeTokens = Object.values(state.tokens).filter(item => item.expiresAt > Date.now());
  await restoreTokenEvents(activeTokens.map(item => item.mint));
  for (const item of activeTokens) await captureMint(item);
  const discovery = new Connection(`https://mainnet.helius-rpc.com/?api-key=${keys[0]}`, "confirmed");
  console.log("Listening for Pump program activity. API keys configured:", keys.length);
  const id = await discovery.onLogs(PUMP_PROGRAM, async (logs, context) => {
    if (shuttingDown || logs.err) return;
    if (!logs.logs.some(line => /Instruction: Create|Instruction: CreateV2|Program data:/i.test(line))) return;
    await handleLaunch(logs.signature, logs, context.slot);
  }, "confirmed");
  discoverySubscription = { connection: discovery, id };
  expiryTimer = setInterval(async () => {
    for (const item of Object.values(state.tokens)) if (item.expiresAt <= Date.now()) await stopCapture(item.mint);
  }, 15_000);
  if (RUN_FOR_MS > 0) runTimer = setTimeout(() => { void shutdown("configured run window complete"); }, RUN_FOR_MS);
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
main().catch(async error => { console.error(error); await shutdown("fatal error"); process.exitCode = 1; });
