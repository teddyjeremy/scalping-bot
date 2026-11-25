export type InitialScreenStatus = "eligible" | "rejected" | "unverified";
export type InitialScreenEvidence = {
  mintAuthorityRevoked?: boolean;
  tokenExtensionsAssessed?: boolean;
  tokenExtensionsSafe?: boolean;
  pumpCurveVerifiedActive?: boolean;
  pumpRealQuoteReservesPositive?: boolean;
  migratedPoolVerified?: boolean;
  migratedPoolLockPercent?: number;
};
export type InitialScreenDecision = {
  schemaVersion: 1;
  ruleVersion: "initial-security-gate-v1";
  status: InitialScreenStatus;
  evaluatedAt: string;
  reasons: string[];
  evidence: InitialScreenEvidence;
  limitations: string[];
};
export type EarlyTradeObservation = {
  secondsSinceLaunch: number;
  side: "buy" | "sell";
  user: string;
  quoteAmount: number;
};
export function evaluateInitialScreen(evidence: InitialScreenEvidence, evaluatedAt = new Date().toISOString()): InitialScreenDecision {
  const reasons: string[] = [];
  let rejected = false;
  if (evidence.mintAuthorityRevoked === false) { reasons.push("mint_authority_not_revoked"); rejected = true; }
  else if (evidence.mintAuthorityRevoked !== true) reasons.push("historical_mint_authority_state_unverified");
  if (evidence.tokenExtensionsAssessed !== true) reasons.push("token_2022_extensions_not_assessed");
  else if (evidence.tokenExtensionsSafe !== true) {
    reasons.push(evidence.tokenExtensionsSafe === false ? "token_extensions_failed_safety_policy" : "token_extension_safety_result_missing");
    if (evidence.tokenExtensionsSafe === false) rejected = true;
  }
  const pumpVerified = evidence.pumpCurveVerifiedActive === true && evidence.pumpRealQuoteReservesPositive === true;
  const migratedVerified = evidence.migratedPoolVerified === true && typeof evidence.migratedPoolLockPercent === "number" && evidence.migratedPoolLockPercent >= 90;
  if (!pumpVerified && !migratedVerified) {
    if (evidence.pumpCurveVerifiedActive === false || evidence.pumpRealQuoteReservesPositive === false || evidence.migratedPoolVerified === false ||
      (typeof evidence.migratedPoolLockPercent === "number" && evidence.migratedPoolLockPercent < 90)) {
      reasons.push("venue_liquidity_evidence_failed_policy"); rejected = true;
    } else reasons.push("historical_curve_or_locked_pool_liquidity_unverified");
  }
  return {
    schemaVersion: 1, ruleVersion: "initial-security-gate-v1",
    status: rejected ? "rejected" : reasons.length ? "unverified" : "eligible",
    evaluatedAt, reasons, evidence,
    limitations: [
      "Security evidence is historical and must be proven at the decision timestamp.",
      "Behavioural thresholds are provisional research filters, not proven profitable rules.",
      "No 30-minute price or outcome reconstruction is required.",
      "Missing critical security evidence remains unverified and cannot pass."
    ]
  };
}
export function evaluateBehaviouralWindows(events: EarlyTradeObservation[]) {
  const horizons = [30, 60, 120, 180, 300] as const;
  return horizons.map(seconds => {
    const rows = events.filter(e => Number.isFinite(e.secondsSinceLaunch) && e.secondsSinceLaunch >= 0 && e.secondsSinceLaunch <= seconds && e.user && Number.isFinite(e.quoteAmount) && e.quoteAmount > 0);
    const buys = rows.filter(e => e.side === "buy");
    const sells = rows.filter(e => e.side === "sell");
    const buyQuote = buys.reduce((sum, e) => sum + e.quoteAmount, 0);
    const sellQuote = sells.reduce((sum, e) => sum + e.quoteAmount, 0);
    const buyerTotals = new Map<string, number>();
    for (const e of buys) buyerTotals.set(e.user, (buyerTotals.get(e.user) ?? 0) + e.quoteAmount);
    const distinctBuyers = buyerTotals.size;
    const topFiveQuote = [...buyerTotals.values()].sort((a,b) => b-a).slice(0,5).reduce((a,b)=>a+b,0);
    const topFiveConcentration = buyQuote > 0 ? topFiveQuote / buyQuote : null;
    const reasons: string[] = [];
    if (buys.length < 5) reasons.push("fewer_than_5_successful_buy_events");
    if (distinctBuyers < 4) reasons.push("fewer_than_4_distinct_buyers");
    if (sellQuote > 0 && buyQuote / sellQuote < 1.5) reasons.push("buy_to_sell_quote_volume_below_1_5");
    if (sellQuote === 0 && buys.length === 0) reasons.push("no_observed_quote_flow");
    if (topFiveConcentration != null && topFiveConcentration > 0.8) reasons.push("top_5_buyers_exceed_80_percent_of_buy_volume");
    const enoughEvidence = buys.length >= 5 && distinctBuyers >= 4 && buyQuote > 0;
    const failed = (sellQuote > 0 && buyQuote / sellQuote < 1.5) || (topFiveConcentration != null && topFiveConcentration > 0.8);
    return {
      secondsAfterLaunch: seconds,
      status: failed ? "rejected" : enoughEvidence && reasons.length === 0 ? "behavioural_pass" : "unverified",
      metrics: { successfulBuyEvents: buys.length, successfulSellEvents: sells.length, distinctBuyers, buyQuoteVolume: buyQuote, sellQuoteVolume: sellQuote, buyToSellQuoteRatio: sellQuote > 0 ? buyQuote/sellQuote : null, topFiveBuyerQuoteConcentration: topFiveConcentration },
      reasons
    };
  });
}
