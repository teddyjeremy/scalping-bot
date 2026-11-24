export type RecentTradeSignal = { at: number; side: "buy" | "sell"; quoteAmount: number; wallet: string; isCreator?: boolean; botScore?: number; sniperCandidate?: boolean; bundleCandidate?: boolean; confidence: "high" | "low"; priceUsd?: number | null };
export type PaperPosition = {
  status: "open" | "closed";
  entryAt: number;
  entryPrice: number;
  quantity: number;
  peakPrice: number;
  lastPrice: number;
  estimatedEntryCostQuote: number;
  estimatedEntryFeeQuote?: number | null;
  estimatedExitFeeQuote?: number | null;
  netRealizedPnlQuote?: number | null;
  estimatedExitValueQuote?: number;
  exitAt?: number;
  exitReason?: string;
  realizedPnlQuote?: number;
  entryScore: number;
};
export type StrategyInput = {
  now: number;
  launchAt: number;
  price: number | null;
  fdvUsd: number | null;
  quoteLiquidity: number | null;
  recentTrades: RecentTradeSignal[];
  creatorSelling: boolean;
  reserveDropPct: number | null;
  priceImpactPctForOneDollar: number | null;
  securityPassed: boolean;
  fdvMinUsd?: number;
  fdvMaxUsd?: number;
  entryStartSeconds?: number;
  entryEndSeconds?: number;
  paperSizeUsd?: number;
  volatilityPct?: number;
  venueFeePctPerSide?: number | null;
};
export type StrategyDecision = {
  action: "wait" | "enter" | "hold" | "exit" | "reject";
  score: number;
  reasons: string[];
  dangerSignals: string[];
  position?: PaperPosition;
};

