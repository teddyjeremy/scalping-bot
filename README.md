# Solana Scalping Data Collector — Phase 1

This repository contains the first-stage **research data collector**. It does not buy or sell tokens.

## What it currently does

- Watches Pump.fun and the Raydium LaunchLab program used by StonkFun.
- Fetches confirmed launch transactions through Helius.
- Identifies Pump `create` / `create_v2` transactions using exact instruction discriminators and the official Pump account order; verifies the mint is owned by SPL Token or Token-2022. It does not infer a launch mint from token-balance deltas.
- Identifies StonkFun LaunchLab `initialize`, `initialize_v2` and `initialize_with_token_2022` instructions by discriminator, LaunchLab program ID and known StonkFun platform-config accounts; reads base mint, quote mint and pool address from the documented account positions.
- Creates one folder per mint: `data/tokens/<MINT>/events.jsonl`.
- Captures transactions mentioning that mint for up to the configured first 10 minutes.
- Stores the launch transaction fee payer separately. Creator identity is left null until decoded from authoritative launch-event data; fee payer is not silently labelled as creator.
- Persists state and a remote Hugging Face checkpoint, restores active token event files, and saves Pump and LaunchLab signature cursors. On later runs it reconciles missed program transactions in bounded pages and saves page cursors so reconciliation can resume.
- Serializes parsed-transaction fetches across up to three Helius API keys, deduplicates repeated signatures and applies exponential backoff on rate limits.

## Market, price and trading metrics (schema version 3)

For each newly detected Pump or StonkFun mint, the collector attempts to store the mint supply and records venue-specific state, derived trade observations and timed snapshots alongside raw transaction evidence.

Current derived fields include:
- Pump bonding-curve spot price in its actual quote asset: SOL, USDC, USDT, or another SPL mint. Quote mint decimals are read from chain; the quote price and quote-denominated reserves are retained even when a reliable USD conversion is unavailable.
- StonkFun LaunchLab quote mint, platform config, pool address and raw pool-account snapshots. StonkFun trade prices currently use signer-only owner-balance deltas and are explicitly low confidence until LaunchLab pool-state and TradeEvent decoding is completed.
- USD conversion is provided for SOL using the SOL/USD reference and for USDC/USDT using an explicitly approximate $1 reference. Unknown custom quote assets are not falsely priced in USD.
- FDV-style market capitalization in quote units and USD where conversion is supported (bonding-curve spot price multiplied by on-chain total supply; this is not circulating market cap).
- Timed snapshots at 5, 10, 15, 30, 60, 120, 300 and 600 seconds after launch.
- Low-confidence owner-balance-delta buy/sell observations, quote/SOL/USD estimated volume, largest observed buy/sell amounts and unique observed buyers/sellers. These are not exact transaction-level trade counts or fills.
- Highest/lowest observed USD price where available, quote-denominated maximum drawdown, largest observed buy/sell size, and time to 1.2x, 1.5x, 1.7x and 2x from the first observed quote price.
- Bonding-curve virtual and real SOL/token reserves, completion status, quote mint, and creator field when present in the curve account.
- Raw transaction balances, token balances, logs, signatures, slot, network fee in lamports, signature count, estimated base-signature fee, estimated priority fee (network fee minus base signature fee), compute units consumed, loaded addresses and inner instructions remain available for re-analysis.
- Extended Pump bonding-curve account fields include creator fee basis points, Holder Rewards flag, creator/protocol fee balances accrued on the curve, Mayhem/Cashback flags and quote mint when present. Accrued fee balances are denominated in the quote asset and are direct account-state observations, not estimates.
- Network transaction fees are distinct from Pump protocol/creator fees. Pump curve fee rates are recorded as documented assumptions for strategy modelling; actual executed quote amounts and fee transfers must be decoded from the specific transaction/event before being treated as exact. Account rent, ATA creation, optional tips and failed-transaction fees must also be counted in a live bot's cost model.

**Important data-quality warning:** the Pump pre-graduation spot price is decoded from bonding-curve virtual reserves in the curve's actual quote asset. It is a curve spot price, not a guaranteed execution quote; fees and slippage affect realized fills. The separate owner-balance-delta trade estimate is low confidence because rent, unrelated SOL transfers, wrapped-SOL routing and multi-leg transactions can distort it. USD conversion uses a public SOL/USD reference endpoint and may be null when unavailable. Market cap is FDV-style (price × total supply), not circulating market cap, and it is not liquidity. Custom quote-mint curves are retained in their quote units; only SOL, USDC and USDT currently receive a USD conversion. This does not yet calculate a trusted USD oracle price for arbitrary custom quote tokens.

The collector does not yet decode PumpSwap/Raydium CPMM pool reserves and LP depth after graduation, LaunchLab pool-state fields or exact LaunchLab/PumpSwap TradeEvents, executable slippage/exit capacity, creator/insider wallet labels, holder concentration excluding pool accounts, or venue-normalized prices. StonkFun pool bytes are retained raw; they are not yet decoded into reserve metrics. Do not use the low-confidence estimated prices as live execution quotes or treat these metrics as verified until compared with known transactions and venue quotes.

## Important limitations of this first cut

1. This is a live collector, not the November 1–23 historical backfill. Historical discovery/backfill is a separate job and must page through archived program activity.
2. Reconciliation recovers missed Pump launch detections after the first checkpoint, in bounded batches. It is not a full historical first-10-minute trade backfill for launches whose capture window expired while the collector was offline. The November 1–23 archive backfill remains a separate unfinished job.
3. Launch detection now uses the Pump create/create_v2 instruction layout and token-program ownership validation. Continue validating against known launch signatures before using the dataset for strategy conclusions.
4. The first-10-minute capture is bounded from the launch transaction timestamp. Delayed indexing can mean a few seconds of initial activity are missed.
5. A mint subscription is not a complete universal trade feed for every venue. Add PumpSwap/Raydium/Orca pool subscriptions and pool-specific decoders as the next step.
6. The collector records raw evidence. It does not yet label snipers/insiders or assert wallet relationships. Those require transaction-graph analysis and cautious heuristics.

