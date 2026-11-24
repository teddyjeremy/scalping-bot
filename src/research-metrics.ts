export type PricePoint = { at: number; price: number; source?: string };
export type TradePoint = {
  at: number;
  slot?: number;
  wallet?: string;
  side: "buy" | "sell";
  quoteAmount: number;
};
export type HolderPoint = { owner?: string; amount: number };

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function calculatePricePathMetrics(points: PricePoint[]) {
  const series = points.filter(p => Number.isFinite(p.at) && finitePositive(p.price)).sort((a, b) => a.at - b.at);
  if (!series.length) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  let high = first, low = first, maxDrawdownPct = 0, maxFavorablePct = 0, maxAdversePct = 0;
  let peak = first.price;
  const targetHitTimesSeconds: Record<string, number | null> = { "1.2x": null, "1.5x": null, "1.7x": null, "2x": null, "3x": null };
  const drawdownHitTimesSeconds: Record<string, number | null> = { "10%": null, "20%": null, "30%": null, "50%": null, "80%": null };
  const logReturns: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const point = series[i]!;
    if (point.price > high.price) high = point;
    if (point.price < low.price) low = point;
    peak = Math.max(peak, point.price);
    maxDrawdownPct = Math.min(maxDrawdownPct, (point.price / peak - 1) * 100);
    maxFavorablePct = Math.max(maxFavorablePct, (point.price / first.price - 1) * 100);
    maxAdversePct = Math.min(maxAdversePct, (point.price / first.price - 1) * 100);
    const elapsed = (point.at - first.at) / 1000;
    const multiple = point.price / first.price;
    for (const [label, threshold] of [["1.2x", 1.2], ["1.5x", 1.5], ["1.7x", 1.7], ["2x", 2], ["3x", 3]] as const) {
      if (multiple >= threshold && targetHitTimesSeconds[label] == null) targetHitTimesSeconds[label] = elapsed;
    }
    const drawdownFromPeak = (point.price / peak - 1) * 100;
    for (const [label, threshold] of [["10%", -10], ["20%", -20], ["30%", -30], ["50%", -50], ["80%", -80]] as const) {
      if (drawdownFromPeak <= threshold && drawdownHitTimesSeconds[label] == null) drawdownHitTimesSeconds[label] = elapsed;
    }
    if (i > 0) {
      const previous = series[i - 1]!;
      if (point.price > 0 && previous.price > 0) logReturns.push(Math.log(point.price / previous.price));
    }
  }
  const mean = logReturns.length ? logReturns.reduce((a, b) => a + b, 0) / logReturns.length : 0;
  const variance = logReturns.length > 1
    ? logReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logReturns.length - 1)
    : null;
  const horizons = [5, 15, 30, 60, 180, 300, 600];
  const returnsBySeconds: Record<string, number | null> = {};
  for (const seconds of horizons) {
    const targetAt = last.at - seconds * 1000;
    let baseline: PricePoint | undefined;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i]!.at <= targetAt) { baseline = series[i]; break; }
    }
    returnsBySeconds[`${seconds}s`] = baseline ? (last.price / baseline.price - 1) * 100 : null;
  }
  return {
    sampleCount: series.length,
    firstObservedAt: first.at,
    lastObservedAt: last.at,
    firstObservedPrice: first.price,
    lastObservedPrice: last.price,
    totalReturnPct: (last.price / first.price - 1) * 100,
    returnsBySeconds,
    highPrice: high.price,
    highPriceAt: high.at,
    lowPrice: low.price,
    lowPriceAt: low.at,
    timeToHighSeconds: (high.at - first.at) / 1000,
    timeToLowSeconds: (low.at - first.at) / 1000,
    maxDrawdownPct,
    maxFavorableExcursionPct: maxFavorablePct,
    maxAdverseExcursionPct: maxAdversePct,
    targetHitTimesSeconds,
    drawdownHitTimesSeconds,
    realizedVolatilityPctPerObservation: variance == null ? null : Math.sqrt(variance) * 100,
    largestSingleStepUpPct: logReturns.length ? Math.max(...logReturns.map(value => (Math.exp(value) - 1) * 100)) : null,
    largestSingleStepDownPct: logReturns.length ? Math.min(...logReturns.map(value => (Math.exp(value) - 1) * 100)) : null,
    priceSeriesIsSparseOrIrregular: series.length < 2 || series.some((point, i) => i > 0 && point.at - series[i - 1]!.at > 15_000)
  };
}

