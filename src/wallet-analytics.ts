export type WalletTradeObservation = {
  wallet: string;
  side: "buy" | "sell";
  tokenAmount: number;
  quoteAmount: number;
  confidence?: "low" | "high";
};

export type WalletProfile = {
  wallet: string;
  firstSeenAt: number;
  lastSeenAt: number;
  transactionCount: number;
  exactTransactionCount: number;
  estimatedTransactionCount: number;
  exactQuoteSpent: number;
  estimatedQuoteSpent: number;
  exactQuoteReceived: number;
  estimatedQuoteReceived: number;
  buyCount: number;
  sellCount: number;
  tokenBought: number;
  tokenSold: number;
  observedNetTokenChange: number;
  quoteSpent: number;
  quoteReceived: number;
  firstBuyAt: number | null;
  firstBuyElapsedSeconds: number | null;
  firstBuySlot: number | null;
  lastBuyAt: number | null;
  lastSellAt: number | null;
  sameSlotAsLaunch: boolean;
  launchFeePayer: boolean;
  creator: boolean;
  fundingSources: string[];
  recentTransactionTimes: number[];
  recentTransactionSlots: number[];
  botScore: number;
  botSignals: string[];
  sniperCandidate: boolean;
  bundleCandidate: boolean;
  processedSignatures?: string[];
  trackedTokenBalance?: number;
  remainingObservedCostBasisQuote?: number;
  realizedPnlQuote?: number | null;
  inventoryCoverageComplete?: boolean;
  sellExceedsObservedBuys?: boolean;
  networkFeesLamportsPaid: number;
  networkFeeTransactions: number;
};

export type WalletAnalyticsContext = {
  observedAt: number;
  slot: number;
  launchSlot: number;
  launchAt: number;
  launchFeePayer: string | null;
  creator: string | null;
  fundingSources?: string[];
  signature?: string;
  feePayer?: string | null;
  networkFeeLamports?: number;
};

