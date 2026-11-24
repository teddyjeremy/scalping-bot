import { mkdir, writeFile } from "node:fs/promises";

const pumpOffsets = [0, 500, 1000, 1500, 2000, 3000, 5000, 8000, 12000];
const pumpProbes = pumpOffsets.map(offset => ({
  name: `pumpfun_created_asc_offset_${offset}`,
  url: `https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=100&sort=created_timestamp&order=ASC&includeNsfw=false`
}));

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
    return {
      name, url, httpStatus: response.status, ok: response.ok,
      elapsedMs: Date.now() - started,
      body,
      bodyPreview: body ? null : raw.slice(0, 500)
    };
  } catch (error) {
    return { name, url, ok: false, elapsedMs: Date.now() - started, error: String(error).slice(0, 400) };
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

function summarize(name, result) {
  const rows = rowsFrom(result.body);
  const first = rows[0] ?? null;
  const last = rows.at(-1) ?? null;
  const pick = item => item ? {
    mint: item.mint ?? item.address ?? item.baseMint ?? null,
    createdTimestamp: item.created_timestamp ?? item.createdAt ?? item.created_at ?? item.createTime ?? null,
    creator: item.creator ?? item.creatorAddress ?? null,
    pool: item.pool ?? item.poolId ?? item.id ?? null
  } : null;
  const data = result.body?.data ?? result.body;
  return {
    name, url: result.url, httpStatus: result.httpStatus, ok: result.ok,
    elapsedMs: result.elapsedMs, rowCount: rows.length,
    firstRowKeys: first ? Object.keys(first).slice(0, 60) : [],
    pagination: data && typeof data === "object" ? {
      nextPageId: data.nextPageId ?? data.next_page_id ?? null,
      total: data.total ?? null,
      hasMore: data.hasMore ?? data.has_more ?? null
    } : null,
    first: pick(first), last: pick(last),
    error: result.error ?? null,
    bodyPreview: result.bodyPreview ?? null
  };
}

const results = [];
for (const probe of pumpProbes) {
  const response = await requestJson(probe.name, probe.url);
  results.push(summarize(probe.name, response));
}

const raydiumBase = "https://launch-mint-v1.raydium.io/get/list";
const raydiumParams = "platformId=PlatformWhiteList&sort=new&size=100&mintType=default&includeNsfw=false";
const raydiumFirst = await requestJson(
  "raydium_launchlab_new_page_1",
  `${raydiumBase}?${raydiumParams}`
);
results.push(summarize("raydium_launchlab_new_page_1", raydiumFirst));

const raydiumData = raydiumFirst.body?.data ?? {};
const nextPageId = raydiumData?.nextPageId ?? null;
if (raydiumFirst.ok && raydiumFirst.body?.success === true && nextPageId) {
  const second = await requestJson(
    "raydium_launchlab_new_page_2",
    `${raydiumBase}?${raydiumParams}&nextPageId=${encodeURIComponent(nextPageId)}`
  );
  results.push(summarize("raydium_launchlab_new_page_2", second));
} else {
  results.push({
    name: "raydium_launchlab_new_page_2",
    skipped: true,
    reason: "First page did not return a success envelope with nextPageId"
  });
}

const pumpHasRows = results.some(r => r.name.startsWith("pumpfun_") && r.ok && r.rowCount > 0 && r.first?.mint);
const raydiumHasRows = results.some(r => r.name === "raydium_launchlab_new_page_1" && r.ok && r.rowCount > 0 && r.first?.mint);
const raydiumCursorObserved = results.some(r => r.name === "raydium_launchlab_new_page_1" && r.pagination?.nextPageId);

const report = {
  generatedAt: new Date().toISOString(),
  purpose: "Read-only discovery API pagination probe. No Helius calls and no dataset writes.",
  historicalCollectionStarted: false,
  datasetWritten: false,
  pumpOffsetsTested: pumpOffsets,
  raydiumPagination: "cursor-based nextPageId, using official Raydium SDK example parameters",
  checks: {
    pumpfunIndexReturnsRows: pumpHasRows,
    raydiumLaunchLabIndexReturnsRows: raydiumHasRows,
    raydiumCursorObserved
  },
  status: pumpHasRows && raydiumHasRows ? "both_discovery_sources_return_rows" : "discovery_sources_not_both_verified",
  results
};

console.log("LAUNCH_DISCOVERY_PROBE_REPORT");
console.log(JSON.stringify(report, null, 2));
await mkdir("launch-discovery-probe-output", { recursive: true });
await writeFile("launch-discovery-probe-output/report.json", JSON.stringify(report, null, 2) + "\n");
if (!pumpHasRows || !raydiumHasRows) process.exitCode = 2;
