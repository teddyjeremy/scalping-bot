#!/usr/bin/env python3
"""One-time approved reset of the old Solana dataset generation."""
import json
import os
from io import BytesIO
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

repo_id = "ndeda/solana-scalping-data"
token = os.environ.get("HF_TOKEN")
if not token:
    raise SystemExit("HF_TOKEN is missing; refusing to reset the dataset.")
api = HfApi(token=token)

# Only collected-data directories are removed. Repository metadata and the
# dataset repository itself are preserved.
for folder in ("historical", "historical-v2", "data"):
    try:
        api.delete_folder(
            path_in_repo=folder,
            repo_id=repo_id,
            repo_type="dataset",
            commit_message=f"Fresh Solana dataset v3 reset: remove legacy {folder}",
        )
        print(f"Deleted legacy dataset folder: {folder}")
    except HfHubHTTPError as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 404 or "not found" in str(exc).lower():
            print(f"Legacy folder already absent: {folder}")
        else:
            raise

config_path = Path("config/collection-v3.json")
config = json.loads(config_path.read_text(encoding="utf-8"))
schema_version = {
    "schema_version": "3.0.0",
    "generation": "dataset_v3",
    "status": "empty_ready_for_validation",
    "created_by": "approved-clean-reset",
}
manifest = {
    "schema_version": "3.0.0",
    "generation": "dataset_v3",
    "collection_status": "NOT_STARTED",
    "collection_window": config["collection_window"],
    "venues": [v["launch_venue"] for v in config["venues"]],
    "discovered_coins": 0,
    "complete_coins": 0,
    "partial_coins": 0,
    "last_updated_utc": None,
}
readme = """---
license: mit
pretty_name: Solana Launch and Trade Research Dataset v3
---

# Solana launch and trade research dataset

Fresh v3 generation for historical deterministic scalping-rule research.

- Collection window: 2026-11-01 through 2026-11-23 UTC (end exclusive 2026-11-24).
- Launch venues: Pump.fun and StonkFun / Raydium LaunchLab.
- Observation target: first 600 seconds after each launch.
- Entry research window: +30 to +300 seconds.
- FDV $5,000–$10,000 is an analysis cohort, never a collection filter.
- Raw observations, derived metrics, coin ledgers and exports are stored separately.
- A coin is marked COMPLETE only after its files pass remote readback hash verification.
- No live trading, transaction signing or AI-generated trading decisions.

See the GitHub repository for the v3 schema and collection specification.
"""

def upload(path, payload, message):
    api.upload_file(
        path_or_fileobj=BytesIO(payload),
        path_in_repo=path,
        repo_id=repo_id,
        repo_type="dataset",
        commit_message=message,
    )
    print(f"Created {path} ({len(payload)} bytes)")

upload("dataset_v3/dataset_info/schema_version.json",
       (json.dumps(schema_version, indent=2) + "\n").encode(),
       "Initialize clean Solana dataset v3 schema")
upload("dataset_v3/dataset_info/collection_config.json",
       (json.dumps(config, indent=2) + "\n").encode(),
       "Initialize clean Solana dataset v3 configuration")
upload("dataset_v3/control/manifest.json",
       (json.dumps(manifest, indent=2) + "\n").encode(),
       "Initialize empty Solana dataset v3 manifest")
upload("README.md", readme.encode(),
       "Document fresh Solana dataset v3 generation")
print("Dataset reset and v3 skeleton initialization completed.")