export function updateWalletProfile(
  existing: WalletProfile | undefined,
  trade: WalletTradeObservation,
  context: WalletAnalyticsContext
): WalletProfile {
  const profile: WalletProfile = existing ?? {
    wallet: trade.wallet,
    firstSeenAt: context.observedAt,
    lastSeenAt: context.observedAt,
    transactionCount: 0,
    exactTransactionCount: 0,
    estimatedTransactionCount: 0,
    exactQuoteSpent: 0,
    estimatedQuoteSpent: 0,
    exactQuoteReceived: 0,
    estimatedQuoteReceived: 0,
    buyCount: 0,
    sellCount: 0,
    tokenBought: 0,
    tokenSold: 0,
    observedNetTokenChange: 0,
    quoteSpent: 0,
    quoteReceived: 0,
    firstBuyAt: null,
    firstBuyElapsedSeconds: null,
    firstBuySlot: null,
    lastBuyAt: null,
    lastSellAt: null,
    sameSlotAsLaunch: false,
    launchFeePayer: false,
    creator: false,
    fundingSources: [],
    recentTransactionTimes: [],
    recentTransactionSlots: [],
    botScore: 0,
    botSignals: [],
    sniperCandidate: false,
    bundleCandidate: false,
    processedSignatures: [], trackedTokenBalance: 0, remainingObservedCostBasisQuote: 0,
    realizedPnlQuote: 0, inventoryCoverageComplete: true, sellExceedsObservedBuys: false,
    networkFeesLamportsPaid: 0, networkFeeTransactions: 0
  };

  // One observation per wallet per signature should be supplied by the caller.
  profile.exactTransactionCount ??= 0;
  profile.estimatedTransactionCount ??= 0;
  profile.exactQuoteSpent ??= 0;
  profile.estimatedQuoteSpent ??= 0;
  profile.exactQuoteReceived ??= 0;
  profile.estimatedQuoteReceived ??= 0;
  profile.processedSignatures ??= [];
  profile.trackedTokenBalance ??= 0;
  profile.remainingObservedCostBasisQuote ??= 0;
  profile.inventoryCoverageComplete ??= false;
  profile.sellExceedsObservedBuys ??= false;
  profile.networkFeesLamportsPaid ??= 0;
  profile.networkFeeTransactions ??= 0;
  const newSignature = !context.signature || !profile.processedSignatures.includes(context.signature);
  if (newSignature) {
    profile.transactionCount++;
    if (trade.confidence === "high") profile.exactTransactionCount++;
    else profile.estimatedTransactionCount++;
    profile.lastSeenAt = context.observedAt;
    if (context.feePayer === trade.wallet && context.networkFeeLamports != null) {
      profile.networkFeesLamportsPaid += context.networkFeeLamports;
      profile.networkFeeTransactions++;
    }
    profile.recentTransactionTimes.push(context.observedAt);
    profile.recentTransactionSlots.push(context.slot);
    if (context.signature) {
      profile.processedSignatures.push(context.signature);
      if (profile.processedSignatures.length > 200) profile.processedSignatures = profile.processedSignatures.slice(-100);
    }
  }
  profile.recentTransactionTimes = profile.recentTransactionTimes.filter(t => context.observedAt - t <= 30_000).slice(-30);
  profile.recentTransactionSlots = profile.recentTransactionSlots.slice(-30);
  profile.launchFeePayer ||= context.launchFeePayer === trade.wallet;
  profile.creator ||= context.creator === trade.wallet;
  for (const source of context.fundingSources ?? []) {
    if (source !== trade.wallet && !profile.fundingSources.includes(source)) profile.fundingSources.push(source);
  }

  if (trade.side === "buy") {
    profile.buyCount++;
    profile.tokenBought += trade.tokenAmount;
    profile.quoteSpent += trade.quoteAmount;
    if (trade.confidence === "high") profile.exactQuoteSpent += trade.quoteAmount;
    else profile.estimatedQuoteSpent += trade.quoteAmount;
    const previousBalance = profile.trackedTokenBalance;
    const previousBasis = profile.remainingObservedCostBasisQuote;
    profile.trackedTokenBalance = previousBalance + trade.tokenAmount;
    profile.remainingObservedCostBasisQuote = previousBasis + trade.quoteAmount;
    if (profile.realizedPnlQuote == null && profile.inventoryCoverageComplete) profile.realizedPnlQuote = 0;
    profile.lastBuyAt = context.observedAt;
    if (profile.firstBuyAt == null) {
      profile.firstBuyAt = context.observedAt;
      profile.firstBuyElapsedSeconds = Math.max(0, (context.observedAt - context.launchAt) / 1000);
      profile.firstBuySlot = context.slot;
    }
  } else {
    profile.sellCount++;
    profile.tokenSold += trade.tokenAmount;
    profile.quoteReceived += trade.quoteAmount;
    if (trade.confidence === "high") profile.exactQuoteReceived += trade.quoteAmount;
    else profile.estimatedQuoteReceived += trade.quoteAmount;
    const available = profile.trackedTokenBalance ?? 0;
    const basis = profile.remainingObservedCostBasisQuote ?? 0;
    if (trade.tokenAmount > available + Math.max(1e-12, available * 1e-8)) {
      profile.sellExceedsObservedBuys = true;
      profile.inventoryCoverageComplete = false;
      profile.realizedPnlQuote = null;
    } else if (available > 0) {
      const averageCost = basis / available;
      const costRemoved = Math.min(trade.tokenAmount, available) * averageCost;
      if (profile.realizedPnlQuote != null) profile.realizedPnlQuote += trade.quoteAmount - costRemoved;
      profile.trackedTokenBalance = Math.max(0, available - trade.tokenAmount);
      profile.remainingObservedCostBasisQuote = Math.max(0, basis - costRemoved);
    }
    profile.lastSellAt = context.observedAt;
  }
  profile.observedNetTokenChange = profile.tokenBought - profile.tokenSold;
  profile.sameSlotAsLaunch ||= context.slot === context.launchSlot;
  const launchSlotOffset = context.slot - context.launchSlot;
  profile.sniperCandidate ||= trade.side === "buy" && (
    (profile.firstBuyElapsedSeconds != null && profile.firstBuyElapsedSeconds <= 5) ||
    (launchSlotOffset >= 0 && launchSlotOffset <= 12)
  );
  profile.bundleCandidate ||= trade.side === "buy" && launchSlotOffset >= 0 && launchSlotOffset <= 1;

  const signals = new Set(profile.botSignals);
  const rapidTransactions = profile.recentTransactionTimes.length;
  const sameSlotTransactions = new Set(profile.recentTransactionSlots).size < profile.recentTransactionSlots.length;
  const roundTrip = profile.buyCount > 0 && profile.sellCount > 0 &&
    profile.lastSellAt != null && profile.firstBuyAt != null &&
    profile.lastSellAt - profile.firstBuyAt <= 30_000;
  if (rapidTransactions >= 4) signals.add("four_or_more_transactions_in_30_seconds");
  if (sameSlotTransactions) signals.add("multiple_transactions_in_same_slot");
  if (roundTrip) signals.add("buy_and_sell_within_30_seconds");
  profile.botSignals = [...signals];
  profile.botScore = Math.min(100,
    (rapidTransactions >= 4 ? 35 : rapidTransactions >= 3 ? 15 : 0) +
    (sameSlotTransactions ? 30 : 0) +
    (roundTrip ? 35 : 0)
  );
  return profile;
}

