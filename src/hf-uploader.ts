import { uploadFiles } from "@huggingface/hub";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const token = process.env.HF_TOKEN;
const repoName = process.env.HF_DATASET_REPO ?? "ndeda/solana-scalping-data";
const dataDir = process.env.DATA_DIR ?? "./data";
const dirtyMints = new Set<string>();
let stateDirty = false;
let flushPromise: Promise<void> | null = null;
let warnedMissingToken = false;

export function markMintDirty(mint: string) { dirtyMints.add(mint); }
export function markCollectorStateDirty() { stateDirty = true; }

export async function restoreCollectorState(localPath: string) {
  if (!token) return;
  const url = `https://huggingface.co/datasets/${repoName}/resolve/main/state/collector-state.json`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) {
      console.log("No remote collector checkpoint exists yet; starting a new state.");
      return;
    }
    if (!response.ok) throw new Error(`Checkpoint download returned HTTP ${response.status}`);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    console.log("Restored collector checkpoint from Hugging Face.");
  } catch (error) {
    console.error("Could not restore remote checkpoint; local state will be used:", String(error).slice(0, 220));
  }
}

export async function restoreTokenEvents(mints: string[]) {
  if (!token || mints.length === 0) return;
  await Promise.all(mints.map(async mint => {
    const localPath = path.join(dataDir, "tokens", mint, "events.jsonl");
    try {
      const response = await fetch(`https://huggingface.co/datasets/${repoName}/resolve/main/raw/pumpfun/${mint}/events.jsonl`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000)
      });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("Could not restore event file for", mint, String(error).slice(0, 160));
    }
  }));
}

export async function flushHuggingFaceUploads() {
  if (!token) {
    if (!warnedMissingToken) { console.warn("HF_TOKEN is not set; dataset uploads are disabled."); warnedMissingToken = true; }
    return;
  }
  if (flushPromise) {
    await flushPromise;
    if (dirtyMints.size > 0 || stateDirty) await flushHuggingFaceUploads();
    return;
  }
  if (dirtyMints.size === 0 && !stateDirty) return;
  const batch = [...dirtyMints];
  const includeState = stateDirty;
  for (const mint of batch) dirtyMints.delete(mint);
  if (includeState) stateDirty = false;
  flushPromise = (async () => {
    try {
      const files = await Promise.all(batch.map(async mint => {
        const content = await readFile(path.join(dataDir, "tokens", mint, "events.jsonl"));
        return { path: `raw/pumpfun/${mint}/events.jsonl`, content: new Blob([content.toString("utf8")], { type: "application/x-ndjson" }) };
      }));
      if (includeState) {
        const state = await readFile(path.join(dataDir, "collector-state.json"));
        files.push({ path: "state/collector-state.json", content: new Blob([state.toString("utf8")], { type: "application/json" }) });
      }
      if (files.length === 0) return;
      await uploadFiles({
        repo: { type: "dataset", name: repoName }, accessToken: token, files,
        commitTitle: `Update collector data (${batch.length} token files${includeState ? " + checkpoint" : ""})`,
        commitDescription: "Automated resumable research data batch."
      });
      console.log(`Uploaded ${batch.length} token event file(s)${includeState ? " and collector checkpoint" : ""} to Hugging Face.`);
    } catch (error) {
      for (const mint of batch) dirtyMints.add(mint);
      if (includeState) stateDirty = true;
      console.error("Hugging Face upload failed; batch retained for retry:", String(error).slice(0, 240));
    }
  })();
  await flushPromise;
  flushPromise = null;
  if (dirtyMints.size > 0 || stateDirty) await flushHuggingFaceUploads();
}
setInterval(() => { void flushHuggingFaceUploads(); }, 30_000).unref();
