import { readFile, writeFile } from "node:fs/promises";
import { reconstructCrossTokenWalletGraph } from "../src/wallet-graph.js";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const files = args.filter((arg, index) => arg !== "--output" && index !== outputIndex + 1);
if (files.length === 0) {
  console.error("Usage: node --import tsx scripts/reconstruct-wallet-graph.ts <events.jsonl> [more-events.jsonl ...] [--output report.json]");
  process.exitCode = 2;
} else {
  const events: Array<Record<string, unknown>> = [];
  const malformedByFile: Record<string, number> = {};
  for (const file of files) {
    const content = await readFile(file, "utf8");
    let malformed = 0;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed);
        else malformed++;
      } catch { malformed++; }
    }
    malformedByFile[file] = malformed;
  }
  const report = {
    sourceFiles: files,
    malformedLinesByFile: malformedByFile,
    ...reconstructCrossTokenWalletGraph(events)
  };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (output) await writeFile(output, serialized);
  else process.stdout.write(serialized);
}