export function extractFundingSources(tx: unknown, recipient: string): string[] {
  const transaction = tx as {
    transaction?: { message?: { instructions?: unknown[] } };
    meta?: { innerInstructions?: Array<{ instructions?: unknown[] }> };
  };
  const instructions = [
    ...(transaction.transaction?.message?.instructions ?? []),
    ...(transaction.meta?.innerInstructions ?? []).flatMap(group => group.instructions ?? [])
  ];
  const sources = new Set<string>();
  for (const value of instructions) {
    if (!value || typeof value !== "object") continue;
    const instruction = value as { program?: unknown; programId?: unknown; parsed?: { type?: unknown; info?: Record<string, unknown> } };
    if (instruction.program !== "system" && String(instruction.programId ?? "") !== "11111111111111111111111111111111") continue;
    if (instruction.parsed?.type !== "transfer") continue;
    const info = instruction.parsed.info;
    if (!info || String(info.destination ?? "") !== recipient) continue;
    const source = String(info.source ?? "");
    if (source && source !== recipient) sources.add(source);
  }
  return [...sources];
}

export function summarizeWalletCohorts(profiles: Record<string, WalletProfile>, markPriceQuote: number | null = null) {
  const wallets = Object.values(profiles);
  const creators = wallets.filter(p => p.creator);
  const devFeePayers = wallets.filter(p => p.launchFeePayer);
  const snipers = wallets.filter(p => p.sniperCandidate);
  const bots = wallets.filter(p => p.botScore >= 50);
  const bundled = wallets.filter(p => p.bundleCandidate);
  const developerCandidates = wallets.filter(p => p.creator || p.launchFeePayer);
  const developerBots = developerCandidates.filter(p => p.botScore >= 50);
  const creatorBots = creators.filter(p => p.botScore >= 50);
  const sniperBots = snipers.filter(p => p.botScore >= 50);
  const fundingGroups = new Map<string, string[]>();
  const sameSlotGroups = new Map<number, string[]>();
  for (const profile of wallets) {
    for (const source of profile.fundingSources) {
      const group = fundingGroups.get(source) ?? [];
      group.push(profile.wallet);
      fundingGroups.set(source, group);
    }
    if (profile.firstBuySlot != null) {
      const group = sameSlotGroups.get(profile.firstBuySlot) ?? [];
      group.push(profile.wallet);
      sameSlotGroups.set(profile.firstBuySlot, group);
    }
  }
  const topBuyers = [...wallets].sort((a, b) => b.quoteSpent - a.quoteSpent).slice(0, 20);
  const topSellers = [...wallets].sort((a, b) => b.quoteReceived - a.quoteReceived).slice(0, 20);
  const earlyBuyers = wallets.filter(p => p.firstBuyElapsedSeconds != null && p.firstBuyElapsedSeconds <= 30);
  const calculatePnl = (cohort: WalletProfile[]) => {
    const realized = cohort.every(p => p.realizedPnlQuote != null) ? cohort.reduce((sum, p) => sum + (p.realizedPnlQuote ?? 0), 0) : null;
    const unrealized = markPriceQuote != null && cohort.every(p => p.inventoryCoverageComplete !== false)
      ? cohort.reduce((sum, p) => sum + markPriceQuote * (p.trackedTokenBalance ?? 0) - (p.remainingObservedCostBasisQuote ?? 0), 0) : null;
    return { realizedPnlQuote: realized, unrealizedPnlQuote: unrealized, totalObservedPnlQuote: realized != null && unrealized != null ? realized + unrealized : null, excludesNetworkFees: true, markPriceQuote };
  };
  const creatorPnl = calculatePnl(creators);
  const developerPnl = calculatePnl(developerCandidates);
  const developerBotPnl = calculatePnl(developerBots);
  const sniperPnl = calculatePnl(snipers);
  const sniperBotPnl = calculatePnl(sniperBots);
  const botPnl = calculatePnl(bots);
  const creatorBotPnl = calculatePnl(creatorBots);
  return {
    walletCount: wallets.length,
    creatorWallets: creators.map(p => p.wallet),
    launchFeePayerWallets: devFeePayers.map(p => p.wallet),
    developerCandidateWallets: developerCandidates.map(p => ({ wallet: p.wallet, role: p.creator ? "creator" : "launch_fee_payer" })),
    sniperCandidateWallets: snipers.map(p => p.wallet),
    earlyBuyerWallets: earlyBuyers.map(p => p.wallet),
    botCandidateWallets: bots.map(p => p.wallet),
    developerBotCandidateWallets: developerBots.map(p => p.wallet),
    creatorBotCandidateWallets: creatorBots.map(p => p.wallet),
    sniperBotCandidateWallets: sniperBots.map(p => p.wallet),
    sniperCandidateCount: snipers.length, botCandidateCount: bots.length,
    bundledEntryCandidateCount: bundled.length, developerBotCandidateCount: developerBots.length,
    creatorBotCandidateCount: creatorBots.length, sniperBotCandidateCount: sniperBots.length,
    bundledEntryCandidateWallets: bundled.map(p => p.wallet),
    creatorBuyQuote: creators.reduce((n, p) => n + p.quoteSpent, 0),
    creatorSellQuote: creators.reduce((n, p) => n + p.quoteReceived, 0),
    creatorNetworkFeesLamportsPaid: creators.reduce((n, p) => n + (p.networkFeesLamportsPaid ?? 0), 0),
    creatorExactBuyQuote: creators.reduce((n, p) => n + (p.exactQuoteSpent ?? 0), 0),
    creatorExactSellQuote: creators.reduce((n, p) => n + (p.exactQuoteReceived ?? 0), 0),
    creatorEstimatedBuyQuote: creators.reduce((n, p) => n + (p.estimatedQuoteSpent ?? 0), 0),
    creatorEstimatedSellQuote: creators.reduce((n, p) => n + (p.estimatedQuoteReceived ?? 0), 0),
    creatorObservedNetTokenChange: creators.reduce((n, p) => n + p.observedNetTokenChange, 0),
    creatorRemainingObservedCostBasisQuote: creators.reduce((n, p) => n + (p.remainingObservedCostBasisQuote ?? 0), 0),
    ...creatorPnl,
    developerRealizedPnlQuote: developerPnl.realizedPnlQuote,
    developerUnrealizedPnlQuote: developerPnl.unrealizedPnlQuote,
    developerTotalObservedPnlQuote: developerPnl.totalObservedPnlQuote,
    developerBotRealizedPnlQuote: developerBotPnl.realizedPnlQuote,
    developerBotUnrealizedPnlQuote: developerBotPnl.unrealizedPnlQuote,
    developerBotTotalObservedPnlQuote: developerBotPnl.totalObservedPnlQuote,
    creatorBotRealizedPnlQuote: creatorBotPnl.realizedPnlQuote,
    creatorBotUnrealizedPnlQuote: creatorBotPnl.unrealizedPnlQuote,
    creatorBotTotalObservedPnlQuote: creatorBotPnl.totalObservedPnlQuote,
    creatorSellExceedsObservedBuysWallets: creators.filter(p => p.sellExceedsObservedBuys).map(p => p.wallet),
    creatorTokensBought: creators.reduce((n, p) => n + p.tokenBought, 0),
    creatorTokensSold: creators.reduce((n, p) => n + p.tokenSold, 0),
    launchFeePayerBuyQuote: devFeePayers.reduce((n, p) => n + p.quoteSpent, 0),
    launchFeePayerSellQuote: devFeePayers.reduce((n, p) => n + p.quoteReceived, 0),
    launchFeePayerExactBuyQuote: devFeePayers.reduce((n, p) => n + (p.exactQuoteSpent ?? 0), 0),
    launchFeePayerExactSellQuote: devFeePayers.reduce((n, p) => n + (p.exactQuoteReceived ?? 0), 0),
    sniperBuyQuote: snipers.reduce((n, p) => n + p.quoteSpent, 0),
    sniperAverageFirstBuyDelaySeconds: snipers.length ? snipers.reduce((n, p) => n + (p.firstBuyElapsedSeconds ?? 0), 0) / snipers.length : null,
    sniperEarliestFirstBuyDelaySeconds: snipers.length ? Math.min(...snipers.map(p => p.firstBuyElapsedSeconds ?? Infinity)) : null,
    sniperLargestBuyQuote: snipers.length ? Math.max(...snipers.map(p => p.quoteSpent)) : 0,
    sniperSellQuote: snipers.reduce((n, p) => n + p.quoteReceived, 0),
    sniperNetworkFeesLamportsPaid: snipers.reduce((n, p) => n + (p.networkFeesLamportsPaid ?? 0), 0),
    sniperTokensBought: snipers.reduce((n, p) => n + p.tokenBought, 0),
    sniperTokensSold: snipers.reduce((n, p) => n + p.tokenSold, 0),
    sniperRealizedPnlQuote: sniperPnl.realizedPnlQuote,
    sniperUnrealizedPnlQuote: sniperPnl.unrealizedPnlQuote,
    sniperTotalObservedPnlQuote: sniperPnl.totalObservedPnlQuote,
    sniperBotRealizedPnlQuote: sniperBotPnl.realizedPnlQuote,
    sniperBotUnrealizedPnlQuote: sniperBotPnl.unrealizedPnlQuote,
    sniperBotTotalObservedPnlQuote: sniperBotPnl.totalObservedPnlQuote,
    sniperSameLaunchSlotWalletCount: snipers.filter(p => p.sameSlotAsLaunch).length,
    botCandidateBuyQuote: bots.reduce((n, p) => n + p.quoteSpent, 0),
    botCandidateAverageTransactions: bots.length ? bots.reduce((n, p) => n + p.transactionCount, 0) / bots.length : 0,
    developerBotBuyQuote: developerBots.reduce((n, p) => n + p.quoteSpent, 0),
    developerBotSellQuote: developerBots.reduce((n, p) => n + p.quoteReceived, 0),
    botCandidateSellQuote: bots.reduce((n, p) => n + p.quoteReceived, 0),
    botCandidateNetworkFeesLamportsPaid: bots.reduce((n, p) => n + (p.networkFeesLamportsPaid ?? 0), 0),
    botCandidateTokensBought: bots.reduce((n, p) => n + p.tokenBought, 0),
    botCandidateTokensSold: bots.reduce((n, p) => n + p.tokenSold, 0),
    botCandidateRealizedPnlQuote: botPnl.realizedPnlQuote,
    botCandidateUnrealizedPnlQuote: botPnl.unrealizedPnlQuote,
    botCandidateTotalObservedPnlQuote: botPnl.totalObservedPnlQuote,
    topBuyerWallets: topBuyers.map(p => ({ wallet: p.wallet, quoteSpent: p.quoteSpent, exactQuoteSpent: (p.exactQuoteSpent ?? 0), estimatedQuoteSpent: (p.estimatedQuoteSpent ?? 0), tokenBought: p.tokenBought, transactionCount: p.transactionCount, exactTransactionCount: p.exactTransactionCount, estimatedTransactionCount: p.estimatedTransactionCount, sniperCandidate: p.sniperCandidate, botScore: p.botScore, firstBuyElapsedSeconds: p.firstBuyElapsedSeconds, firstBuySlot: p.firstBuySlot, sameSlotAsLaunch: p.sameSlotAsLaunch, realizedPnlQuote: p.realizedPnlQuote, unrealizedPnlQuote: markPriceQuote != null && p.inventoryCoverageComplete !== false ? markPriceQuote * (p.trackedTokenBalance ?? 0) - (p.remainingObservedCostBasisQuote ?? 0) : null, trackedTokenBalance: p.trackedTokenBalance, sellExceedsObservedBuys: p.sellExceedsObservedBuys })),
    topSellerWallets: topSellers.map(p => ({ wallet: p.wallet, quoteReceived: p.quoteReceived, exactQuoteReceived: (p.exactQuoteReceived ?? 0), estimatedQuoteReceived: (p.estimatedQuoteReceived ?? 0), tokenSold: p.tokenSold, transactionCount: p.transactionCount, creator: p.creator, botScore: p.botScore })),
    sameSlotEntryGroups: [...sameSlotGroups.entries()].filter(([, members]) => members.length > 1)
      .map(([slot, members]) => ({ slot, wallets: [...new Set(members)] })),
    sharedFundingGroups: [...fundingGroups.entries()].filter(([, members]) => members.length > 1)
      .map(([fundingSource, members]) => ({ fundingSource, wallets: [...new Set(members)] })),
    botLabelsAreHeuristic: true,
    sniperLabelsAreHeuristic: true,
    bundleLabelsAreHeuristic: true,
    fundingLinksAreObservedTransfersOnly: true
  };
}
