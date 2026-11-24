# Solana Scalping Data Collector — Phase 1

This repository contains the first-stage **research data collector**. It does not buy or sell tokens.

## What it currently does

- Watches the Pump program for likely create instructions.
- Fetches confirmed launch transactions through Helius.
- Identifies Pump `create` / `create_v2` transactions from Pump program logs and takes the mint from the first account in the official Pump instruction layout; verifies the account is owned by SPL Token or Token-2022. It does not infer a launch mint from token-balance deltas.
- Creates one folder per mint: `data/tokens/<MINT>/events.jsonl`.
- Captures transactions mentioning that mint for up to the configured first 10 minutes.
- Stores the launch transaction fee payer separately. Creator identity is left null until decoded from authoritative launch-event data; fee payer is not silently labelled as creator.
- Persists state and a remote Hugging Face checkpoint, restores active token event files, and saves a Pump-program signature cursor. On later runs it reconciles missed program transactions in bounded pages and saves its page cursor so reconciliation can resume.
- Rotates transaction-fetch requests across up to three Helius API keys.

## Market, price and trading metrics (schema version 3)

For each newly detected Pump mint, the collector now attempts to store the mint supply and records derived trade observations and timed market snapshots alongside the raw transaction evidence.

Current derived fields include:
- Pump bonding-curve spot price in SOL and USD from the curve account virtual reserves, plus price change from the first observed curve price. A separate low-confidence wallet-balance-delta estimate is retained for trade-level cross-checking.
- FDV-style market capitalization in SOL and USD (bonding-curve spot price multiplied by on-chain total supply; this is not circulating market cap).
- Timed snapshots at 5, 10, 15, 30, 60, 120, 300 and 600 seconds after launch.
- Buy/sell observation counts, estimated SOL/USD volume, unique observed buyers and sellers.
- Highest/lowest observed USD price, maximum observed drawdown, largest observed buy/sell size, and time to 1.2x, 1.5x, 1.7x and 2x from the first observed USD price.
- Bonding-curve virtual and real SOL/token reserves, completion status, quote mint, and creator field when present in the curve account.
- Raw transaction balances, token balances, logs, fees, slot and signature remain available for re-analysis.

**Important data-quality warning:** the current price calculation is a conservative owner-balance-delta estimate, not a decoded Pump bonding-curve or PumpSwap execution price. Rent, unrelated SOL transfers, wrapped-SOL routing and multi-leg transactions can distort it. Each derived trade is labelled with its pricing method and low confidence. USD conversion uses a public SOL/USD reference endpoint and may be null when that endpoint is unavailable. Market cap is FDV-style (price × total supply), not circulating market cap, and it is not liquidity.

The collector does not yet calculate PumpSwap pool reserves/LP depth after graduation, executable slippage/exit capacity, creator/insider wallet labels, holder concentration excluding pool accounts, or venue-normalized prices. Those require venue-specific instruction and account decoders. Do not use the low-confidence estimated prices as live execution quotes or treat these metrics as verified until compared with known transactions and venue quotes.

## Important limitations of this first cut

1. This is a live collector, not the November 1–23 historical backfill. Historical discovery/backfill is a separate job and must page through archived program activity.
2. Reconciliation recovers missed Pump launch detections after the first checkpoint, in bounded batches. It is not a full historical first-10-minute trade backfill for launches whose capture window expired while the collector was offline. The November 1–23 archive backfill remains a separate unfinished job.
3. Launch detection now uses the Pump create/create_v2 instruction layout and token-program ownership validation. Continue validating against known launch signatures before using the dataset for strategy conclusions.
4. The first-10-minute capture is bounded from the launch transaction timestamp. Delayed indexing can mean a few seconds of initial activity are missed.
5. A mint subscription is not a complete universal trade feed for every venue. Add PumpSwap/Raydium/Orca pool subscriptions and pool-specific decoders as the next step.
6. The collector records raw evidence. It does not yet label snipers/insiders or assert wallet relationships. Those require transaction-graph analysis and cautious heuristics.

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
