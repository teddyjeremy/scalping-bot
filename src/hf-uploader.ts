import { uploadFiles } from "@huggingface/hub";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const token = process.env.HF_TOKEN;
const repoName = process.env.HF_DATASET_REPO ?? "ndeda/solana-scalping-data";
const dataDir = process.env.DATA_DIR ?? "./data";
const dirtyMints = new Map<string, string>();
let stateDirty = false;
let qualityDirty = false;
let flushPromise: Promise<void> | null = null;
let warnedMissingToken = false;

export function markMintDirty(mint: string, venue = "pumpfun") { dirtyMints.set(mint, venue); }
export function markCollectorStateDirty() { stateDirty = true; }
export function markQualityManifestDirty() { qualityDirty = true; }

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
    const checkpointText = await response.text();
    if (!checkpointText.trim()) throw new Error("Remote checkpoint is empty; refusing to overwrite local progress.");
    const parsed = JSON.parse(checkpointText) as { tokens?: unknown; seenLaunchSignatures?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.tokens || !Array.isArray(parsed.seenLaunchSignatures)) {
      throw new Error("Remote checkpoint has an invalid schema; refusing to overwrite local progress.");
    }
    await mkdir(path.dirname(localPath), { recursive: true });
    const tempPath = localPath + ".restore.tmp";
    await writeFile(tempPath, checkpointText);
    const { rename } = await import("node:fs/promises");
    await rename(tempPath, localPath);
    console.log("Restored validated collector checkpoint from Hugging Face.");
  } catch (error) {
    console.error("Could not restore remote checkpoint; local state will be used:", String(error).slice(0, 220));
  }
}

export async function quarantineRemoteMintFile(mint: string, reason: string): Promise<boolean> {
  if (!token) return false;
  const rawPath = `raw/pumpfun/${mint}/events.jsonl`;
  const archivePath = `quarantine/pumpfun/${mint}/events.jsonl`;
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://huggingface.co/datasets/${repoName}/resolve/main/`;
  try {
    const [rawResponse, archiveResponse] = await Promise.all([
      fetch(base + rawPath, { headers, signal: AbortSignal.timeout(30_000) }),
      fetch(base + archivePath, { headers, signal: AbortSignal.timeout(30_000) })
    ]);
    let archived: Blob | null = null;
    if (archiveResponse.ok) {
      // Existing archive is authoritative; never overwrite it with a raw-path marker on a retry.
      await archiveResponse.body?.cancel();
    } else if (archiveResponse.status === 404 && rawResponse.ok) {
      archived = new Blob([await rawResponse.arrayBuffer()], { type: "application/x-ndjson" });
    } else if (archiveResponse.status !== 404) {
      throw new Error(`Quarantine archive check returned HTTP ${archiveResponse.status}`);
    }
    if (rawResponse.status !== 404 && !rawResponse.ok) throw new Error(`Raw event download returned HTTP ${rawResponse.status}`);
    const marker = {
      schemaVersion: 1, kind: "quarantined_dataset_entry", mint, reason,
      archivedAt: new Date().toISOString(), archivedPath: archivePath,
      originalRawPreserved: archived != null || archiveResponse.ok
    };
    const files = [];
    if (archived) files.push({ path: archivePath, content: archived });
    files.push({ path: rawPath, content: new Blob([JSON.stringify(marker) + "\n"], { type: "application/x-ndjson" }) });
    await uploadFiles({
      repo: { type: "dataset", name: repoName }, accessToken: token, files,
      commitTitle: `Quarantine invalid token directory ${mint.slice(0, 8)}`,
      commitDescription: "Preserve original raw events under quarantine/ and replace the active raw path with an exclusion marker."
    });
    console.log("Quarantined dataset directory:", mint, "original evidence archived:", marker.originalRawPreserved);
    return true;
  } catch (error) {
    console.error("Could not migrate quarantined dataset directory:", mint, String(error).slice(0, 200));
    return false;
  }
}

