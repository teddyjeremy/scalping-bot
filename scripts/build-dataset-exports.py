#!/usr/bin/env python3
"""Build viewer-friendly Parquet exports while preserving the raw historical archive."""
import json
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path("historical-data")
OUT = Path("dataset-export")
OUT.mkdir(parents=True, exist_ok=True)

def read_json(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)

def scalar(value):
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)

launch_rows = []
summary_rows = []
trade_rows = []
failed_rows = []

for path in sorted((ROOT / "launches").glob("*/*.json")):
    if path.name.endswith(".summary.json"):
        continue
    row = read_json(path)
    tx = row.get("transaction") or {}
    launch_rows.append({
        "venue": row.get("venue"), "mint": row.get("mint"),
        "slot": row.get("slot"), "blockTime": row.get("blockTime"),
        "creator": row.get("creator"), "feePayer": row.get("feePayer"),
        "quoteMint": row.get("quoteMint"), "signature": row.get("signature"),
        "observedAt": row.get("observedAt"),
        "feeLamports": tx.get("feeLamports"),
        "computeUnitsConsumed": tx.get("computeUnitsConsumed"),
        "raw_json": json.dumps(row, separators=(",", ":"), ensure_ascii=False),
    })

for path in sorted((ROOT / "launches").glob("*/*.summary.json")):
    row = read_json(path)
    events = row.get("tradeEvents") or {}
    quality = row.get("dataQuality") or {}
    summary_rows.append({
        "venue": row.get("venue"), "mint": row.get("mint"),
        "launchTime": row.get("launchTime"), "launchSlot": row.get("launchSlot"),
        "tradeEventCount": events.get("total", 0),
        "buyCount": events.get("buys", 0), "sellCount": events.get("sells", 0),
        "uniqueBuyers": events.get("uniqueBuyers", 0),
        "uniqueSellers": events.get("uniqueSellers", 0),
        "sourcePageCount": row.get("sourcePageCount", 0),
        "historicalUsdPrice": quality.get("historicalUsdPrice", False),
        "historicalFdv": quality.get("historicalFdv", False),
        "historicalHolderSnapshots": quality.get("historicalHolderSnapshots", False),
        "raw_json": json.dumps(row, separators=(",", ":"), ensure_ascii=False),
    })

for path in sorted((ROOT / "trades").glob("*/*/*.jsonl")):
    with path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            base = {
                "venue": row.get("venue"), "mint": row.get("mint"),
                "signature": row.get("signature"), "slot": row.get("slot"),
                "blockTime": row.get("blockTime"),
                "secondsSinceLaunch": row.get("secondsSinceLaunch"),
                "sourceAddress": row.get("sourceAddress"),
                "transactionFeeLamports": row.get("transactionFeeLamports"),
                "computeUnitsConsumed": row.get("computeUnitsConsumed"),
                "raw_json": json.dumps(row, separators=(",", ":"), ensure_ascii=False),
            }
            if row.get("recordType") == "historical_trade_event":
                trade_rows.append({
                    **base, "side": row.get("side"), "user": row.get("user"),
                    "quoteMint": row.get("quoteMint"),
                    "tokenAmountRaw": row.get("tokenAmountRaw"),
                    "tokenDecimals": row.get("tokenDecimals"),
                    "quoteAmountRaw": row.get("quoteAmountRaw"),
                    "quoteDecimals": row.get("quoteDecimals"),
                    "protocolFeeRaw": row.get("protocolFeeRaw"),
                    "platformFeeRaw": row.get("platformFeeRaw"),
                    "lpFeeRaw": row.get("lpFeeRaw"),
                    "creatorFeeRaw": row.get("creatorFeeRaw"),
                    "shareFeeRaw": row.get("shareFeeRaw"),
                    "impliedQuotePrice": row.get("impliedQuotePrice"),
                })
            elif row.get("recordType") == "historical_failed_transaction":
                failed_rows.append(base)

