# Solana Historical Data Collection v3

Status: DESIGN ONLY. The old collector remains paused until implementation and the acceptance tests pass.

## 1. Scope and sampling

- UTC interval: 2026-11-01 00:00:00 inclusive through 2026-11-24 00:00:00 exclusive.
- Launch venues: Pump.fun and StonkFun (Raydium LaunchLab). PumpSwap is tracked as a distinct post-migration execution venue, not a launch origin.
- Discover the complete launch universe. Do not select only surviving, liquid, successful, or popular tokens.
- For each discovered mint, attempt the first 600 seconds after launch. Record exact coverage and gaps.
- FDV $5,000–$10,000 is a research cohort label, not a discovery filter. Retain all launches and record every observed FDV crossing and timestamp.
- Entry research window: +30s to +300s. Exit/risk research continues to +600s.
- No live trading, signing, or wallet transactions.

## 2. Dataset layout

All new data lives under dataset_v3. Do not merge old historical/ or historical-v2/ data into this generation.

- dataset_v3/dataset_info/: schema_version.json, collection_config.json, source_registry.json
- dataset_v3/control/: manifest.json, discovery/, run_logs/, ledger/
- dataset_v3/control/discovery/{venue}/YYYY-MM-DD/part-NNNNN.jsonl.gz
- dataset_v3/control/ledger/{venue}/{mint-prefix-2}/{mint-prefix-4}/{mint}.json
- dataset_v3/raw/{venue}/{mint-prefix-2}/{mint-prefix-4}/{mint}/
- Per-coin files: launch.json, transactions/part-NNNNN.jsonl.gz, trade_events/part-NNNNN.jsonl.gz, price_snapshots/part-NNNNN.jsonl.gz, curve_or_pool_state/part-NNNNN.jsonl.gz, wallet_activity/part-NNNNN.jsonl.gz, holder_snapshots/part-NNNNN.jsonl.gz, fee_records/part-NNNNN.jsonl.gz, failed_transactions/part-NNNNN.jsonl.gz, coverage.json, validation.json
- dataset_v3/derived/metrics/ and risk_events/ partitioned by venue and launch date, stored as Parquet.
- dataset_v3/exports/ contains consolidated Parquet tables.

Mint sharding is deterministic. Files use deterministic part names and stable event keys. Never append duplicate rows blindly. Raw observations and derived calculations remain separate.

## 3. Required raw record fields

Every transaction observation must carry mint, venue, source, transaction signature, slot, UTC block time, success flag, signer/fee payer when known, relevant accounts, program/instruction identifiers, raw provider payload or stable reference, ingestion time, source page/cursor, and parser version.

Every decoded trade must carry transaction signature plus instruction/event index as its stable key, mint, venue/pool/curve, buyer/seller when decoded, side, token amount, SOL amount, execution price, fee components with units/provenance, block time, slot, decode status, and source transaction key.

Never fabricate signatures, timestamps, wallet identities, prices, or USD conversions. Unknowns are null with reason codes. A provider timeout is not zero trading activity.

## 4. Venue-specific rules

### Pump.fun
- Preserve launch instruction/signature, mint, creator, curve account, curve state and reserves.
- Record virtual and real reserves separately, with source and units.
- Record graduation/migration timestamp and destination pool.
- After migration, track actual execution pool state separately; never label pool liquidity as bonding-curve reserves.

### StonkFun / Raydium LaunchLab
- Preserve launchpad identity, launch transaction, mint, pool/curve accounts, token/quote mints and decimals.
- Record LaunchLab curve state before migration and actual Raydium pool state after migration.
- LP lock/burn is verified only with authoritative on-chain lock/burn state or a verifiable transaction. Otherwise mark unknown.

### Shared
- Preserve native SOL quote amounts. USD conversion requires a named source and timestamp, stored separately.
- Keep network base fee, priority fee, platform fee, creator fee and pool fee separate when available.
- Do not infer historical holder snapshots from current holder data.

