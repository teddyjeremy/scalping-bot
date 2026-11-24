import { mkdir, writeFile } from "node:fs/promises";

const pumpOffsets = [0, 70, 140, 210, 350, 500, 700, 1000, 1100, 1200, 1300, 1399, 1400];
const pumpProbes = ["ASC", "DESC"].flatMap(order => pumpOffsets.map(offset => ({
  name: `pumpfun_created_${order.toLowerCase()}_offset_${offset}`,
  url: `https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=100&sort=created_timestamp&order=${order}&includeNsfw=false`
})));

async function requestJson(name, url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "solana-research-archive/1.0" },
      signal: AbortSignal.timeout(25000)
    });
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    return { name, url, httpStatus: response.status, ok: response.ok, elapsedMs: Date.now() - started, body, bodyPreview: body ? null : raw.slice(0, 300) };
  } catch (error) {
    return { name, url, ok: false, elapsedMs: Date.now() - started, error: String(error).slice(0, 300) };
  }
}

function rowsFrom(body) {
  const data = body?.data ?? body;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function summarize(result) {
  const rows = rowsFrom(result.body);
  const pick = item => item ? {
    mint: item.mint ?? item.address ?? item.baseMint ?? null,
    createdAt: item.created_timestamp ?? item.createAt ?? item.createdAt ?? item.created_at ?? item.createTime ?? null,
    creator: item.creator ?? item.creatorAddress ?? null,
    pool: item.pool ?? item.poolId ?? item.id ?? null,
    platformId: item.platformInfo?.pubKey ?? null,
    platformName: item.platformInfo?.name ?? null,
    quoteMint: item.mintB?.address ?? item.mintB ?? null,
    curveConfig: item.configInfo?.pubKey ?? null,
    migrateType: item.migrateType ?? null
  } : null;
  const data = result.body?.data ?? result.body;
  return {
    name: result.name, httpStatus: result.httpStatus, ok: result.ok, elapsedMs: result.elapsedMs,
    rowCount: rows.length, first: pick(rows[0]), last: pick(rows.at(-1)),
    nextPageId: data && typeof data === "object" ? data.nextPageId ?? data.next_page_id ?? null : null,
    error: result.error ?? null, bodyPreview: result.bodyPreview ?? null
  };
}

const results = [];
for (const probe of pumpProbes) results.push(summarize(await requestJson(probe.name, probe.url)));
const pumpDateProbes = [
  {
    name: "pumpfun_coins_iso_date_window",
    url: "https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=created_timestamp&order=ASC&includeNsfw=false&fromDate=2026-11-01T00%3A00%3A00Z&toDate=2026-11-24T00%3A00%3A00Z"
  },
  {
    name: "pumpfun_coins_epoch_date_window",
    url: "https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=created_timestamp&order=ASC&includeNsfw=false&fromDate=1793491200&toDate=1795478400"
  },
  {
    name: "pumpfun_protected_iso_date_window",
    url: "https://frontend-api-v3.pump.fun/coins/protected?limit=100&offset=0&sort=created_timestamp&searchTerm=&order=ASC&includeNsfw=false&creator=&complete=false&isLive=false&fromDate=2026-11-01T00%3A00%3A00Z&toDate=2026-11-24T00%3A00%3A00Z&banned=false"
  },
  {
    name: "pumpfun_protected_epoch_date_window",
    url: "https://frontend-api-v3.pump.fun/coins/protected?limit=100&offset=0&sort=created_timestamp&searchTerm=&order=ASC&includeNsfw=false&creator=&complete=false&isLive=false&fromDate=1793491200&toDate=1795478400&banned=false"
  }
];
for (const probe of pumpDateProbes) results.push(summarize(await requestJson(probe.name, probe.url)));

const raydiumBase = "https://launch-mint-v1.raydium.io/get/list";
const targetStartMs = Date.parse("2026-11-01T00:00:00Z");
const platformIds = [
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"
];
const platformCoverage = [];
for (const platformId of platformIds) {
  let nextPageId = null;
  let reachedBoundary = false;
  let pages = 0;
  let rowCount = 0;
  let previousOldest = Number.POSITIVE_INFINITY;
  let monotonic = true;
  let platformMismatches = 0;
  const seenMints = new Set();
  let duplicateMints = 0;
  let earliest = null;
  let latest = null;

  for (let page = 1; page <= 60; page++) {
    const params = `platformId=${platformId}&sort=new&size=100&mintType=default&includeNsfw=false`;
    const url = `${raydiumBase}?${params}${nextPageId ? `&nextPageId=${encodeURIComponent(nextPageId)}` : ""}`;
    const response = await requestJson(`raydium_stonkfun_${platformId.slice(0, 6)}_page_${page}`, url);
    const rows = rowsFrom(response.body);
    const summary = summarize(response);
    results.push(summary);
    pages++;
    rowCount += rows.length;
    if (!response.ok || response.body?.success !== true || !Array.isArray(response.body?.data?.rows)) break;

    for (const row of rows) {
      if (row.platformInfo?.pubKey !== platformId) platformMismatches++;
      if (typeof row.mint === "string") {
        if (seenMints.has(row.mint)) duplicateMints++;
        seenMints.add(row.mint);
      }
    }
    const pageOldest = Number(rows.at(-1)?.createAt);
    const pageNewest = Number(rows[0]?.createAt);
    if (Number.isFinite(pageOldest)) {
      earliest = earliest === null ? pageOldest : Math.min(earliest, pageOldest);
      latest = latest === null ? pageNewest : Math.max(latest, pageNewest);
      if (pageOldest > previousOldest) monotonic = false;
      previousOldest = pageOldest;
      if (pageOldest <= targetStartMs) reachedBoundary = true;
    }

    const data = response.body.data;
    const next = data.nextPageId ?? null;
    if (reachedBoundary || !rows.length || !next || next === nextPageId) break;
    nextPageId = next;
  }

  platformCoverage.push({
    platformId, pages, rows: rowCount, uniqueMints: seenMints.size, duplicateMints,
    platformMismatches, monotonicCreatedAtDescending: monotonic,
    earliestCreateAt: earliest, latestCreateAt: latest,
    reachedNovember1Boundary: reachedBoundary
  });
}

const pumpHasRows = results.some(r => r.name.startsWith("pumpfun_") && r.ok && r.rowCount > 0 && r.first?.mint);
const platformCoverageComplete = platformCoverage.length === 2 && platformCoverage.every(p =>
  p.rows > 0 && p.uniqueMints === p.rows && p.duplicateMints === 0 &&
  p.platformMismatches === 0 && p.monotonicCreatedAtDescending && p.reachedNovember1Boundary
);

const report = {
  generatedAt: new Date().toISOString(),
  purpose: "Read-only launch-index pagination, historical boundary and StonkFun platform-filter probe; no Helius calls and no dataset writes.",
  historicalCollectionStarted: false,
  datasetWritten: false,
  pumpOffsetsTested: pumpOffsets,
  pumpSortOrdersTested: ["ASC", "DESC"],
  stonkfunPlatformCoverage: platformCoverage,
  checks: {
    pumpfunIndexReturnsRows: pumpHasRows,
    stonkfunFilteredIndexesReachNovember1WithUniqueMonotonicMints: platformCoverageComplete
  },
  status: pumpHasRows && platformCoverageComplete ? "discovery_indexes_passed_boundary_and_dedup_checks" : "discovery_indexes_not_fully_verified",
  results
};

console.log("LAUNCH_DISCOVERY_BOUNDARY_REPORT");
console.log(JSON.stringify(report, null, 2));
await mkdir("launch-discovery-probe-output", { recursive: true });
await writeFile("launch-discovery-probe-output/report.json", JSON.stringify(report, null, 2) + "\n");
if (!pumpHasRows || !platformCoverageComplete) process.exitCode = 2;