export async function restoreQualityManifest(localPath: string) {
  if (!token) return;
  try {
    const response = await fetch(`https://huggingface.co/datasets/${repoName}/resolve/main/quality/data-quality-manifest.json`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`Quality manifest download returned HTTP ${response.status}`);
    const body = await response.text();
    const parsed = JSON.parse(body) as { schemaVersion?: number; quarantinedMints?: unknown };
    if (parsed.schemaVersion !== 1 || !parsed.quarantinedMints || typeof parsed.quarantinedMints !== "object") {
      throw new Error("Remote quality manifest has an invalid schema; local manifest retained.");
    }
    await mkdir(path.dirname(localPath), { recursive: true });
    const tempPath = localPath + ".restore.tmp";
    await writeFile(tempPath, body);
    const { rename } = await import("node:fs/promises");
    await rename(tempPath, localPath);
    console.log("Restored validated data-quality manifest from Hugging Face.");
  } catch (error) {
    console.error("Could not restore remote quality manifest; local manifest will be used:", String(error).slice(0, 180));
  }
}

export async function restoreTokenEvents(tokens: Array<{ mint: string; venue?: string }>) {
  if (!token || tokens.length === 0) return;
  await Promise.all(tokens.map(async ({ mint, venue = "pumpfun" }) => {
    const localPath = path.join(dataDir, "tokens", mint, "events.jsonl");
    try {
      const response = await fetch(`https://huggingface.co/datasets/${repoName}/resolve/main/raw/${venue}/${mint}/events.jsonl`, {
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
    if (dirtyMints.size > 0 || stateDirty || qualityDirty) await flushHuggingFaceUploads();
    return;
  }
  if (dirtyMints.size === 0 && !stateDirty && !qualityDirty) return;
  const batch = [...dirtyMints.entries()];
  const includeState = stateDirty;
  const includeQuality = qualityDirty;
  for (const [mint] of batch) dirtyMints.delete(mint);
  if (includeState) stateDirty = false;
  if (includeQuality) qualityDirty = false;
  let batchFailed = false;
  flushPromise = (async () => {
    try {
      const files = await Promise.all(batch.map(async ([mint, venue]) => {
        const content = await readFile(path.join(dataDir, "tokens", mint, "events.jsonl"));
        return { path: `raw/${venue}/${mint}/events.jsonl`, content: new Blob([content.toString("utf8")], { type: "application/x-ndjson" }) };
      }));
      if (includeState) {
        const state = await readFile(path.join(dataDir, "collector-state.json"));
        files.push({ path: "state/collector-state.json", content: new Blob([state.toString("utf8")], { type: "application/json" }) });
      }
      if (includeQuality) {
        const manifest = await readFile(path.join(dataDir, "quality", "data-quality-manifest.json"));
        files.push({ path: "quality/data-quality-manifest.json", content: new Blob([manifest.toString("utf8")], { type: "application/json" }) });
      }
      if (files.length === 0) return;
      await uploadFiles({
        repo: { type: "dataset", name: repoName }, accessToken: token, files,
        commitTitle: `Update collector data (${batch.length} token files${includeState ? " + checkpoint" : ""}${includeQuality ? " + quality manifest" : ""})`,
        commitDescription: "Automated resumable research data batch."
      });
      console.log(`Uploaded ${batch.length} token event file(s)${includeState ? " and collector checkpoint" : ""}${includeQuality ? " and data-quality manifest" : ""} to Hugging Face.`);
    } catch (error) {
      batchFailed = true;
      for (const [mint, venue] of batch) dirtyMints.set(mint, venue);
      if (includeState) stateDirty = true;
      if (includeQuality) qualityDirty = true;
      console.error("Hugging Face upload failed; batch retained for retry:", String(error).slice(0, 240));
    }
  })();
  await flushPromise;
  flushPromise = null;
  if (!batchFailed && (dirtyMints.size > 0 || stateDirty || qualityDirty)) await flushHuggingFaceUploads();
}
setInterval(() => { void flushHuggingFaceUploads(); }, 30_000).unref();