export function calculateTradeFlowMetrics(points: TradePoint[], asOf: number) {
  const valid = points.filter(p => Number.isFinite(p.at) && finitePositive(p.quoteAmount) && (p.side === "buy" || p.side === "sell"));
  const windows = [5, 15, 60, 300];
  const byWindow: Record<string, unknown> = {};
  for (const seconds of windows) {
    const selected = valid.filter(p => p.at >= asOf - seconds * 1000 && p.at <= asOf);
    const buys = selected.filter(p => p.side === "buy");
    const sells = selected.filter(p => p.side === "sell");
    const buyQuote = buys.reduce((sum, p) => sum + p.quoteAmount, 0);
    const sellQuote = sells.reduce((sum, p) => sum + p.quoteAmount, 0);
    const total = buyQuote + sellQuote;
    const walletVolumes = new Map<string, number>();
    for (const trade of selected) if (trade.wallet) walletVolumes.set(trade.wallet, (walletVolumes.get(trade.wallet) ?? 0) + trade.quoteAmount);
    const sortedWalletVolumes = [...walletVolumes.values()].sort((a, b) => b - a);
    byWindow[`${seconds}s`] = {
      tradeCount: selected.length,
      buyCount: buys.length,
      sellCount: sells.length,
      buyVolumeQuote: buyQuote,
      sellVolumeQuote: sellQuote,
      netFlowQuote: buyQuote - sellQuote,
      buySellVolumeRatio: sellQuote > 0 ? buyQuote / sellQuote : null,
      buyVolumeSharePct: total > 0 ? buyQuote / total * 100 : null,
      uniqueWallets: walletVolumes.size,
      top1WalletVolumeSharePct: total > 0 && sortedWalletVolumes.length ? sortedWalletVolumes[0]! / total * 100 : null,
      top5WalletVolumeSharePct: total > 0 ? sortedWalletVolumes.slice(0, 5).reduce((a, b) => a + b, 0) / total * 100 : null,
      largestTradeQuote: selected.length ? Math.max(...selected.map(p => p.quoteAmount)) : null,
      medianTradeQuote: percentile(selected.map(p => p.quoteAmount), 0.5),
      tradesPerSecond: selected.length / seconds,
      sameSlotTradeCount: (() => {
        const slots = new Map<number, number>();
        for (const trade of selected) if (trade.slot != null) slots.set(trade.slot, (slots.get(trade.slot) ?? 0) + 1);
        return [...slots.values()].filter(count => count > 1).reduce((sum, count) => sum + count, 0);
      })()
    };
  }
  const ordered = [...valid].sort((a, b) => a.at - b.at);
  const gaps = ordered.slice(1).map((p, i) => Math.max(0, p.at - ordered[i]!.at) / 1000);
  return {
    totalTradeObservations: valid.length,
    firstTradeAt: ordered[0]?.at ?? null,
    lastTradeAt: ordered[ordered.length - 1]?.at ?? null,
    medianInterTradeSeconds: percentile(gaps, 0.5),
    p90InterTradeSeconds: percentile(gaps, 0.9),
    windows: byWindow,
    walletVolumeConcentrationIsObservedTradesOnly: true
  };
}

