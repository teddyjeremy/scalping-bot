import { writeFile, mkdir } from "node:fs/promises";

const DAYS = (process.env.PUMPDATA_PROBE_DAYS ?? "2026-11-23,2026-11-22,2026-11-24").split(",").map(x => x.trim()).filter(Boolean);
const OUT = "pumpdata-index-probe-output";
const BASE = "https://pumpdata.fun/launches";

async function inspectDay(day) {
  const response = await fetch(`${BASE}/${day}.json`, {
    headers: { accept: "application/json", "user-agent": "solana-scalping-research/1.0" },
    signal: AbortSignal.timeout(60_000)
  });
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.slice(0, 300);
    try { detail = JSON.stringify(JSON.parse(raw)); } catch {}
    return { day, httpStatus: response.status, available: false, detail };
  }

  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`PumpData ${day} returned invalid JSON.`); }

  if (!Array.isArray(body.columns) || !Array.isArray(body.launches)) {
    throw new Error(`PumpData ${day} response is missing columns/launches arrays.`);
  }
  const index = Object.fromEntries(body.columns.map((column, i) => [column, i]));
  for (const required of ["mint", "created", "creator"]) {
    if (!(required in index)) throw new Error(`PumpData ${day} is missing required column ${required}.`);
  }

  const mints = new Set();
  let duplicates = 0;
  let invalidRows = 0;
  let outOfDayRows = 0;
  let oldest = null;
  let newest = null;
  for (const row of body.launches) {
    if (!Array.isArray(row) || row.length !== body.columns.length) {
      invalidRows++;
      continue;
    }
    const mint = row[index.mint];
    const created = Number(row[index.created]);
    if (typeof mint !== "string" || !mint || !Number.isFinite(created)) {
      invalidRows++;
      continue;
    }
    if (mints.has(mint)) duplicates++;
    mints.add(mint);
    oldest = oldest === null ? created : Math.min(oldest, created);
    newest = newest === null ? created : Math.max(newest, created);
    const start = Date.parse(day + "T00:00:00Z") / 1000;
    const end = start + 86400;
    if (created < start || created >= end) outOfDayRows++;
  }

  return {
    day,
    httpStatus: response.status,
    available: true,
    complete: body.complete ?? null,
    completeTo: body.complete_to ?? null,
    declaredCount: body.count ?? null,
    rows: body.launches.length,
    columns: body.columns,
    requiredColumnsPresent: true,
    uniqueMints: mints.size,
    duplicateMints: duplicates,
    invalidRows,
    outOfDayRows,
    oldestUtc: oldest === null ? null : new Date(oldest * 1000).toISOString(),
    newestUtc: newest === null ? null : new Date(newest * 1000).toISOString(),
    sample: body.launches.slice(0, 2).map(row => ({
      mint: row[index.mint],
      creator: row[index.creator],
      created: row[index.created]
    })),
    rawBytes: Buffer.byteLength(raw)
  };
}

const results = [];
for (const day of DAYS) results.push(await inspectDay(day));
const report = {
  generatedAt: new Date().toISOString(),
  source: "https://pumpdata.fun/launches/{YYYY-MM-DD}.json",
  purpose: "read-only discovery source probe; no Helius calls and no dataset writes",
  results
};
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2) + "\n");
console.log("PUMPDATA_INDEX_PROBE_REPORT");
console.log(JSON.stringify(report, null, 2));

const target = results.find(x => x.day === "2026-11-23");
if (!target?.available || target.complete !== true || target.rows === 0 ||
    target.uniqueMints !== target.rows || target.duplicateMints !== 0 ||
    target.invalidRows !== 0 || target.outOfDayRows !== 0) {
  console.error("PumpData Nov 23 daily launch index did not pass completeness/integrity checks.");
  process.exitCode = 2;
}