## Supported launchpads and data quality

StonkFun currently uses Raydium LaunchLab. The collector recognizes LaunchLab `initialize`, `initialize_v2` and `initialize_with_token_2022`, verifies the LaunchLab program ID and the configured StonkFun platform-config address, then reads base mint (account 6), quote mint (account 7) and pool state (account 5). StonkFun swap prices are currently owner-balance-delta estimates marked low confidence; LaunchLab pool account bytes are retained so the exact account layout can be decoded and validated later. Arbitrary quote tokens remain denominated in their quote asset; USD is left null unless a trusted quote conversion exists.

## Data quality and historical quarantine

The collector validates Pump launches using the exact top-level instruction discriminators from the official Pump IDL (`create` and `create_v2`), then checks that the first instruction account is owned by SPL Token or Token-2022. A generic log word such as `Create` is not launch evidence: associated-token-account creation can appear in unrelated buy transactions.

The Hugging Face dataset includes `quality/data-quality-manifest.json`. Consumers must exclude every mint listed under `quarantinedMints`. When a bad directory is identified, its original JSONL is copied to `quarantine/pumpfun/<MINT>/events.jsonl` and the original `raw/pumpfun/<MINT>/events.jsonl` path is replaced by an exclusion marker. The original bytes are retained for audit rather than silently deleted. The previously stored wrapped-SOL directory is explicitly quarantined because its recorded "launch" transaction is a Pump buy instruction, not a token creation. On startup, existing checkpoint entries are revalidated against their launch signatures before subscriptions resume. A transaction that cannot be fetched remains pending verification and is not used for collection.

Transaction fetches are serialized and rate-limited across configured Helius keys, with exponential backoff on HTTP 429 and signature-level deduplication. This protects the provider quota; if incoming activity exceeds the configured request budget, delayed transaction enrichment is possible and should be monitored.

Run `npm test` to check the strict Pump and StonkFun launch decoders and their false-positive cases. The CI workflow publishes its preflight result to `quality/ci-status.json` in the Hugging Face dataset.

## Setup

Requires Node.js 22+.

```bash
npm install
cp .env.example .env
# Fill in Helius keys in .env
npm run typecheck
npm run dev
```

Never commit `.env` or API keys.

## Data layout

```
data/
  collector-state.json
  tokens/
    <mint>/
      events.jsonl
```

Each JSONL line is an independent event, so partial files survive normal process restarts.

## Free Hugging Face dataset storage

The collector uploads changed token JSONL files and its checkpoint in batches every 30 seconds to a Hugging Face dataset repository. Failed uploads are retained for the next scheduled retry; they do not trigger an unbounded immediate retry loop. Remote checkpoints are schema-validated before they can replace local state.

1. Create a Hugging Face access token with **Write** permission at https://huggingface.co/settings/tokens.
2. Set `HF_TOKEN` in your local `.env` and set `HF_DATASET_REPO=ndeda/solana-scalping-data`.
3. Keep `.env` private and never commit the token.
4. Run `npm install`, `npm run typecheck`, then `npm run dev`.

Uploads are retried on later batches after failures. The collector must remain running and have internet access. This does not make the collector a 24/7 hosted service: on a free setup, run it on your laptop. Hugging Face stores the remote restart checkpoint and token event snapshots. GitHub-hosted runners are ephemeral, so the remote checkpoint and event snapshots are restored at the start of each run.

The dataset is currently configured as `ndeda/solana-scalping-data`. Upload paths use `raw/pumpfun/<MINT>/events.jsonl`. Do not upload `.env`, API keys, or wallet signing secrets.

## Historical window

The requested November 1–23, 2026 period needs an archive backfill. Helius archival RPC can retrieve historical transactions, but scanning the Pump program's entire activity is much heavier than following a known mint. First discover launch signatures/mints for the requested time range, then backfill each selected mint's first 10 minutes. Do not assume a live WebSocket can replay events from earlier dates.

## Next milestones

- Add historical launch discovery and resumable cursor checkpoints.
- Decode Pump create/buy/sell instructions using the official IDL.
- Add non-Pump launchpads and AMM pool migration detection.
- Add quote-mint normalization (SOL, USDC, other SPL tokens).
- Add candidate screening (FDV/market cap, liquidity, trade count, unique buyers, volume).
- Add wallet clustering labels as evidence-based features, not ground-truth "insider" labels.
- Export clean per-token features for offline strategy research.


## GitHub Actions hosted collection

The repository now includes `.github/workflows/live-collector.yml`. It can be started manually from **Actions → Pump.fun live collector → Run workflow**, and it is also scheduled every five hours. Each run collects for 285 minutes, then shuts down and attempts to upload event files and the collector checkpoint to Hugging Face. The next run restores the checkpoint and event files for tokens whose capture windows are still active.

Required GitHub **Actions repository secrets**:
- `HELIUS_API_KEY_1` (required)
- `HF_TOKEN` (required; Hugging Face write token)
- `HELIUS_API_KEY_2` and `HELIUS_API_KEY_3` (optional additional RPC rotation)

GitHub-hosted jobs have a six-hour maximum execution time. Scheduled starts can be delayed, so this is repeated bounded collection, not guaranteed uninterrupted 24/7 streaming. Events occurring during the gap between runs can be missed; remote checkpoints preserve state but do not backfill missed chain activity. Historical backfill, Stonks support, full Pump/PumpSwap trade decoding, and reconciliation are not yet implemented.
