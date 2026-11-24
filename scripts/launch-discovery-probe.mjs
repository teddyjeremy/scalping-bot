import { mkdir, writeFile } from "node:fs/promises";

const probes = [
  {
    name: "pumpfun_frontend_coins",
    url: "https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=created_timestamp&order=ASC&includeNsfw=false",
    expected: "array"
  },
  {
    name: "raydium_launchlab_mint_list",
    url: "https://launch-mint-v1.raydium.io/get/list?size=5",
    expected: "rows_with_pagination"
  }
];

async function inspect(probe) {
  const started = Date.now();
  try {
    const response = await fetch(probe.url, {
      headers: { accept: "application/json", "user-agent": "solana-research-archive/1.0" },
      signal: AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const data = body?.data ?? body;
    const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows
      : Array.isArray(data?.items) ? data.items : Array.isArray(data?.list) ? data.list : null;
    const first = rows?.[0] ?? null;
    return {
      name: probe.name, httpStatus: response.status, ok: response.ok,
      elapsedMs: Date.now() - started, contentType: response.headers.get("content-type"),
      topLevelKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 30) : [],
      dataKeys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 40) : [],
      rowCount: rows?.length ?? null,
      firstRowKeys: first && typeof first === "object" ? Object.keys(first).slice(0, 60) : [],
      pagination: data && typeof data === "object" ? {
        nextPageId: data.nextPageId ?? data.next_page_id ?? null,
        total: data.total ?? null,
        hasMore: data.hasMore ?? data.has_more ?? null
      } : null,
      sample: first ? {
        mint: first.mint ?? first.address ?? first.baseMint ?? null,
        createdTimestamp: first.created_timestamp ?? first.createdAt ?? first.created_at ?? null,
        signature: first.signature ?? first.txid ?? first.createTx ?? null,
        pool: first.pool ?? first.poolId ?? first.id ?? null
      } : null,
      bodyPreview: rows ? null : raw.slice(0, 700)
    };
  } catch (error) {
    return { name: probe.name, ok: false, elapsedMs: Date.now() - started, error: String(error).slice(0, 500) };
  }
}

const results = [];
for (const probe of probes) results.push(await inspect(probe));
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "Read-only discovery endpoint compatibility probe; no Helius calls and no dataset writes",
  historicalCollectionStarted: false,
  datasetWritten: false,
  results
};
console.log("LAUNCH_DISCOVERY_PROBE_REPORT");
console.log(JSON.stringify(report, null, 2));
await mkdir("launch-discovery-probe-output", { recursive: true });
await writeFile("launch-discovery-probe-output/report.json", JSON.stringify(report, null, 2) + "\\n");
if (results.every(result => result.ok && result.rowCount !== null)) process.exitCode = 0;
else process.exitCode = 2;