export function evaluateScalpDecision(input: StrategyInput, position?: PaperPosition | null): StrategyDecision {
  const age = (input.now - input.launchAt) / 1000;
  const trades = input.recentTrades.filter(t => input.now - t.at <= 20_000);
  const buys = trades.filter(t => t.side === "buy");
  const sells = trades.filter(t => t.side === "sell");
  const buyVolume = buys.reduce((sum, t) => sum + t.quoteAmount, 0);
  const sellVolume = sells.reduce((sum, t) => sum + t.quoteAmount, 0);
  const uniqueBuyers = new Set(buys.map(t => t.wallet)).size;
  const flaggedBuys = buys.filter(t => (t.botScore ?? 0) >= 50 || t.sniperCandidate === true || t.bundleCandidate === true).length;
  const flaggedBuyRatio = buys.length ? flaggedBuys / buys.length : 0;
  const flaggedSells = sells.filter(t => (t.botScore ?? 0) >= 50 || t.sniperCandidate === true || t.bundleCandidate === true).length;
  const flaggedSellRatio = sells.length ? flaggedSells / sells.length : 0;
  const sellBuyRatio = buyVolume > 0 ? sellVolume / buyVolume : sells.length ? Infinity : 0;
  const scoreParts = {
    buyPressure: buyVolume > 0 && sellBuyRatio < 0.65 ? 25 : buyVolume > sellVolume ? 15 : 0,
    buyerBreadth: uniqueBuyers >= 5 ? 20 : uniqueBuyers >= 3 ? 12 : uniqueBuyers >= 2 ? 6 : 0,
    tradeActivity: trades.length >= 12 ? 15 : trades.length >= 6 ? 10 : trades.length >= 3 ? 5 : 0,
    confidence: trades.filter(t => t.confidence === "high").length >= 3 ? 10 : 0,
    liquidity: input.quoteLiquidity != null && input.quoteLiquidity > 0 ? 10 : 0
  };
  const score = Object.values(scoreParts).reduce((sum, n) => sum + n, 0);
  const dangerSignals: string[] = [];
  if (input.creatorSelling) dangerSignals.push("creator_or_creator_fee_payer_selling");
  if (input.reserveDropPct != null && input.reserveDropPct <= -20) dangerSignals.push("curve_or_pool_quote_reserves_dropped_20_percent");
  if (input.priceImpactPctForOneDollar != null && input.priceImpactPctForOneDollar >= 5) dangerSignals.push("one_dollar_curve_price_impact_at_least_5_percent");\n  if (flaggedBuyRatio >= 0.6 && buys.length >= 3) dangerSignals.push("bot_sniper_or_bundle_candidates_dominate_early_buys");\n  if (flaggedSellRatio >= 0.5 && sells.length >= 2) dangerSignals.push("coordinated_bot_sniper_or_bundle_sell_pressure");
  if (position?.status === "open") {
    if (input.price == null || input.price <= 0) return { action: "hold", score, reasons: ["price_feed_missing_or_invalid_hold_last_known_mark"], dangerSignals: [...dangerSignals, "price_feed_missing_or_invalid"], position };
    const drawdown = position.peakPrice > 0 ? (input.price / position.peakPrice - 1) * 100 : 0;
    if (Number.isFinite(drawdown) && drawdown <= -15) dangerSignals.push("15_percent_drawdown_from_trade_peak");
    if (sellBuyRatio >= 1.5 && sells.length >= 3) dangerSignals.push("sell_volume_1_5x_buy_volume");
    if (input.price == null || input.price <= 0) dangerSignals.push("price_feed_missing_or_invalid");
    if (dangerSignals.length) {
      const reason = dangerSignals[0];
      const exitValue = position.quantity * input.price;
      const exitFee = input.venueFeePctPerSide == null ? null : exitValue * input.venueFeePctPerSide / 100;
      const entryFee = position.estimatedEntryFeeQuote ?? null;
      const netPnl = exitFee == null || entryFee == null ? null : exitValue - exitFee - position.estimatedEntryCostQuote - entryFee;
      const closed: PaperPosition = {
        ...position, status: "closed", lastPrice: input.price,
        peakPrice: Math.max(position.peakPrice, input.price), exitAt: input.now,
        exitReason: reason, estimatedExitValueQuote: exitValue, estimatedExitFeeQuote: exitFee,
        realizedPnlQuote: exitValue - position.estimatedEntryCostQuote, netRealizedPnlQuote: netPnl
      };
      return { action: "exit", score, reasons: [reason], dangerSignals, position: closed };
    }
    if (input.price != null && input.price > 0) {
      const peak = Math.max(position.peakPrice, input.price);
      const trailingDrawdown = peak > 0 ? (input.price / peak - 1) * 100 : 0;
      const trailingStopPct = Math.min(15, Math.max(6, 8 + (input.volatilityPct ?? 1) * 1.5));
      if (trailingDrawdown <= -trailingStopPct) {
        const exitValue = position.quantity * input.price;
        const exitFee = input.venueFeePctPerSide == null ? null : exitValue * input.venueFeePctPerSide / 100;
        const entryFee = position.estimatedEntryFeeQuote ?? null;
        const netPnl = exitFee == null || entryFee == null ? null : exitValue - exitFee - position.estimatedEntryCostQuote - entryFee;
        const closed: PaperPosition = { ...position, status: "closed", peakPrice: peak, lastPrice: input.price, exitAt: input.now, exitReason: "adaptive_volatility_adjusted_trailing_drawdown", estimatedExitValueQuote: exitValue, estimatedExitFeeQuote: exitFee, realizedPnlQuote: exitValue - position.estimatedEntryCostQuote, netRealizedPnlQuote: netPnl };
        return { action: "exit", score, reasons: ["adaptive_volatility_adjusted_trailing_drawdown"], dangerSignals, position: closed };
      }
      return { action: "hold", score, reasons: ["position_open_no_emergency_exit_signal"], dangerSignals, position: { ...position, peakPrice: peak, lastPrice: input.price } };
    }
    return { action: "hold", score, reasons: ["position_open_price_unavailable_hold_for_recovery"], dangerSignals };
  }
  if (position?.status === "closed") return { action: "reject", score, reasons: ["one_position_per_mint_no_reentry"], dangerSignals };
  if (!input.securityPassed) return { action: "reject", score, reasons: ["security_gate_failed"], dangerSignals };
  if (age < (input.entryStartSeconds ?? 30)) return { action: "wait", score, reasons: ["observe_first_30_seconds"], dangerSignals };
  if (age > (input.entryEndSeconds ?? 300)) return { action: "reject", score, reasons: ["entry_window_expired_after_5_minutes"], dangerSignals };
  const minFdv = input.fdvMinUsd ?? 5_000;
  const maxFdv = input.fdvMaxUsd ?? 10_000;
  if (input.fdvUsd == null || input.fdvUsd < minFdv || input.fdvUsd > maxFdv) return { action: "reject", score, reasons: ["fdv_outside_target_range_or_unavailable"], dangerSignals };
  if (dangerSignals.length) return { action: "reject", score, reasons: ["danger_signals_present"], dangerSignals };
  if (score < 60 || input.price == null || input.price <= 0 || !trades.length) return { action: "wait", score, reasons: ["entry_score_or_confirming_activity_insufficient"], dangerSignals };
  const paperSizeQuote = input.paperSizeUsd ?? 1;
  const quantity = paperSizeQuote / input.price;
  const opened: PaperPosition = {
    status: "open", entryAt: input.now, entryPrice: input.price, quantity,
    peakPrice: input.price, lastPrice: input.price, estimatedEntryCostQuote: paperSizeQuote,
    estimatedEntryFeeQuote: input.venueFeePctPerSide == null ? null : paperSizeQuote * input.venueFeePctPerSide / 100,
    entryScore: score
  };
  return { action: "enter", score, reasons: ["security_passed_and_early_momentum_score_60_plus"], dangerSignals, position: opened };
}
