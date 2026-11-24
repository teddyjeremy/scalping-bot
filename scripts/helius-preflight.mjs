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
const START = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000);
const END = Math.floor(Date.parse("2026-11-24T00:00:00Z") / 1000);

async function rpc(key, method, params = []) {
  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "solana-v3-preflight", method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 180)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`);
  return body.result;
}

for (let i = 0; i < keys.length; i++) {
  const version = await rpc(keys[i], "getVersion");
  if (!version || typeof version["solana-core"] !== "string") {
    throw new Error(`Helius key slot ${i + 1} returned an invalid getVersion response.`);
  }
  console.log(`Helius key slot ${i + 1}: authenticated; Solana core ${version["solana-core"]}`);
}

async function checkHistory(label, address, requireRows) {
  const options = {
    transactionDetails: "full",
    sortOrder: "asc",
    limit: 2,
    commitment: "confirmed",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 1,
    filters: { blockTime: { gte: START, lte: END }, status: "any" }
  };
  let rows = null;
  let enhanced = true;
  try {
    const result = await rpc(keys[0], "getTransactionsForAddress", [address, options]);
    if (!result || !Array.isArray(result.data)) {
      throw new Error("getTransactionsForAddress returned an unexpected result shape.");
    }
    rows = result.data;
    console.log(`${label}: enhanced history supported; sampled rows=${rows.length}; paginationToken=${result.paginationToken ? "present" : "none"}`);
  } catch (error) {
    const message = String(error);
    if (!/method not found|not available|not supported|unauthorized|forbidden|401|403/i.test(message)) throw error;
    enhanced = false;
    const signatures = await rpc(keys[0], "getSignaturesForAddress", [address, { limit: 2 }, "confirmed"]);
    rows = signatures.map(row => ({ signature: row.signature, slot: row.slot, blockTime: row.blockTime }));
    console.log(`${label}: enhanced history unavailable; standard RPC fallback returned ${rows.length} signatures`);
  }
  if (requireRows && !rows.length) {
    throw new Error(`${label}: no indexed transactions were returned for the required historical scan address.`);
  }
  if (rows.length) {
    const sample = rows[0];
    if (!sample.signature || typeof sample.slot !== "number") {
      throw new Error(`${label}: sample is missing transaction signature or slot.`);
    }
    if (enhanced && (!sample.transaction || !sample.meta)) {
      const hydrated = await rpc(keys[0], "getTransaction", [
        sample.signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }
      ]);
      if (!hydrated || !hydrated.meta) {
        throw new Error(`${label}: sample transaction could not be hydrated with metadata.`);
      }
      console.log(`${label}: transaction hydration fallback verified.`);
    } else if (enhanced) {
      console.log(`${label}: full transaction and metadata included in history response.`);
    }
  }
}

await checkHistory("Pump.fun mint-authority index", PUMP_MINT_AUTHORITY, true);
await checkHistory("Raydium LaunchLab program index", LAUNCHLAB, false);
console.log("Helius preflight passed. No historical coin scan or dataset write was performed.");
