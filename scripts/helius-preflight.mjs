import { PublicKey } from "@solana/web3.js";

const keys = [
  process.env.HELIUS_API_KEY_1,
  process.env.HELIUS_API_KEY_2,
  process.env.HELIUS_API_KEY_3
];
if (keys.some(key => !key) || new Set(keys).size !== 3) {
  throw new Error("Preflight requires three distinct Helius API keys.");
}

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_MINT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("mint-authority")], new PublicKey(PUMP)
)[0].toBase58();
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const addresses = [
  { name: "Pump.fun mint-authority history", address: PUMP_MINT_AUTHORITY },
  { name: "Raydium LaunchLab program history", address: LAUNCHLAB }
];
let rpcCalls = 0;

async function rpc(key, method, params = []) {
  rpcCalls++;
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `solana-v3-preflight-${rpcCalls}`, method, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${bodyText.slice(0, 180)}`);
  let body;
  try { body = JSON.parse(bodyText); }
  catch { throw new Error(`${method} returned invalid JSON.`); }
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method} response has no result.`);
  return body.result;
}

const keyHealth = [];
for (let i = 0; i < keys.length; i++) {
  const [version, slot] = await Promise.all([
    rpc(keys[i], "getVersion"),
    rpc(keys[i], "getSlot", [{ commitment: "confirmed" }])
  ]);
  if (!version?.["solana-core"] || !Number.isSafeInteger(slot) || slot <= 0) {
    throw new Error(`Helius key slot ${i + 1} failed standard RPC validation.`);
  }
  keyHealth.push({ keySlot: i + 1, status: "ok", solanaCore: version["solana-core"], confirmedSlot: slot });
}

const historyChecks = [];
for (const item of addresses) {
  const firstPage = await rpc(keys[0], "getSignaturesForAddress", [
    item.address, { limit: 2, commitment: "confirmed" }
  ]);
  if (!Array.isArray(firstPage) || firstPage.length === 0) {
    throw new Error(`${item.name}: standard getSignaturesForAddress returned no signatures.`);
  }
  const first = firstPage[0];
  if (typeof first.signature !== "string" || !Number.isSafeInteger(first.slot)) {
    throw new Error(`${item.name}: signature page is missing signature or slot fields.`);
  }

  const nextPage = await rpc(keys[0], "getSignaturesForAddress", [
    item.address, { limit: 2, before: firstPage[firstPage.length - 1].signature, commitment: "confirmed" }
  ]);
  if (!Array.isArray(nextPage)) throw new Error(`${item.name}: pagination response was not an array.`);
  const firstPageSignatures = new Set(firstPage.map(row => row.signature));
  if (nextPage.some(row => firstPageSignatures.has(row.signature))) {
    throw new Error(`${item.name}: before-cursor pagination returned a duplicate signature.`);
  }

  const transaction = await rpc(keys[0], "getTransaction", [
    first.signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
  ]);
  if (!transaction?.meta || !transaction?.transaction?.signatures?.length) {
    throw new Error(`${item.name}: getTransaction did not return transaction signatures and metadata.`);
  }

  historyChecks.push({
    address: item.name,
    firstPageRows: firstPage.length,
    secondPageRows: nextPage.length,
    paginationCursorAdvanced: nextPage.length === 0 || !firstPageSignatures.has(nextPage[0].signature),
    sampleSignature: first.signature,
    sampleSlot: first.slot,
    sampleBlockTime: first.blockTime ?? null,
    transactionMetadataPresent: true
  });
}

console.log(JSON.stringify({
  status: "standard_rpc_preflight_passed",
  collectionStarted: false,
  enhancedHistoricalEndpointUsed: false,
  keys: keyHealth,
  standardHistory: historyChecks,
  rpcCalls,
  quotaNote: "This preflight counts requests only. It does not claim to measure remaining monthly credits or that three keys multiply the account quota.",
  coverageNote: "This verifies standard RPC access, pagination and transaction hydration on current indexed samples. It does not prove the full November archive has been traversed."
}, null, 2));
