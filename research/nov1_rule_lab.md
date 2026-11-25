# November 1, 2026 — deterministic rule research

## Scope
- UTC launch date: 2026-11-01 only.
- Capture window: launch through launch + 600 seconds.
- No 30-minute reconstruction.
- Collection continues independently; this research ledger must not mark a coin complete because a workflow succeeded.

## Readiness states
- `RESEARCH_READY`: 600-second transaction history is complete, pagination/source coverage is complete, time-bucket accounting is complete, and the required fields for the rule being tested have acceptable coverage.
- `PARTIAL`: real launch/trade observations exist, but the 10-minute history or coverage is incomplete.
- `METADATA_ONLY`: launch metadata exists but no usable trade observations.
- `UNVERIFIED`: not yet audited. Never treat as safe or complete.

## Initial verified audit
At the initial audit on 2026-11-25, **zero coins had been verified as RESEARCH_READY**. This is not a claim that zero coin files exist: partial launch/trade records are present.

| Mint | Launch UTC | Observed trades | 10s buckets observed | Status |
|---|---:|---:|---:|---|
| 2CZCCzSET2s1njBHxszki3bh1MjLTdnpEoCtPoEYsheZ (NNN) | 00:34:27 | 1 buy (+3s) | 1/60 | PARTIAL |

The NNN record has real launch and buy data persisted, but the other 59 buckets are unaccounted for. Empty buckets do not prove no trading occurred. Do not fit entry/exit thresholds from this coin yet.

## Rule-development plan
Start with descriptive analysis, then test deterministic rules on completed samples only. Keep partial samples visible for data-quality debugging, not performance claims.

### Candidate entry features
1. Early buy flow: buy count and quote volume in 1s, 3s, 5s, 10s, 30s, and 60s windows.
2. Participation: unique buyers, buyer acceleration, repeat-buyer share, buyer concentration, and top-wallet share.
3. Price/reserve behavior: implied price change, curve reserve changes, price impact, and buy/sell imbalance.
4. Creator/deployer behavior: creator buys/sells, creator-linked wallet activity, launch funding links, and early distribution.
5. Execution quality: estimated slippage, priority fees, tips, compute usage, and whether a target return remains profitable after fees.
6. Safety gates: verified bonding-curve state or verifiably locked LP after migration; unresolved liquidity/security evidence remains UNVERIFIED and blocks entry.

### Candidate exit / danger features
- Sell-volume acceleration and buy/sell imbalance reversal.
- Price momentum deterioration and failed continuation after a local high.
- Large-holder / top-buyer concentration and coordinated wallet outflows.
- Creator/deployer selling or suspicious funding-linked exits.
- Reserve depletion, liquidity removal, abnormal price impact, and failed transaction bursts.
- Trailing-stop and fixed-target exits evaluated net of all fees and slippage.

### Evaluation rules
- Use chronological splits; never tune and score on the same coins.
- Report sample count and feature coverage beside every result.
- Measure net return after swap fees, priority fees, tips, slippage, and failed-transaction costs where observable.
- Report win rate, median/mean return, downside quantiles, max adverse excursion, max favorable excursion, time-to-target, time-to-stop, and wipeout/rug false-negative rate.
- Compare each rule against simple baselines; include missed winners and avoided losers.
- Missing values are unknown, not zero. Heuristic bot/sniper labels must never be presented as ground truth.
- Do not deploy live rules until out-of-sample results and safety gates pass.

## Updating this ledger
For every coin, add or update one row in `nov1_coin_readiness.csv` after verifying the actual Hugging Face files. A coin enters the research-ready list only after its summary, source cursors, transaction pages, and 60 ten-second buckets have been checked. Keep a separate count of PARTIAL, METADATA_ONLY, and UNVERIFIED coins.


## First verified November 1 transaction-complete cohort (partial ledger scan)
A scan of the first 60 Pump.fun ledger entries in hash-path order found **10 coins** whose saved ledger reports all of: 600-second requested window, `transactionHistoryComplete=true`, replay source complete, and `gapAccountingComplete=true`. This is a transaction-capture cohort, **not** a fully research-ready/safety-verified cohort. All 10 currently have `researchReady=false` because additional historical price, holder, liquidity, or failed-transaction evidence is missing. The scan covered only the first 60 entries returned, not the entire November 1 dataset; do not present 10 as the global total.

The strongest first analysis candidate is `FUzY9vpsEesiyzrcoXGN8hxuvwpYZsqq8WmQtsggpump`:
- 1,776 trade events: 1,003 buys and 773 sells.
- 526 unique buyers, 449 unique sellers, 528 unique traders.
- 384.9500 SOL buy volume versus 349.3202 SOL sell volume.
- 2 creator sell events; top buyer share of buy volume 2.30%.
- Quote-per-token price path first to last rises from approximately 3.0168e-8 to 1.3379e-7; reported max drawdown is 65.64%. This is **not USD pricing**, and must not be interpreted as net executable return.
- 59/60 ten-second buckets have event observations; bucket 47 is empty, and the replay marks gap accounting complete.
- Network fee fields are unavailable (zero transactions with fee data), so net-of-fee returns cannot yet be established.

Other transaction-complete samples found in the same 60-entry scan: `Hq5YKeDcrUNip7bMnhSgo3LSzY6LEkoMbHi6S1U2pump` (193 trades, 8 observed buckets); `Fz3QgULhNFBN4yfZ5ozRWQuHJdwGPiyMrZsWfSkvpump` (107 trades, 27 buckets); `Eymttx3BP4MYAtyPwDBXY193qjbtCd25B2Q3VSWEpump` (73 trades, 6 buckets); `HGVEUYmYKbtnnFLCpxvFnevqc96xftZHomKCqrQUpump` (66 trades, 5 buckets); `ERMqP5kkXmMw7TKTMCyBk9x15bBf1m7ZdBE2M2CSpump` (87 trades, 8 buckets); `Hs9iix6vdaCBLh7iPErjiES5ttgfA979e1KYpDAJpump` (18 trades, 5 buckets); `HYexqtrk6czSDMMNw8mGsfffwD7hu1ZAzk9nCp47pump` (13 trades, 4 buckets); `HenNJC3ji7wVDRzHNg19A5HE6SAbms3auxWxvtJrpump` (7 trades, 2 buckets); and `Hm29qFXm5pSFiWGMYLHs5Bkwz6RrQyBH1wmLsMAFxSeH` (zero trade events; keep as a no-trade/control sample).

### Immediate first rule experiments
1. For FUz, build time-series features by second/bucket: buy/sell quote volume, buy/sell counts, unique buyer growth, buy/sell imbalance, price return, rolling high-to-low drawdown, and reserve movement.
2. Compare candidate entries at +30s to +300s against subsequent quote-price path, while labeling price data as quote-denominated and excluding fee-adjusted profitability claims.
3. Test whether early buyer acceleration and concentration predict later continuation versus sharp adverse excursion. Do not assume wallet heuristics identify bots.
4. Keep sparse coins and the zero-trade coin in the dataset as distinct activity cohorts; do not discard them as failed collection.
5. As collection updates, rerun the full ledger scan and append newly verified coins; the current cohort count is a lower bound from a limited scan.
