import type { ParsedTransactionWithMeta } from "@solana/web3.js";

type TokenBalance = NonNullable<NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]>[number];

function uiAmount(balance: TokenBalance | undefined): number {
  if (!balance) return 0;
  const raw = balance.uiTokenAmount.uiAmountString;
  if (raw != null) return Number(raw);
  return balance.uiTokenAmount.uiAmount ?? 0;
}

export type TradeObservation = {
  wallet: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  priceUsd: number | null;
  feeLamports: number;
  pricingMethod: "owner_balance_delta_estimate";
  confidence: "low" | "medium";
};

/**
 * Estimates executed price by matching each token owner's token delta with
 * that owner's native SOL balance delta. Rent, unrelated transfers, wrapped
 * SOL routing and multi-leg swaps can distort this estimate; consumers must
 * retain the method/confidence labels and prefer venue-specific decoders.
 */
export function deriveTradeObservations(
  tx: ParsedTransactionWithMeta,
  mint: string,
  solUsd: number | null
): TradeObservation[] {
  if (!tx.meta || tx.meta.err) return [];
  const pre = new Map<string, TokenBalance>();
  const post = new Map<string, TokenBalance>();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint && b.owner) pre.set(b.owner, b);
  for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === mint && b.owner) post.set(b.owner, b);

  const owners = new Set([...pre.keys(), ...post.keys()]);
  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === "string" ? k : String(k.pubkey)
  );
  const feePayer = accountKeys[0];
  const feeLamports = tx.meta.fee ?? 0;
  const out: TradeObservation[] = [];

  for (const wallet of owners) {
    const tokenDelta = uiAmount(post.get(wallet)) - uiAmount(pre.get(wallet));
    if (!Number.isFinite(tokenDelta) || Math.abs(tokenDelta) < 1e-12) continue;
    const accountIndex = accountKeys.indexOf(wallet);
    if (accountIndex < 0) continue;
    const beforeLamports = tx.meta.preBalances?.[accountIndex];
    const afterLamports = tx.meta.postBalances?.[accountIndex];
    if (beforeLamports == null || afterLamports == null) continue;
    let solDelta = (afterLamports - beforeLamports) / 1e9;
    if (wallet === feePayer) solDelta += feeLamports / 1e9;
    if (!Number.isFinite(solDelta) || Math.abs(solDelta) < 1e-9) continue;
    if (Math.sign(tokenDelta) === Math.sign(solDelta)) continue;

    const tokenAmount = Math.abs(tokenDelta);
    const solAmount = Math.abs(solDelta);
    const priceSol = solAmount / tokenAmount;
    if (!Number.isFinite(priceSol) || priceSol <= 0) continue;
    out.push({
      wallet,
      side: tokenDelta > 0 ? "buy" : "sell",
      tokenAmount,
      solAmount,
      priceSol,
      priceUsd: solUsd == null ? null : priceSol * solUsd,
      feeLamports,
      pricingMethod: "owner_balance_delta_estimate",
      confidence: "low"
    });
  }
  return out;
}

export function marketCap(price: number | null, supply: number | null): number | null {
  if (price == null || supply == null || !Number.isFinite(price) || !Number.isFinite(supply) || price <= 0 || supply <= 0) return null;
  return price * supply;
}