export function calculateHolderConcentration(holders: HolderPoint[]) {
  const amounts = holders.map(holder => holder.amount).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return { holderCount: 0, totalObservedAmount: 0, hhi: null, effectiveHolderCount: null, gini: null, top1SharePct: null, top5SharePct: null, top10SharePct: null };
  const shares = amounts.map(amount => amount / total);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const ascending = [...amounts].sort((a, b) => a - b);
  const n = ascending.length;
  const weighted = ascending.reduce((sum, amount, index) => sum + (index + 1) * amount, 0);
  const gini = n > 1 ? (2 * weighted) / (n * total) - (n + 1) / n : 0;
  return {
    holderCount: n,
    totalObservedAmount: total,
    hhi,
    effectiveHolderCount: 1 / hhi,
    gini,
    top1SharePct: shares[0]! * 100,
    top5SharePct: shares.slice(0, 5).reduce((a, b) => a + b, 0) * 100,
    top10SharePct: shares.slice(0, 10).reduce((a, b) => a + b, 0) * 100,
    scope: "provided_holder_sample_only"
  };
}

/**
 * Constant-product reserve estimate for research only. It is not a router quote,
 * transaction simulation, or guaranteed executable fill.
 */
export function estimateConstantProductSwap(input: {
  baseReserve: number;
  quoteReserve: number;
  amountIn: number;
  side: "buy" | "sell";
  feeBps?: number;
}) {
  const { baseReserve, quoteReserve, amountIn, side } = input;
  const feeBps = input.feeBps ?? 0;
  if (![baseReserve, quoteReserve, amountIn, feeBps].every(Number.isFinite) ||
      baseReserve <= 0 || quoteReserve <= 0 || amountIn <= 0 || feeBps < 0 || feeBps >= 10_000) return null;
  const fee = amountIn * feeBps / 10_000;
  const netIn = amountIn - fee;
  const midPrice = quoteReserve / baseReserve;
  const output = side === "buy"
    ? baseReserve * netIn / (quoteReserve + netIn)
    : quoteReserve * netIn / (baseReserve + netIn);
  const effectivePrice = side === "buy" ? amountIn / output : output / amountIn;
  const priceImpactPct = side === "buy"
    ? (effectivePrice / midPrice - 1) * 100
    : (1 - effectivePrice / midPrice) * 100;
  return {
    amountIn,
    feeAmountInAsset: fee,
    amountOut: output,
    midPriceQuotePerBase: midPrice,
    effectivePriceQuotePerBase: effectivePrice,
    priceImpactPct,
    feeBps,
    method: "constant_product_reserve_approximation_not_executable_quote",
    excludesRouteFeesPriorityFeesRentTipsAndStateChanges: true
  };
}

