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

const INITIALIZERS = new Map([
  ["afaf6d1f0d989bed", "initialize"],
  ["4399af27da102620", "initialize_v2"],
  ["25be7ede2c9aab11", "initialize_with_token_2022"]
]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("Invalid base58 instruction data");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}
function decodeStonkLaunches(instructions) {
  const found = [];
  for (const ix of instructions) {
    if (ix.programId !== LAUNCHLAB || typeof ix.data !== "string" || !Array.isArray(ix.accounts) || ix.accounts.length < 8) continue;
    let data;
    try { data = decodeBase58(ix.data); } catch { continue; }
    if (data.length < 8) continue;
    const discriminator = [...data.slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const kind = INITIALIZERS.get(discriminator);
    const platformConfig = String(ix.accounts[3] ?? "");
    if (!kind || !STONK_CONFIGS.has(platformConfig)) continue;
    found.push({
      kind,
      payer: String(ix.accounts[0] ?? ""),
      creator: String(ix.accounts[1] ?? ""),
      platformConfig,
      pool: String(ix.accounts[5] ?? ""),
      mint: String(ix.accounts[6] ?? ""),
      quoteMint: String(ix.accounts[7] ?? "")
    });
  }
  return found;
}
const samples = [
  {
    label: "reward_config",
    mint: "4yCZKKfyJKX3WHcytq6ojF31uKNUSvb9Dkr2p8Qc1YA3",
    apiPool: "3smqYePUinM9MQoPLKpBKz2iZpuBWo2KGoG5yfzjLjg2",
    platformConfig: "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
    createAtMs: 1794000389000
  },
  {
    label: "standard_config",
    mint: "88NRDhWA6dMV5B4JcZjggwF2c2VLxLctLec16ZgkcZ9g",
    apiPool: "3KbdSnZMHbHuRAquTRbKziTWincjs5exqBPGpRmQGfBo",
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
  let launchMatch = null;
  let launchSignature = null;
  let launchBlockTime = null;
  let checkedSignatures = 0;
  let apiCreateTransaction = null;

  while (pages < 10 && !launchMatch) {
    const page = await rpc("getSignaturesForAddress", [
      sample.mint,
      { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }
    ]);
    if (!Array.isArray(page) || page.length === 0) break;
    pages++;
    signatures = page;
    const oldest = page.at(-1);
    oldestSeen = oldest?.blockTime ?? oldestSeen;

    for (const row of page) {
      if (!row.signature) continue;
      const tx = await rpc("getTransaction", [
        row.signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ]);
      checkedSignatures++;
      if (!tx?.meta || !tx?.transaction) continue;
      const decoded = decodeStonkLaunches(transactionInstructions(tx));
      const match = decoded.find(item =>
        item.mint === sample.mint &&
        item.platformConfig === sample.platformConfig
      );
      if (match) {
        launchMatch = match;
        launchSignature = row.signature;
        launchBlockTime = row.blockTime;
        break;
      }
      if (row.blockTime === expectedCreateAt) apiCreateTransaction = {
        signature: row.signature,
        blockTime: row.blockTime,
        programInstructions: transactionInstructions(tx)
          .filter(ix => ix.programId === LAUNCHLAB)
          .map(ix => ({
            discriminator: [...decodeBase58(ix.data).slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            accounts: ix.accounts.slice(0, 10)
          }))
      };
    }
    if (launchMatch) break;
    if (!oldest?.signature || !Number.isSafeInteger(oldest.blockTime) || oldest.blockTime < expectedCreateAt - 86_400) break;
    before = oldest.signature;
  }

  const exactMintPlatformMatch = Boolean(launchMatch);

  results.push({
    label: sample.label,
    expectedMint: sample.mint,
    apiPool: sample.apiPool,
    expectedPlatformConfig: sample.platformConfig,
    expectedCreateAtUtc: new Date(sample.createAtMs).toISOString(),
    signaturePages: pages,
    signaturesOnLastPage: signatures.length,
    checkedSignatures,
    oldestSeenUtc: Number.isSafeInteger(oldestSeen) ? new Date(oldestSeen * 1000).toISOString() : null,
    launchSignature,
    launchBlockTimeUtc: Number.isSafeInteger(launchBlockTime) ? new Date(launchBlockTime * 1000).toISOString() : null,
    launchVsApiCreateAtSeconds: Number.isSafeInteger(launchBlockTime) ? launchBlockTime - expectedCreateAt : null,
    exactMintPlatformMatch,
    apiPoolMatchesLaunchCurvePool: Boolean(launchMatch && sample.apiPool === launchMatch.pool),
    decodedMatch: launchMatch,
    apiCreateTransaction
  });
}

const report = {
  status: results.length === samples.length && results.every(item => item.exactMintPlatformMatch)
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
