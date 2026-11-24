import { readFile, writeFile } from "node:fs/promises";
import { reconstructTokenResearch } from "../src/research-metrics.js";

const input = process.argv[2];
const output = process.argv[3];
if (!input) {
  console.error("Usage: node --import tsx scripts/reconstruct-research-metrics.ts <events.jsonl> [output.json]");
  process.exitCode = 2;
} else {
  const text = await readFile(input, "utf8");
  const events: Array<Record<string, unknown>> = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed);
      else malformedLines++;
    } catch { malformedLines++; }
  }
  const report = { ...reconstructTokenResearch(events), malformedLines };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (output) await writeFile(output, serialized);
  else process.stdout.write(serialized);
}
