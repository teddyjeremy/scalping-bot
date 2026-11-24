# Solana Scalping Data Collector — Phase 1

This repository contains the first-stage **research data collector**. It does not buy or sell tokens.

## What it currently does

- Watches the Pump program for likely create instructions.
- Fetches confirmed launch transactions through Helius.
- Detects newly created mints from transaction token-balance metadata.
- Creates one folder per mint: `data/tokens/<MINT>/events.jsonl`.
- Captures transactions mentioning that mint for up to the configured first 10 minutes.
- Stores creator (launch transaction fee payer), signature, slot, logs, account keys, SOL/token balance changes and inner instructions.
- Persists a local state file so active token subscriptions can be restored after a process restart **when the same persistent disk is retained**.
- Rotates transaction-fetch requests across up to three Helius API keys.

## Important limitations of this first cut

1. This is a live collector, not the November 1–23 historical backfill. Historical discovery/backfill is a separate job and must page through archived program activity.
2. A process restart can restore active subscriptions from the state file, but it cannot recover transactions missed while offline yet. A checkpointed backfill/reconciliation worker is required before calling collection restart-safe.
3. Pump program log matching and token-mint extraction are initial heuristics. Validate against known launch transactions and add the current Pump IDL decoder before using the dataset for strategy conclusions.
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

The collector can upload changed token JSONL files in batches every 30 seconds to a Hugging Face dataset repository. It uses the official `@huggingface/hub` JavaScript client. The local `data/` directory remains the working buffer and checkpoint store; Hugging Face receives snapshots of each token's event file.

1. Create a Hugging Face access token with **Write** permission at https://huggingface.co/settings/tokens.
2. Set `HF_TOKEN` in your local `.env` and set `HF_DATASET_REPO=ndeda/solana-scalping-data`.
3. Keep `.env` private and never commit the token.
4. Run `npm install`, `npm run typecheck`, then `npm run dev`.

Uploads are retried on later batches after failures. The collector must remain running and have internet access. This does not make the collector a 24/7 hosted service: on a free setup, run it on your laptop. The local `data/` directory must be backed up because Hugging Face is the remote dataset copy, not the live collector's restart checkpoint.

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