def write(name, rows, schema):
    table = pa.Table.from_pylist(rows, schema=schema)
    pq.write_table(table, OUT / name, compression="zstd")
    print(f"{name}: {len(rows)} rows")

common = [
    pa.field("venue", pa.string()), pa.field("mint", pa.string()),
    pa.field("slot", pa.int64()), pa.field("blockTime", pa.int64()),
    pa.field("raw_json", pa.string()),
]
write("launches.parquet", launch_rows, pa.schema([
    pa.field("venue", pa.string()), pa.field("mint", pa.string()),
    pa.field("slot", pa.int64()), pa.field("blockTime", pa.int64()),
    pa.field("creator", pa.string()), pa.field("feePayer", pa.string()),
    pa.field("quoteMint", pa.string()), pa.field("signature", pa.string()),
    pa.field("observedAt", pa.string()), pa.field("feeLamports", pa.int64()),
    pa.field("computeUnitsConsumed", pa.int64()), pa.field("raw_json", pa.string()),
]))
write("launch_summaries.parquet", summary_rows, pa.schema([
    pa.field("venue", pa.string()), pa.field("mint", pa.string()),
    pa.field("launchTime", pa.int64()), pa.field("launchSlot", pa.int64()),
    pa.field("tradeEventCount", pa.int64()), pa.field("buyCount", pa.int64()),
    pa.field("sellCount", pa.int64()), pa.field("uniqueBuyers", pa.int64()),
    pa.field("uniqueSellers", pa.int64()), pa.field("sourcePageCount", pa.int64()),
    pa.field("historicalUsdPrice", pa.bool_()), pa.field("historicalFdv", pa.bool_()),
    pa.field("historicalHolderSnapshots", pa.bool_()), pa.field("raw_json", pa.string()),
]))
write("trade_events.parquet", trade_rows, pa.schema([
    pa.field("venue", pa.string()), pa.field("mint", pa.string()),
    pa.field("signature", pa.string()), pa.field("slot", pa.int64()),
    pa.field("blockTime", pa.int64()), pa.field("secondsSinceLaunch", pa.int64()),
    pa.field("sourceAddress", pa.string()), pa.field("transactionFeeLamports", pa.int64()),
    pa.field("computeUnitsConsumed", pa.int64()), pa.field("side", pa.string()),
    pa.field("user", pa.string()), pa.field("quoteMint", pa.string()),
    pa.field("tokenAmountRaw", pa.string()), pa.field("tokenDecimals", pa.int64()),
    pa.field("quoteAmountRaw", pa.string()), pa.field("quoteDecimals", pa.int64()),
    pa.field("protocolFeeRaw", pa.string()), pa.field("platformFeeRaw", pa.string()),
    pa.field("lpFeeRaw", pa.string()), pa.field("creatorFeeRaw", pa.string()),
    pa.field("shareFeeRaw", pa.string()), pa.field("impliedQuotePrice", pa.string()),
    pa.field("raw_json", pa.string()),
]))
write("failed_transactions.parquet", failed_rows, pa.schema([
    pa.field("venue", pa.string()), pa.field("mint", pa.string()),
    pa.field("signature", pa.string()), pa.field("slot", pa.int64()),
    pa.field("blockTime", pa.int64()), pa.field("secondsSinceLaunch", pa.int64()),
    pa.field("sourceAddress", pa.string()), pa.field("transactionFeeLamports", pa.int64()),
    pa.field("computeUnitsConsumed", pa.int64()), pa.field("raw_json", pa.string()),
]))
(OUT / "README.txt").write_text(
    "Queryable exports generated from the raw historical archive. "
    "Raw JSON/JSONL records remain under historical/. "
    "Amounts ending in Raw are integer base units; price is quote asset per whole token. "
    "A summary row may describe a partial capture; consult raw_json and the checkpoint for completeness. "
    "No historical USD price, FDV, or holder snapshot is inferred when unavailable.\\n",
    encoding="utf-8",
)
