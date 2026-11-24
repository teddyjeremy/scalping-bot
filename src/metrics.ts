import type { ParsedTransactionWithMeta } from "@solana/web3.js";

type TokenBalance = NonNullable<NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]>[number];
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

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
  quoteMint: string;
  quoteAmount: number;
  priceQuote: number;
  solAmount: number;
  priceSol: number | null;
  priceUsd: number | null;
  feeLamports: number;
  pricingMethod: "owner_balance_delta_estimate" | "decoded_program_trade_event";
  confidence: "low" | "high";
  eventName?: string;
  protocolFeeQuote?: number | null;
  platformFeeQuote?: number | null;
  shareFeeQuote?: number | null;
  lpFeeQuote?: number | null;
  creatorFeeQuote?: number | null;
  cashbackFeeQuote?: number | null;
  buybackFeeQuote?: number | null;
  venueTradeFeeQuote?: number | null;
  inputTransferFeeQuote?: number | null;
  outputTransferFeeQuote?: number | null;
  venueTradeFeeMint?: string | null;
  protocolFeeBps?: number | null;
  lpFeeBps?: number | null;
  creatorFeeBps?: number | null;
  tradeFeeBase?: number | null;
  creatorFeeBase?: number | null;
  tradeFeeMint?: string | null;
  creatorFeeMint?: string | null;
  inputTransferFeeRaw?: string | null;
  outputTransferFeeRaw?: string | null;
};

/**
 * Estimates a wallet's quote-asset spend/receipt by pairing its base-token delta
 * with its quote-token delta (or native SOL delta for SOL curves). This is only
 * supporting evidence: routed swaps, fees, rent, account creation and unrelated
 * transfers can distort per-owner deltas. Never use as an execution quote.
 */
export function deriveTradeObservations(
  tx: ParsedTransactionWithMeta,
  mint: string,
  solUsd: number | null,
  quoteMint = SOL_MINT
): TradeObservation[] {
  if (!tx.meta || tx.meta.err) return [];
  const preBase = new Map<string, TokenBalance>();
  const postBase = new Map<string, TokenBalance>();
  const preQuote = new Map<string, TokenBalance>();
  const postQuote = new Map<string, TokenBalance>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (!b.owner) continue;
    if (b.mint === mint) preBase.set(b.owner, b);
    if (b.mint === quoteMint) preQuote.set(b.owner, b);
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (!b.owner) continue;
    if (b.mint === mint) postBase.set(b.owner, b);
    if (b.mint === quoteMint) postQuote.set(b.owner, b);
  }

  const owners = new Set([...preBase.keys(), ...postBase.keys()]);
  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === "string" ? k : String(k.pubkey)
  );
  // Pool/vault PDAs also change both token balances; count only wallet owners that signed this transaction.
  // This avoids counting the pool's opposite-side reserve movement as a second trade.
  const signers = new Set(tx.transaction.message.accountKeys.flatMap(k =>
    typeof k === "string" ? [] : (k.signer ? [String(k.pubkey)] : [])
  ));
  const feePayer = accountKeys[0];
  const feeLamports = tx.meta.fee ?? 0;
  const out: TradeObservation[] = [];

  for (const wallet of owners) {
    if (!signers.has(wallet)) continue;
    const tokenDelta = uiAmount(postBase.get(wallet)) - uiAmount(preBase.get(wallet));
    if (!Number.isFinite(tokenDelta) || Math.abs(tokenDelta) < 1e-12) continue;
    let quoteDelta: number;
    if (quoteMint === SOL_MINT) {
      const accountIndex = accountKeys.indexOf(wallet);
      if (accountIndex < 0) continue;
      const before = tx.meta.preBalances?.[accountIndex];
      const after = tx.meta.postBalances?.[accountIndex];
      if (before == null || after == null) continue;
      quoteDelta = (after - before) / 1e9;
      if (wallet === feePayer) quoteDelta += feeLamports / 1e9;
    } else {
      quoteDelta = uiAmount(postQuote.get(wallet)) - uiAmount(preQuote.get(wallet));
    }
    if (!Number.isFinite(quoteDelta) || Math.abs(quoteDelta) < 1e-12) continue;
    if (Math.sign(tokenDelta) === Math.sign(quoteDelta)) continue;

    const tokenAmount = Math.abs(tokenDelta);
    const quoteAmount = Math.abs(quoteDelta);
    const priceQuote = quoteAmount / tokenAmount;
    if (!Number.isFinite(priceQuote) || priceQuote <= 0) continue;
    const isSol = quoteMint === SOL_MINT;
    const isStable = quoteMint === USDC_MINT || quoteMint === USDT_MINT;
    out.push({
      wallet,
      side: tokenDelta > 0 ? "buy" : "sell",
      tokenAmount,
      quoteMint,
      quoteAmount,
      priceQuote,
      solAmount: isSol ? quoteAmount : 0,
      priceSol: isSol ? priceQuote : null,
      priceUsd: isSol ? (solUsd == null ? null : priceQuote * solUsd) : (isStable ? priceQuote : null),
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
