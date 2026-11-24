import { mkdir, writeFile } from "node:fs/promises";

const probes = [
  ...[0, 1000, 10000, 100000, 500000, 1000000].map(offset => ({
    name: `pumpfun_created_asc_offset_${offset}`,
    url: `https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=5&sort=created_timestamp&order=ASC&includeNsfw=false`
  })),
  {
    name: "pumpfun_created_desc_offset_0",
    url: "https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=created_timestamp&order=DESC&includeNsfw=false"
  },
  {
    name: "raydium_launchlab_created_asc",
    url: "https://launch-mint-v1.raydium.io/get/list?size=5&sort=createdAt&sortType=asc"
  },
  {
    name: "raydium_launchlab_created_desc",
    url: "https://launch-mint-v1.raydium.io/get/list?size=5&sort=createdAt&sortType=desc"
  },
  {
    name: "raydium_launchlab_sorttype_only",
    url: "https://launch-mint-v1.raydium.io/get/list?size=5&sortType=asc"
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
    const last = rows?.at(-1) ?? null;
    const pick = item => item ? {
      mint: item.mint ?? item.address ?? item.baseMint ?? item.mintA?.address ?? null,
      createdTimestamp: item.created_timestamp ?? item.createdAt ?? item.created_at ?? item.createTime ?? null,
      signature: item.signature ?? item.txid ?? item.createTx ?? item.createTxId ?? null,
      pool: item.pool ?? item.poolId ?? item.id ?? null
    } : null;
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
      first: pick(first), last: pick(last),
      bodyPreview: rows ? null : raw.slice(0, 500)
    };
  } catch (error) {
    return { name: probe.name, ok: false, elapsedMs: Date.now() - started, error: String(error).slice(0, 400) };
  }
}

const results = [];
for (const probe of probes) results.push(await inspect(probe));
const report = {
  generatedAt: new Date().toISOString(),
  purpose: "Read-only launch discovery endpoint compatibility and pagination probe; no Helius calls and no dataset writes",
  historicalCollectionStarted: false,
  datasetWritten: false,
  results
};
console.log("LAUNCH_DISCOVERY_PROBE_REPORT");
console.log(JSON.stringify(report, null, 2));
await mkdir("launch-discovery-probe-output", { recursive: true });
await writeFile("launch-discovery-probe-output/report.json", JSON.stringify(report, null, 2) + "\n");
if (!results.some(result => result.ok && result.rowCount !== null)) process.exitCode = 2;
