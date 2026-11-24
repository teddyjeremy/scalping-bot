import { Connection, PublicKey } from "@solana/web3.js";

const keys = [process.env.HELIUS_API_KEY_1, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3];
const hfToken = process.env.HF_TOKEN;
const dataset = process.env.HF_DATASET_REPO ?? "ndeda/solana-scalping-data";
if (keys.some(key => !key)) throw new Error("All three Helius API keys must be configured.");
if (new Set(keys).size !== 3) throw new Error("The three Helius secrets must contain three distinct API keys.");
if (!hfToken) throw new Error("HF_TOKEN is missing.");

const connections = keys.map(key => new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed"));
const rpcResults = await Promise.all(connections.map(async (connection, index) => {
  const [version, slot, genesisHash] = await Promise.all([
    connection.getVersion(), connection.getSlot("confirmed"), connection.getGenesisHash()
  ]);
  if (!version["solana-core"] || !Number.isSafeInteger(slot) || slot <= 0) throw new Error(`Helius key ${index + 1} failed version/slot validation.`);
  return { keyIndex: index + 1, health: "ok", coreVersion: version["solana-core"], slot, genesisHash };
}));
if (new Set(rpcResults.map(result => result.genesisHash)).size !== 1) throw new Error("Configured Helius keys are not connected to the same Solana cluster.");

const programs = [
  ["Pump.fun", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
  ["PumpSwap", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
  ["Raydium LaunchLab", "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"],
  ["Raydium CPMM", "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"],
  ["Raydium LP Lock", "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE"]
] as const;
const programResults = await Promise.all(programs.map(async ([name, address]) => {
  const info = await connections[0].getAccountInfo(new PublicKey(address), "confirmed");
  if (!info?.executable) throw new Error(`${name} program account is missing or not executable.`);
  return { name, executable: info.executable, owner: info.owner.toBase58() };
}));

const enhancedHistoryResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${keys[0]}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: "preflight-history", method: "getTransactionsForAddress",
    params: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", {
      transactionDetails: "signatures", sortOrder: "desc", limit: 1, commitment: "confirmed",
      filters: { blockTime: { gte: Math.floor(Date.now() / 1000) - 86_400 }, status: "any" }
    }]
  }),
  signal: AbortSignal.timeout(20_000)
});
const enhancedHistoryBody = await enhancedHistoryResponse.json() as { result?: { data?: unknown[] }; error?: { code?: number; message?: string } };
const enhancedHistory = enhancedHistoryResponse.ok && !enhancedHistoryBody.error && Array.isArray(enhancedHistoryBody.result?.data)
  ? { available: true, sampleCount: enhancedHistoryBody.result.data.length }
  : { available: false, reason: enhancedHistoryBody.error?.message ?? `HTTP ${enhancedHistoryResponse.status}`, fallback: "standard Solana RPC history" };

const pumpMintAuthority = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0].toBase58();
const pumpCreateIndexResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${keys[0]}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: "preflight-pump-create-index", method: "getTransactionsForAddress",
    params: [pumpMintAuthority, {
      transactionDetails: "signatures", sortOrder: "asc", limit: 1, commitment: "confirmed",
      filters: { blockTime: { gte: 1793491200, lte: 1795478400 }, status: "any" }
    }]
  }),
  signal: AbortSignal.timeout(20_000)
});
const pumpCreateIndexBody = await pumpCreateIndexResponse.json() as { result?: { data?: unknown[] }; error?: { code?: number; message?: string } };
const pumpCreateIndex = pumpCreateIndexResponse.ok && !pumpCreateIndexBody.error && Array.isArray(pumpCreateIndexBody.result?.data) && pumpCreateIndexBody.result.data.length > 0
  ? { available: true, sampleCount: pumpCreateIndexBody.result.data.length }
  : { available: false, reason: pumpCreateIndexBody.error?.message ?? `HTTP ${pumpCreateIndexResponse.status}`, fallbackRequired: true };

const response = await fetch(`https://huggingface.co/api/datasets/${dataset}`, {
  headers: { Authorization: `Bearer ${hfToken}` },
  signal: AbortSignal.timeout(20_000)
});
if (!response.ok) throw new Error(`Hugging Face dataset read check failed: HTTP ${response.status}`);
const datasetInfo = await response.json() as { id?: string; private?: boolean };
console.log(JSON.stringify({
  status: "preflight_passed",
  collectionStarted: false,
  heliusConnections: rpcResults.map(({ keyIndex, health, slot }) => ({ keyIndex, health, slot })),
  programAccounts: programResults,
  enhancedHistoricalRpc: enhancedHistory,
  pumpCreateOnlyMintAuthorityIndex: pumpCreateIndex,
  huggingFace: { dataset: datasetInfo.id ?? dataset, readable: true, writePermissionTested: false },
  note: "All three RPC keys were tested concurrently. Enhanced historical RPC is optional; the archive falls back to standard RPC if unavailable. This validates connectivity, not independent quota allocation or write permissions."
}, null, 2));
