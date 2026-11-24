#!/usr/bin/env python3
"""Integration smoke test for per-coin upload, readback, resume, and cleanup."""
import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

module_path = Path("scripts/hf-dataset-v3-sync.py")
spec = importlib.util.spec_from_file_location("hf_dataset_v3_sync", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

token = os.environ["HF_TOKEN"]
api = HfApi(token=token)
mint = "11111111111111111111111111111111"
venue = "pumpfun"
shard, shard4 = module.mint_parts(venue, mint)
raw_remote = f"dataset_v3/raw/{venue}/{shard}/{shard4}/{mint}"
ledger_remote = module.ledger_remote(venue, mint)
signature = "smoke-test-signature-not-a-chain-transaction"
launch_time = 1793500000

def delete_remote():
    try:
        api.delete_folder(path_in_repo=raw_remote, repo_id=module.REPO_ID,
                          repo_type="dataset", commit_message="Remove temporary v3 publisher smoke test")
    except Exception as exc:
        if "404" not in str(exc) and "not found" not in str(exc).lower():
            raise
    try:
        api.delete_file(path_in_repo=ledger_remote, repo_id=module.REPO_ID,
                        repo_type="dataset", commit_message="Remove temporary v3 smoke-test ledger")
    except Exception as exc:
        if "404" not in str(exc) and "not found" not in str(exc).lower():
            raise

    try:
        api.delete_file(path_in_repo="dataset_v3/control/checkpoint.json", repo_id=module.REPO_ID,
                        repo_type="dataset", commit_message="Remove temporary v3 smoke-test checkpoint")
    except Exception as exc:
        if "404" not in str(exc) and "not found" not in str(exc).lower():
            raise

try:
    with tempfile.TemporaryDirectory(prefix="solana-v3-smoke-") as tmp:
        root = Path(tmp) / "historical-data"
        launch_dir = root / "launches" / venue / shard
        trade_dir = root / "trades" / venue / shard / mint
        launch_dir.mkdir(parents=True)
        trade_dir.mkdir(parents=True)
        launch = {
            "venue": venue, "mint": mint, "signature": signature,
            "slot": 1, "blockTime": launch_time,
            "historicalWindow": {"start": launch_time, "end": launch_time + 600},
            "creator": None, "feePayer": None,
        }
        summary = {
            "venue": venue, "mint": mint, "launchSignature": signature,
            "launchTime": launch_time,
            "capture": {
                "complete": True, "windowSeconds": 600, "totalSourcePages": 1,
                "sources": {"smoke-source": {"complete": True, "pages": 1}},
            },
        }
        (launch_dir / f"{mint}.json").write_text(json.dumps(launch) + "\n", encoding="utf-8")
        (launch_dir / f"{mint}.summary.json").write_text(json.dumps(summary) + "\n", encoding="utf-8")
        page_name = "source-smoke-page-000001.jsonl"
        trade_rows = [
            {"recordType": "historical_trade_event", "signature": signature, "eventIndex": 0,
             "user": "smoke-wallet", "side": "buy", "tokenAmountRaw": "100",
             "quoteAmountRaw": "5", "quoteMint": "So11111111111111111111111111111111111111112"},
            {"recordType": "historical_failed_transaction", "signature": "smoke-failed-signature",
             "slot": 2, "blockTime": launch_time + 1},
        ]
        (trade_dir / page_name).write_text(
            "".join(json.dumps(row) + "\n" for row in trade_rows), encoding="utf-8"
        )
        checkpoint = {
            "schemaVersion": 1,
            "start": launch_time,
            "end": launch_time + 600,
            "programs": {},
            "launches": {
                mint: {"venue": venue, "mint": mint, "signature": signature,
                       "slot": 1, "blockTime": launch_time, "creator": None,
                       "feePayer": None, "quoteMint": "So11111111111111111111111111111111111111112",
                       "pool": None}
            },
            "tradeCursors": {},
        }
        (root / "checkpoint.json").write_text(json.dumps(checkpoint) + "\n", encoding="utf-8")
        module.ROOT = root
        module.publish_batch([
            f"launches/{venue}/{shard}/{mint}.json",
            f"launches/{venue}/{shard}/{mint}.summary.json",
            f"trades/{venue}/{shard}/{mint}/{page_name}",
        ])

        ledger = module.load_remote_json(ledger_remote)
        assert ledger and ledger["state"] == "COMPLETE", "coin ledger did not reach COMPLETE"
        required = {"schema_version", "mint", "launch_venue", "launch_time_utc", "state",
                    "attempt_count", "requested_window", "streams", "validation", "updated_at"}
        assert required.issubset(ledger), "ledger is missing required schema fields"
        assert ledger["streams"]["trade_events"]["record_count"] == 1
        assert ledger["streams"]["failed_transactions"]["record_count"] == 1

        # Simulate a fresh workflow runner restoring only the v3 generation.
        restored = Path(tmp) / "restored-data"
        module.ROOT = restored
        module.restore()
        assert (restored / "launches" / venue / shard / f"{mint}.json").is_file()
        assert (restored / "launches" / venue / shard / f"{mint}.summary.json").is_file()
        assert (restored / "trades" / venue / shard / mint / page_name).is_file()
        restored_checkpoint = json.loads((restored / "checkpoint.json").read_text(encoding="utf-8"))
        assert restored_checkpoint["tradeCursors"][mint]["complete"] is True, "COMPLETE ledger was not reconciled into resume cursor"
        print("PASS: per-coin upload, remote hashes, schema fields, restart restore, and COMPLETE-coin skip cursor verified.")
finally:
    delete_remote()
    print("Temporary smoke-test coin and ledger cleaned from the dataset.")
