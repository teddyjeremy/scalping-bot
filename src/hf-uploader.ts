import { uploadFiles } from "@huggingface/hub";
import { readFile } from "node:fs/promises";
import path from "node:path";

const token = process.env.HF_TOKEN;
const repoName = process.env.HF_DATASET_REPO ?? "ndeda/solana-scalping-data";
const dataDir = process.env.DATA_DIR ?? "./data";
const dirtyMints = new Set<string>();
let flushing = false;
let warnedMissingToken = false;

export function markMintDirty(mint: string) {
  dirtyMints.add(mint);
}

export async function flushHuggingFaceUploads() {
  if (!token) {
    if (!warnedMissingToken) {
      console.warn("HF_TOKEN is not set; dataset uploads are disabled.");
      warnedMissingToken = true;
    }
    return;
  }
  if (flushing || dirtyMints.size === 0) return;
  flushing = true;
  const batch = [...dirtyMints];
  for (const mint of batch) dirtyMints.delete(mint);
  try {
    const files = await Promise.all(batch.map(async mint => {
      const localPath = path.join(dataDir, "tokens", mint, "events.jsonl");
      const content = await readFile(localPath);
      return {
        path: `raw/pumpfun/${mint}/events.jsonl`,
        content: new Blob([content.toString("utf8")], { type: "application/x-ndjson" })
      };
    }));
    await uploadFiles({
      repo: { type: "dataset", name: repoName },
      accessToken: token,
      files,
      commitTitle: `Update Pump.fun event batches (${files.length} tokens)`,
      commitDescription: "Automated research data batch from the local collector."
    });
    console.log(`Uploaded ${files.length} token event file(s) to Hugging Face.`);
  } catch (error) {
    for (const mint of batch) dirtyMints.add(mint);
    console.error("Hugging Face upload failed; batch retained for retry:", String(error).slice(0, 240));
  } finally {
    flushing = false;
  }
}

setInterval(() => {
  void flushHuggingFaceUploads();
}, 30_000).unref();
