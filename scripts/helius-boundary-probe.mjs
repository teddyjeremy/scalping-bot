import { PublicKey } from "@solana/web3.js";
import { writeFile, mkdir } from "node:fs/promises";

const keys = [
  process.env.HELIUS_API_KEY_1,
  process.env.HELIUS_API_KEY_2,
  process.env.HELIUS_API_KEY_3
];
if (keys.some(key => !key) || new Set(keys).size !== 3) {
  throw new Error("Boundary probe requires three distinct Helius API keys.");
}
const TARGET = Math.floor(Date.parse(process.env.HISTORY_BOUNDARY_UTC ?? "2026-11-01T00:00:00Z") / 1000);
const MAX_PAGES = Math.max(1, Math.min(250, Number(process.env.BOUNDARY_MAX_PAGES ?? 250)));
const PAGE_SIZE = 1000;
const MIN_GLOBAL_INTERVAL_MS = 750;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], new PublicKey(PUMP))[0].toBase58();
const targets = [
  { name: "pumpfun_mint_authority", address: PUMP_AUTHORITY },
  { name: "raydium_launchlab_program", address: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" }
];
let calls = 0;
let lastStarted = 0;
let keyCursor = 0;
const keyStats = keys.map((_, i) => ({ keySlot: i + 1, calls: 0, rateLimits: 0 }));

async function rpc(method, params) {
  let lastError;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIndex = keyCursor++ % keys.length;
    const wait = Math.max(0, MIN_GLOBAL_INTERVAL_MS - (Date.now() - lastStarted));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastStarted = Date.now();
    calls++;
    keyStats[keyIndex].calls++;
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${keys[keyIndex]}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `boundary-${calls}`, method, params }),
      signal: AbortSignal.timeout(25_000)
    });
    const raw = await response.text();
    if (response.status === 429) {
      keyStats[keyIndex].rateLimits++;
      lastError = new Error(`${method} HTTP 429 on key slot ${keyIndex + 1}`);
      await new Promise(resolve => setTimeout(resolve, 5_000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${raw.slice(0, 250)}`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`${method} returned invalid JSON`); }
    if (body.error) {
      if (body.error.code === 429 || /rate.?limit|too many requests/i.test(body.error.message ?? "")) {
        keyStats[keyIndex].rateLimits++;
        lastError = new Error(`${method} RPC rate limit on key slot ${keyIndex + 1}`);
        await new Promise(resolve => setTimeout(resolve, 5_000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
    }
    if (body.result === undefined) throw new Error(`${method} response has no result`);
    return body.result;
  }
  throw lastError ?? new Error(`All keys failed for ${method}`);
}

const results = [];
for (const target of targets) {
  let before;
  let pages = 0;
  let signatures = 0;
  let oldestBlockTime = null;
  let newestBlockTime = null;
  let oldestSignature = null;
  let reachedBoundary = false;
  let lastPageRows = 0;
  const seenCursors = new Set();

  while (pages < MAX_PAGES && !reachedBoundary) {
    const page = await rpc("getSignaturesForAddress", [
      target.address,
      { limit: PAGE_SIZE, commitment: "confirmed", ...(before ? { before } : {}) }
    ]);
    if (!Array.isArray(page)) throw new Error(`${target.name}: signature page was not an array`);
    if (page.length === 0) break;
    pages++;
    signatures += page.length;
    lastPageRows = page.length;
    const times = page.map(row => row.blockTime).filter(value => Number.isSafeInteger(value));
    if (times.length) {
      const pageOldest = Math.min(...times);
      const pageNewest = Math.max(...times);
      oldestBlockTime = oldestBlockTime === null ? pageOldest : Math.min(oldestBlockTime, pageOldest);
      newestBlockTime = newestBlockTime === null ? pageNewest : Math.max(newestBlockTime, pageNewest);
      if (pageOldest <= TARGET) {
        const row = page.find(item => item.blockTime === pageOldest);
        oldestSignature = row?.signature ?? null;
        reachedBoundary = true;
      }
    }
    const nextBefore = page[page.length - 1]?.signature;
    if (typeof nextBefore !== "string" || !nextBefore) throw new Error(`${target.name}: page missing pagination signature`);
    if (seenCursors.has(nextBefore)) throw new Error(`${target.name}: pagination cursor repeated; refusing to loop`);
    seenCursors.add(nextBefore);
    before = nextBefore;
    console.log(JSON.stringify({
      target: target.name, page: pages, rows: page.length,
      oldestBlockTime, oldestUtc: oldestBlockTime === null ? null : new Date(oldestBlockTime * 1000).toISOString(),
      reachedBoundary
    }));
    if (page.length < PAGE_SIZE) break;
  }

  // Hydrate the oldest sampled signature to verify that historical transaction detail
  // can be retrieved at the depth reached by this bounded probe.
  let oldestTransactionHydrated = false;
  if (oldestSignature) {
    const transaction = await rpc("getTransaction", [
      oldestSignature,
      { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
    ]);
    oldestTransactionHydrated = Boolean(transaction?.meta && transaction?.transaction?.signatures?.length);
  }

  results.push({
    target: target.name,
    address: target.address,
    pagesScanned: pages,
    signaturesScanned: signatures,
    pageSize: PAGE_SIZE,
    oldestBlockTime,
    oldestUtc: oldestBlockTime === null ? null : new Date(oldestBlockTime * 1000).toISOString(),
    newestUtc: newestBlockTime === null ? null : new Date(newestBlockTime * 1000).toISOString(),
    reachedNovember1Boundary: reachedBoundary,
    oldestSignatureTransactionHydrated: oldestTransactionHydrated,
    pageLimitReached: pages >= MAX_PAGES && !reachedBoundary,
    lastPageRows
  });
}

const report = {
  status: results.every(item => item.reachedNovember1Boundary && item.oldestSignatureTransactionHydrated)
    ? "november_boundary_reached_for_both_program_addresses"
    : "november_boundary_not_proven",
  targetBoundaryUtc: new Date(TARGET * 1000).toISOString(),
  readOnly: true,
  collectionStarted: false,
  datasetWritten: false,
  historicalDataStored: false,
  method: "getSignaturesForAddress pagination plus getTransaction hydration",
  rpcCalls: calls,
  keys: keyStats,
  results,
  quota: {
    creditsRemainingMeasured: false,
    accountMonthlyCreditAllowanceInferred: false,
    note: "Request counts are measured. Helius account credit balance is not exposed by these standard RPC calls; three keys are not assumed to multiply the account quota."
  }
};
await mkdir("boundary-probe-output", { recursive: true });
await writeFile("boundary-probe-output/report.json", JSON.stringify(report, null, 2) + "\n");
console.log("BOUNDARY_PROBE_REPORT");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "november_boundary_reached_for_both_program_addresses") {
  process.exitCode = 2;
}