## 5. Ledger and state machine

There is one authoritative ledger JSON per mint. States:
DISCOVERED -> QUEUED -> COLLECTING -> VALIDATING -> PUBLISHING -> COMPLETE.
Recoverable states: RETRY, INCOMPLETE, DATA_UNAVAILABLE. REJECTED requires an explicit reason.

Ledger fields include mint, launch venue/time/signature, discovery source, state, attempt count, lease owner/expiry, requested and actual coverage windows, coverage/gap seconds, per-source cursors/pages, per-stream counts, distinct signatures, duplicate counts, missing categories, validation result, dataset paths, content hashes, Hugging Face commit id, published time, last error, retry time and update time.

Only one coordinator may mutate the ledger. Workers return immutable results. A lease prevents duplicate collection of the same mint.

## 6. Completion and validation

A coin is COMPLETE only when:
1. Launch identity/time are verified.
2. Ten-minute coverage is complete, or all gaps are explicitly measured and explained.
3. Every collected transaction has a valid signature and source provenance.
4. Pagination is exhausted to the window boundary and cursors are monotonic.
5. Duplicate signature/event-key checks pass.
6. Timestamp, mint, venue, decimals and units validate.
7. Curve/pool safety state is labelled verified, unverified, unknown or unavailable.
8. Every stream has counts and coverage metadata.
9. Uploaded files are read back and hashes/counts match.
10. Only then does the coordinator commit COMPLETE.

Validation levels: COMPLETE, PARTIAL, METADATA_ONLY, INVALID. Partial and metadata-only coins never count as complete. Historical metrics unavailable from the source remain unavailable; never fabricate them.

## 7. Per-coin upload transaction

1. Write all outputs to a local staging folder.
2. Validate schema, signatures, timestamps, keys, counts and hashes.
3. Upload only that coin's deterministic folder to dataset_v3/raw.
4. Read back the remote files and verify hashes, sizes and counts.
5. Update ledger to PUBLISHING with the returned commit id.
6. Mark COMPLETE only after remote verification.
7. On interruption, re-read remote files and resume idempotently. Never advance completion or source cursors ahead of published data.

Fetch workers may run concurrently. One coordinator serializes Hugging Face commits and ledger mutations. Each Helius key has independent cooldown on rate limits; healthy keys continue.

## 8. Discovery and bias controls

- Discover independently by venue and UTC day, preserving source pagination.
- Canonical identity is mint plus launch venue and launch signature; never deduplicate by symbol/name.
- Keep unsuccessful and low-volume launches. Record creator/project clusters as features, not exclusions.
- Reconcile discovered counts against source pagination totals before declaring a day complete.
- Record data-source limitations and coverage gaps.

## 9. Derived research metrics

Every derived value stores formula version and input references. Research candidates include rolling buy/sell volume and ratios (1s, 5s, 15s, 30s, 60s), unique buyers/sellers, buyer growth, trade frequency, median size, creator net flow, early-buyer timing, same-slot concentration, wallet-funding/cluster signals, top-holder concentration when snapshots exist, reserve changes, price impact, liquidity/market-cap ratio, failed buy/sell rates, fee burden, slippage, drawdown, rebound, momentum deterioration and adverse/favourable excursion.

Timing heuristics do not prove a wallet is a bot or sniper. Store evidence and confidence separately.

## 10. Acceptance gates

Before backfill, one known launch from each venue must pass launch resolution, signature completeness, ten-minute collection or explicit provider limitation, event deduplication, raw/derived reconciliation, per-coin upload, remote readback hash/count match, and restart-without-duplicates testing.

Then test a small sample (10 coins per venue), inspect quality, and only then run the full November 1–23 backfill.

## 11. Non-goals

No AI trading decisions, live trading, transaction signing or profitability claims. Any future rules must be tested with realistic fees, slippage, latency and survivorship-bias controls.
