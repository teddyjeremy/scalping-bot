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
    platformInfo: item.platformInfo ?? null,
    configInfo: item.configInfo ?? null,
    mintB: item.mintB ?? null,
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

const raydiumBase = "https://launch-mint-v1.raydium.io/get/list";
const raydiumBaseParams = "sort=new&size=100&mintType=default&includeNsfw=false";
for (const [label, platformId] of [
  ["stonkfun_reward_config_filter", "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt"],
  ["stonkfun_standard_config_filter", "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"]
]) {
  const response = await requestJson(label, `${raydiumBase}?platformId=${platformId}&${raydiumBaseParams}`);
  results.push(summarize(response));
}

const raydiumParams = "platformId=PlatformWhiteList&sort=new&size=100&mintType=default&includeNsfw=false";
const targetStartMs = Date.parse("2026-11-01T00:00:00Z");
let nextPageId = null;
let raydiumReachedTargetStart = false;
let raydiumPageCount = 0;
for (let page = 1; page <= 60; page++) {
  const url = `${raydiumBase}?${raydiumParams}${nextPageId ? `&nextPageId=${encodeURIComponent(nextPageId)}` : ""}`;
  const response = await requestJson(`raydium_launchlab_new_page_${page}`, url);
  const summary = summarize(response);
  results.push(summary);
  const data = response.body?.data ?? {};
  const next = data?.nextPageId ?? null;
  raydiumPageCount++;
  const oldestOnPage = summary.last?.createdAt;
  if (Number.isFinite(oldestOnPage) && oldestOnPage <= targetStartMs) {
    raydiumReachedTargetStart = true;
    break;
  }
  if (!response.ok || response.body?.success !== true || !summary.rowCount || !next || next === nextPageId) break;
  nextPageId = next;
}

const pumpHasRows = results.some(r => r.name.startsWith("pumpfun_") && r.ok && r.rowCount > 0 && r.first?.mint);
const raydiumPages = results.filter(r => r.name.startsWith("raydium_launchlab_new_page_") && r.ok && r.rowCount > 0);
const raydiumDates = raydiumPages.flatMap(r => [r.first?.createdAt, r.last?.createdAt]).filter(Number.isFinite);
const platformFilterResults = results.filter(r => r.name.startsWith("stonkfun_"));

const report = {
  generatedAt: new Date().toISOString(),
  purpose: "Read-only launch-index pagination, historical boundary and StonkFun platform-filter probe; no Helius calls and no dataset writes.",
  historicalCollectionStarted: false,
  datasetWritten: false,
  pumpOffsetsTested: pumpOffsets,
  pumpSortOrdersTested: ["ASC", "DESC"],
  raydiumPagesTested: raydiumPageCount,
  raydiumEarliestObservedCreateAt: raydiumDates.length ? Math.min(...raydiumDates) : null,
  raydiumLatestObservedCreateAt: raydiumDates.length ? Math.max(...raydiumDates) : null,
  raydiumReachedNovember1Boundary: raydiumReachedTargetStart,
  stonkfunPlatformFilterRows: Object.fromEntries(platformFilterResults.map(r => [r.name, r.rowCount])),
  checks: {
    pumpfunIndexReturnsRows: pumpHasRows,
    raydiumLaunchLabIndexReturnsRows: raydiumPages.length > 0,
    raydiumCursorObserved: raydiumPages.some(r => r.nextPageId)
  },
  status: pumpHasRows && raydiumPages.length ? "both_discovery_sources_return_rows" : "discovery_sources_not_both_verified",
  results
};

console.log("LAUNCH_DISCOVERY_BOUNDARY_REPORT");
console.log(JSON.stringify(report, null, 2));
await mkdir("launch-discovery-probe-output", { recursive: true });
await writeFile("launch-discovery-probe-output/report.json", JSON.stringify(report, null, 2) + "\n");
if (!pumpHasRows || !raydiumPages.length) process.exitCode = 2;
