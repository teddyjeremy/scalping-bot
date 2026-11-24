import "dotenv/config";
import { Connection, PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const CAPTURE_MS = Number(process.env.CAPTURE_MINUTES ?? 10) * 60_000;
const keys = [
  process.env.HELIUS_API_KEY_1,
  process.env.HELIUS_API_KEY_2,
  process.env.HELIUS_API_KEY_3
].filter((v): v is string => Boolean(v));

if (keys.length === 0) throw new Error("Set at least HELIUS_API_KEY_1 in your environment.");
const rpc = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
let rpcCursor = 0;
const nextRpc = () => rpc[(rpcCursor++) % rpc.length];

type TokenState = {
  mint: string;
  creator: string | null;
  launchSignature: string;
  firstSeenAt: number;
  expiresAt: number;
  subscriptionId?: number;
};
type CollectorState = { tokens: Record<string, TokenState>; seenLaunchSignatures: string[] };
const statePath = path.join(DATA_DIR, "collector-state.json");
let state: CollectorState = { tokens: {}, seenLaunchSignatures: [] };
const activeSubscriptions = new Map<string, number>();

async function persistState() {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}
async function appendTokenEvent(mint: string, event: Record<string, unknown>) {
  const dir = path.join(DATA_DIR, "tokens", mint);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
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
      const tx = await nextRpc().getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (tx) return tx;
    } catch (error) {
      console.error("Transaction fetch failed:", String(error).slice(0, 180));
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  return null;
}
async function captureMint(stateItem: TokenState) {
  const { mint, expiresAt } = stateItem;
  if (activeSubscriptions.has(mint)) return;
  const connection = nextRpc();
  try {
    const subId = connection.onLogs(new PublicKey(mint), async (logs: Logs, context) => {
      const observedAt = Date.now();
      if (observedAt > expiresAt) {
        await stopCapture(mint);
        return;
      }
      const tx = await fetchTransaction(logs.signature);
      await appendTokenEvent(mint, {
        schemaVersion: 1,
        kind: "token_activity",
        mint,
        observedAt,
        slot: context.slot,
        signature: logs.signature,
        err: logs.err,
        logs: logs.logs,
        transaction: tx ? {
          blockTime: tx.blockTime,
          fee: tx.meta?.fee,
          err: tx.meta?.err,
          accountKeys: tx.transaction.message.accountKeys.map(k => getAccountKey(k)),
          preBalances: tx.meta?.preBalances,
          postBalances: tx.meta?.postBalances,
          preTokenBalances: tx.meta?.preTokenBalances,
          postTokenBalances: tx.meta?.postTokenBalances,
          innerInstructions: tx.meta?.innerInstructions,
          logMessages: tx.meta?.logMessages
        } : null
      });
    }, "confirmed");
    activeSubscriptions.set(mint, subId);
    state.tokens[mint].subscriptionId = subId;
    await persistState();
  } catch (error) {
    console.error("Could not subscribe to mint", mint, String(error));
  }
}
async function stopCapture(mint: string) {
  const subId = activeSubscriptions.get(mint);
  if (subId !== undefined) {
    try { await nextRpc().removeOnLogsListener(subId); } catch {}
    activeSubscriptions.delete(mint);
  }
  if (state.tokens[mint]) {
    delete state.tokens[mint].subscriptionId;
    await persistState();
  }
}
async function handleLaunch(signature: string, logs: Logs, slot: number) {
  if (state.seenLaunchSignatures.includes(signature)) return;
  state.seenLaunchSignatures.push(signature);
  if (state.seenLaunchSignatures.length > 20_000) state.seenLaunchSignatures = state.seenLaunchSignatures.slice(-10_000);
  await persistState();

  const tx = await fetchTransaction(signature);
  if (!tx || tx.meta?.err) return;
  const mints = newMints(tx);
  if (mints.length === 0) return;
  const creator = getAccountKey(tx.transaction.message.accountKeys[0]);
  const firstSeenAt = (tx.blockTime ? tx.blockTime * 1000 : Date.now());
  for (const mint of mints) {
    if (state.tokens[mint]) continue;
    const token: TokenState = {
      mint, creator, launchSignature: signature,
      firstSeenAt, expiresAt: firstSeenAt + CAPTURE_MS
    };
    state.tokens[mint] = token;
    await appendTokenEvent(mint, {
      schemaVersion: 1, kind: "launch_detected", mint, creator,
      launchSignature: signature, launchSlot: slot, firstSeenAt,
      program: PUMP_PROGRAM.toBase58(), launchLogs: logs.logs
    });
    await persistState();
    await captureMint(token);
    console.log("Capturing token:", mint, "creator:", creator);
  }
}
async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  try { state = JSON.parse(await readFile(statePath, "utf8")) as CollectorState; }
  catch { await persistState(); }
}
async function main() {
  await loadState();
  const now = Date.now();
  for (const token of Object.values(state.tokens)) {
    if (token.expiresAt > now) await captureMint(token);
  }
  const discovery = new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${keys[0]}`, "confirmed"
  );
  console.log("Listening for Pump program activity. API keys configured:", keys.length);
  await discovery.onLogs(PUMP_PROGRAM, async (logs, context) => {
    if (logs.err) return;
    if (!logs.logs.some(line => /Instruction: Create|Instruction: CreateV2|Program data:/i.test(line))) return;
    await handleLaunch(logs.signature, logs, context.slot);
  }, "confirmed");
  setInterval(async () => {
    const t = Date.now();
    for (const token of Object.values(state.tokens)) {
      if (token.expiresAt <= t) await stopCapture(token.mint);
    }
  }, 15_000);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
