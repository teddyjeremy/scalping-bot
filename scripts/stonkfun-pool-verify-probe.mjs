import { findStonkFunLaunchInstructions } from "../src/launchlab-instructions.js";

const keys = [
  process.env.HELIUS_API_KEY_1,
  process.env.HELIUS_API_KEY_2,
  process.env.HELIUS_API_KEY_3
];
if (keys.some(key => !key) || new Set(keys).size !== 3) {
  throw new Error("StonkFun pool verification requires three distinct Helius API keys.");
}

const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const STONK_CONFIGS = new Set([
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"
]);
const samples = [
  {
    label: "reward_config",
    mint: "4yCZKKfyJKX3WHcytq6ojF31uKNUSvb9Dkr2p8Qc1YA3",
    pool: "3smqYePUinM9MQoPLKpBKz2iZpuBWo2KGoG5yfzjLjg2",
    platformConfig: "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
    createAtMs: 1794000389000
  },
  {
    label: "standard_config",
    mint: "88NRDhWA6dMV5B4JcZjggwF2c2VLxLctLec16ZgkcZ9g",
    pool: "3KbdSnZMHbHuRAquTRbKziTWincjs5exqBPGpRmQGfBo",
    platformConfig: "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7",
    createAtMs: 1794170337000
  }
];

let requestCount = 0;
let keyCursor = 0;
let lastStarted = 0;
const keyStats = keys.map((_, i) => ({ keySlot: i + 1, calls: 0, rateLimits: 0 }));

async function rpc(method, params) {
  const keyIndex = keyCursor++ % keys.length;
  const wait = Math.max(0, 750 - (Date.now() - lastStarted));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastStarted = Date.now();
  requestCount++;
  keyStats[keyIndex].calls++;
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${keys[keyIndex]}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `stonkfun-verify-${requestCount}`, method, params }),
    signal: AbortSignal.timeout(25000)
  });
  const raw = await response.text();
  if (response.status === 429) {
    keyStats[keyIndex].rateLimits++;
    throw new Error(`${method} returned HTTP 429 on key slot ${keyIndex + 1}`);
  }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${raw.slice(0, 200)}`);
  const body = JSON.parse(raw);
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  return body.result;
}

function normalizeInstruction(ix) {
  const programId = ix?.programId?.toBase58?.() ?? ix?.programId ?? null;
  const data = ix?.data ?? null;
  const accounts = Array.isArray(ix?.accounts)
    ? ix.accounts.map(account => account?.toBase58?.() ?? String(account))
    : [];
  return { programId: String(programId ?? ""), data, accounts };
}

function transactionInstructions(tx) {
  const message = tx?.transaction?.message;
  const top = Array.isArray(message?.instructions) ? message.instructions : [];
  const inner = Array.isArray(tx?.meta?.innerInstructions)
    ? tx.meta.innerInstructions.flatMap(group => Array.isArray(group.instructions) ? group.instructions : [])
    : [];
  return [...top, ...inner].map(normalizeInstruction);
}

const results = [];
for (const sample of samples) {
  const expectedCreateAt = Math.floor(sample.createAtMs / 1000);
  let before;
  let signatures = [];
  let pages = 0;
  let oldestSeen = null;
  let candidate = null;
  while (pages < 10) {
    const page = await rpc("getSignaturesForAddress", [
      sample.pool,
      { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }
    ]);
    if (!Array.isArray(page) || page.length === 0) break;
    pages++;
    signatures = page;
    const oldest = page.at(-1);
    oldestSeen = oldest?.blockTime ?? oldestSeen;
    const inWindow = page.filter(row =>
      Number.isSafeInteger(row.blockTime) &&
      Math.abs(row.blockTime - expectedCreateAt) <= 30
    );
    if (inWindow.length) {
      candidate = inWindow.reduce((best, row) =>
        Math.abs(row.blockTime - expectedCreateAt) < Math.abs(best.blockTime - expectedCreateAt) ? row : best
      );
      break;
    }
    if (!oldest?.signature || !Number.isSafeInteger(oldest.blockTime) || oldest.blockTime <= expectedCreateAt + 30) break;
    before = oldest.signature;
  }

  const transaction = candidate?.signature
    ? await rpc("getTransaction", [
        candidate.signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ])
    : null;
  const decoded = transaction
    ? findStonkFunLaunchInstructions(transactionInstructions(transaction), LAUNCHLAB, STONK_CONFIGS)
    : [];
  const match = decoded.find(item =>
    item.mint === sample.mint &&
    item.pool === sample.pool &&
    item.platformConfig === sample.platformConfig
  ) ?? null;

  results.push({
    label: sample.label,
    expectedMint: sample.mint,
    expectedPool: sample.pool,
    expectedPlatformConfig: sample.platformConfig,
    expectedCreateAtUtc: new Date(sample.createAtMs).toISOString(),
    signaturePages: pages,
    signaturesOnLastPage: signatures.length,
    oldestSeenUtc: Number.isSafeInteger(oldestSeen) ? new Date(oldestSeen * 1000).toISOString() : null,
    candidateSignature: candidate?.signature ?? null,
    candidateBlockTimeUtc: Number.isSafeInteger(candidate?.blockTime) ? new Date(candidate.blockTime * 1000).toISOString() : null,
    createAtDifferenceSeconds: Number.isSafeInteger(candidate?.blockTime) ? candidate.blockTime - expectedCreateAt : null,
    transactionHydrated: Boolean(transaction?.meta && transaction?.transaction),
    launchInstructionDecoded: decoded.length > 0,
    exactMintPoolPlatformMatch: Boolean(match),
    decodedMatch: match
  });
}

const report = {
  status: results.length === samples.length && results.every(item => item.exactMintPoolPlatformMatch)
    ? "pool_signature_to_launch_instruction_verification_passed"
    : "pool_signature_to_launch_instruction_verification_not_proven",
  readOnly: true,
  datasetWritten: false,
  requestCount,
  keyStats,
  results
};
console.log("STONKFUN_POOL_VERIFICATION_REPORT");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pool_signature_to_launch_instruction_verification_passed") process.exitCode = 2;