export function reconstructTokenResearch(events: Array<Record<string, unknown>>) {
  const prices: PricePoint[] = [];
  const trades: TradePoint[] = [];
  const holderEvents: Array<Record<string, unknown>> = [];
  const fees = { networkFeeLamports: 0, transactionCount: 0, failedTransactionCount: 0, computeUnitsConsumed: 0 };
  const launch = events.find(event => event.kind === "launch_detected");
  for (const event of events) {
    const observedAt = typeof event.observedAt === "number" ? event.observedAt : null;
    if (event.kind === "curve_state" && observedAt != null && typeof event.priceQuote === "number") {
      prices.push({ at: observedAt, price: event.priceQuote, source: typeof event.pricingMethod === "string" ? event.pricingMethod : "curve_state_unknown_source" });
    }
    if (event.kind === "market_snapshot" && observedAt != null && typeof event.priceQuote === "number") {
      prices.push({ at: observedAt, price: event.priceQuote, source: typeof event.pricingMethod === "string" ? event.pricingMethod : "market_snapshot_unknown_source" });
    }
    if (event.kind === "trade_metric") {
      const at = typeof event.blockTime === "number" ? event.blockTime * 1000 : observedAt;
      const observations = Array.isArray(event.observations) ? event.observations as Array<Record<string, unknown>> : [];
      for (const trade of observations) {
        if (at == null || (trade.side !== "buy" && trade.side !== "sell") || typeof trade.quoteAmount !== "number") continue;
        trades.push({ at, side: trade.side, quoteAmount: trade.quoteAmount, wallet: typeof trade.wallet === "string" ? trade.wallet : undefined, slot: typeof event.slot === "number" ? event.slot : undefined });
        if (typeof trade.priceQuote === "number") prices.push({ at, price: trade.priceQuote, source: typeof trade.pricingMethod === "string" ? trade.pricingMethod : "trade_event_unknown_source" });
      }
    }
    if (event.kind === "holder_distribution_snapshot") holderEvents.push(event);
    if (event.kind === "transaction_fee" && typeof event.networkFeeLamports === "number") {
      fees.networkFeeLamports += event.networkFeeLamports;
      fees.transactionCount++;
      if (event.transactionFailed === true) fees.failedTransactionCount++;
      if (typeof event.computeUnitsConsumed === "number") fees.computeUnitsConsumed += event.computeUnitsConsumed;
    }
  }
  const dedupedPrices = [...new Map(prices.map(point => [`${point.at}:${point.price}:${point.source ?? "unknown"}`, point])).values()];
  const pricesBySource = new Map<string, PricePoint[]>();
  for (const point of dedupedPrices) { const source = point.source ?? "unknown"; const group = pricesBySource.get(source) ?? []; group.push(point); pricesBySource.set(source, group); }
  const pricePathsBySource = Object.fromEntries([...pricesBySource.entries()].map(([source, group]) => [source, calculatePricePathMetrics(group)]));
  const preferredPriceSources = ["pump_bonding_curve_virtual_reserves", "pumpswap_pool_vault_reserves_plus_virtual_quote", "raydium_cpmm_vault_reserves", "decoded_program_trade_event"];
  const preferredSource = preferredPriceSources.find(source => pricesBySource.has(source));
  const preferredPrices = preferredSource ? pricesBySource.get(preferredSource)! : dedupedPrices;
  const latestHolderEvent = holderEvents.sort((a, b) => Number(b.observedAt ?? 0) - Number(a.observedAt ?? 0))[0];
  const latestWallets = latestHolderEvent && Array.isArray(latestHolderEvent.wallets)
    ? latestHolderEvent.wallets as Array<{ owner?: string; amount: number }> : [];
  return {
    mint: launch && typeof launch.mint === "string" ? launch.mint : null,
    venue: launch?.venue ?? "pumpfun",
    launchAt: launch && typeof launch.firstSeenAt === "number" ? launch.firstSeenAt : null,
    pricePath: calculatePricePathMetrics(preferredPrices),
    pricePathsBySource,
    preferredPricePathSource: preferredSource ?? "mixed_fallback_sources",
    tradeFlow: calculateTradeFlowMetrics(trades, trades.reduce((max, trade) => Math.max(max, trade.at), 0)),
    latestTop20HolderConcentration: calculateHolderConcentration(latestWallets),
    holderSnapshotCount: holderEvents.length,
    networkFees: {
      ...fees,
      failedTransactionRatePct: fees.transactionCount ? fees.failedTransactionCount / fees.transactionCount * 100 : null,
      averageComputeUnits: fees.transactionCount && fees.computeUnitsConsumed ? fees.computeUnitsConsumed / fees.transactionCount : null
    },
    rawEventCount: events.length,
    researchCaveats: [
      "Price observations may mix curve, reserve and executed trade prices; inspect pricingMethod before comparing.",
      "Holder concentration is based only on the latest captured top-20 holder sample, not the complete holder registry.",
      "Wallet trade flow is limited to decoded or estimated observations present in the event file.",
      "Network fees include only mint-associated transactions that were fetched and recorded; they are not total wallet costs."
    ]
  };
}
