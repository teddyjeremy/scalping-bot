export type WalletGraphEvent = {
  kind?: unknown;
  mint?: unknown;
  wallet?: unknown;
  signature?: unknown;
  slot?: unknown;
  blockTime?: unknown;
  observedAt?: unknown;
  side?: unknown;
  tokenAmount?: unknown;
  quoteAmount?: unknown;
  quoteMint?: unknown;
  confidence?: unknown;
  isCreator?: unknown;
  isLaunchFeePayer?: unknown;
  sniperCandidate?: unknown;
  bundleCandidate?: unknown;
  botScore?: unknown;
  botSignals?: unknown;
  fundingSources?: unknown;
};

type WalletAggregate = {
  wallet: string;
  mints: Set<string>;
  signatures: Set<string>;
  eventCount: number;
  buyCount: number;
  sellCount: number;
  tokenBought: number;
  tokenSold: number;
  quoteSpentByMint: Map<string, number>;
  quoteReceivedByMint: Map<string, number>;
  creatorMints: Set<string>;
  launchFeePayerMints: Set<string>;
  sniperMints: Set<string>;
  botCandidateMints: Set<string>;
  funders: Set<string>;
  botSignals: Set<string>;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addAmount(map: Map<string, number>, key: string, amount: number) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function reconstructCrossTokenWalletGraph(events: WalletGraphEvent[]) {
  const wallets = new Map<string, WalletAggregate>();
  const funderGroups = new Map<string, Set<string>>();
  const launchSlotGroups = new Map<string, Set<string>>();
  const pairMints = new Map<string, Set<string>>();
  const seenTradeEvents = new Set<string>();
  let acceptedEvents = 0;
  let ignoredEvents = 0;

  for (const event of events) {
    if (event.kind !== "wallet_activity" || typeof event.wallet !== "string" ||
        typeof event.mint !== "string" || (event.side !== "buy" && event.side !== "sell")) {
      ignoredEvents++;
      continue;
    }
    const tokenAmount = finite(event.tokenAmount);
    const quoteAmount = finite(event.quoteAmount);
    if (tokenAmount == null || quoteAmount == null || tokenAmount <= 0 || quoteAmount <= 0) {
      ignoredEvents++;
      continue;
    }
    const signature = typeof event.signature === "string" ? event.signature : "";
    const dedupeKey = [event.mint, signature, event.wallet, event.side, tokenAmount, quoteAmount].join(":");
    if (signature && seenTradeEvents.has(dedupeKey)) continue;
    if (signature) seenTradeEvents.add(dedupeKey);

    let profile = wallets.get(event.wallet);
    if (!profile) {
      profile = {
        wallet: event.wallet, mints: new Set(), signatures: new Set(), eventCount: 0,
        buyCount: 0, sellCount: 0, tokenBought: 0, tokenSold: 0,
        quoteSpentByMint: new Map(), quoteReceivedByMint: new Map(),
        creatorMints: new Set(), launchFeePayerMints: new Set(), sniperMints: new Set(),
        botCandidateMints: new Set(), funders: new Set(), botSignals: new Set(),
        firstSeenAt: null, lastSeenAt: null
      };
      wallets.set(event.wallet, profile);
    }
    acceptedEvents++;
    profile.mints.add(event.mint);
    profile.eventCount++;
    if (signature) profile.signatures.add(signature);
    const at = finite(event.blockTime) != null ? finite(event.blockTime)! * 1000 : finite(event.observedAt);
    if (at != null) {
      profile.firstSeenAt = profile.firstSeenAt == null ? at : Math.min(profile.firstSeenAt, at);
      profile.lastSeenAt = profile.lastSeenAt == null ? at : Math.max(profile.lastSeenAt, at);
    }
    if (event.side === "buy") {
      profile.buyCount++;
      profile.tokenBought += tokenAmount;
      addAmount(profile.quoteSpentByMint, typeof event.quoteMint === "string" ? event.quoteMint : "unknown", quoteAmount);
    } else {
      profile.sellCount++;
      profile.tokenSold += tokenAmount;
      addAmount(profile.quoteReceivedByMint, typeof event.quoteMint === "string" ? event.quoteMint : "unknown", quoteAmount);
    }
    if (event.isCreator === true) profile.creatorMints.add(event.mint);
    if (event.isLaunchFeePayer === true) profile.launchFeePayerMints.add(event.mint);
    if (event.sniperCandidate === true) profile.sniperMints.add(event.mint);
    if (finite(event.botScore) != null && finite(event.botScore)! >= 50) profile.botCandidateMints.add(event.mint);
    if (Array.isArray(event.botSignals)) for (const signal of event.botSignals) if (typeof signal === "string") profile.botSignals.add(signal);
    const funders = Array.isArray(event.fundingSources) ? event.fundingSources : [];
    for (const funder of funders) {
      if (typeof funder !== "string" || !funder || funder === event.wallet) continue;
      profile.funders.add(funder);
      const group = funderGroups.get(funder) ?? new Set<string>();
      group.add(event.wallet);
      funderGroups.set(funder, group);
    }
    if (event.bundleCandidate === true && finite(event.slot) != null) {
      const groupKey = `${event.mint}:${finite(event.slot)}`;
      const group = launchSlotGroups.get(groupKey) ?? new Set<string>();
      group.add(event.wallet);
      launchSlotGroups.set(groupKey, group);
    }
  }

  for (const [groupKey, membersSet] of launchSlotGroups) {
    const members = [...membersSet].sort();
    if (members.length < 2) continue;
    const mint = groupKey.slice(0, groupKey.lastIndexOf(":"));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = `${members[i]}|${members[j]}`;
        const mints = pairMints.get(key) ?? new Set<string>();
        mints.add(mint);
        pairMints.set(key, mints);
      }
    }
  }

  const profiles = [...wallets.values()].map(profile => ({
    wallet: profile.wallet,
    uniqueTokenCount: profile.mints.size,
    tokenMints: [...profile.mints].sort(),
    uniqueTransactionCount: profile.signatures.size,
    eventCount: profile.eventCount,
    buyCount: profile.buyCount,
    sellCount: profile.sellCount,
    tokenBought: profile.tokenBought,
    tokenSold: profile.tokenSold,
    quoteSpentByMint: Object.fromEntries(profile.quoteSpentByMint),
    quoteReceivedByMint: Object.fromEntries(profile.quoteReceivedByMint),
    creatorMintCount: profile.creatorMints.size,
    creatorMints: [...profile.creatorMints],
    launchFeePayerMintCount: profile.launchFeePayerMints.size,
    launchFeePayerMints: [...profile.launchFeePayerMints],
    sniperCandidateMintCount: profile.sniperMints.size,
    sniperCandidateMints: [...profile.sniperMints],
    botCandidateMintCount: profile.botCandidateMints.size,
    botCandidateMints: [...profile.botCandidateMints],
    observedFundingSources: [...profile.funders],
    botSignals: [...profile.botSignals],
    firstSeenAt: profile.firstSeenAt,
    lastSeenAt: profile.lastSeenAt
  })).sort((a, b) => b.uniqueTokenCount - a.uniqueTokenCount || b.eventCount - a.eventCount);

  return {
    walletCount: profiles.length,
    acceptedWalletActivityEvents: acceptedEvents,
    ignoredEvents,
    crossTokenWallets: profiles.filter(profile => profile.uniqueTokenCount > 1),
    wallets: profiles,
    sharedFundingSourceGroups: [...funderGroups.entries()].filter(([, members]) => members.size > 1)
      .map(([fundingSource, members]) => ({ fundingSource, wallets: [...members].sort() })),
    repeatedSameLaunchSlotCoEntryPairs: [...pairMints.entries()].filter(([, mints]) => mints.size > 1)
      .map(([pair, mints]) => ({ wallets: pair.split("|"), sharedLaunchMints: [...mints].sort(), sharedLaunchCount: mints.size }))
      .sort((a, b) => b.sharedLaunchCount - a.sharedLaunchCount),
    caveats: [
      "Only wallet_activity events present in the supplied files are analyzed; missing launches or transactions reduce coverage.",
      "Quote totals are kept separate by quote mint and must not be summed across different assets.",
      "Funding links are only directly observed transfers recorded alongside a wallet activity event; this is not a complete funding history.",
      "Sniper, bot and bundle labels are heuristics, not proof of identity or automation.",
      "Same-slot co-entry is not proof of a private bundle or common ownership."
    ]
  };
}
