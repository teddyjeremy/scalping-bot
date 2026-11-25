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
