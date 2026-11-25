#!/usr/bin/env python3
"""Import a small, attributed Pump.fun research supplement without mixing it into primary raw records.

The source files are copied byte-for-byte to a separate external_sources/ tree in the user's
Hugging Face dataset. Every file is SHA-256 verified after remote readback. The operation is
resumable: already-present files with matching hashes are skipped.
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

TARGET_REPO = "ndeda/solana-scalping-data"
SOURCE_REPO = "loopholetape/pumpfun-launches"
SOURCE_REVISION = "9b9a04e"
TOKEN = os.environ.get("HF_TOKEN")
if not TOKEN:
    raise SystemExit("HF_TOKEN is missing")

API = HfApi(token=TOKEN)
DAYS = [f"2026-11-{day:02d}" for day in range(1, 6)]
KINDS = ("launches", "features")
TARGET_ROOT = "external_sources/loopholetape-pumpfun-launches"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_sha256(path_in_repo: str):
    if not API.file_exists(repo_id=TARGET_REPO, filename=path_in_repo, repo_type="dataset"):
        return None
    local = hf_hub_download(
        repo_id=TARGET_REPO,
        filename=path_in_repo,
        repo_type="dataset",
        token=TOKEN,
        force_download=True,
    )
    return sha256_file(Path(local))


def upload_verified(local_path: Path, path_in_repo: str, expected_hash: str):
    existing_hash = remote_sha256(path_in_repo)
    if existing_hash == expected_hash:
        print(f"SKIP verified existing {path_in_repo} sha256={expected_hash}")
        return "skipped_existing"

    API.upload_file(
        path_or_fileobj=str(local_path),
        path_in_repo=path_in_repo,
        repo_id=TARGET_REPO,
        repo_type="dataset",
        commit_message=f"Import attributed external Pump.fun supplement: {local_path.name}",
    )
    actual_hash = remote_sha256(path_in_repo)
    if actual_hash != expected_hash:
        raise RuntimeError(
            f"Remote readback hash mismatch for {path_in_repo}: expected {expected_hash}, got {actual_hash}"
        )
    print(f"UPLOADED_AND_VERIFIED {path_in_repo} sha256={actual_hash}")
    return "uploaded_verified"


def main():
    manifest = {
        "schema_version": "1.0.0",
        "imported_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "repo_id": SOURCE_REPO,
            "revision": SOURCE_REVISION,
            "url": f"https://huggingface.co/datasets/{SOURCE_REPO}",
            "author": "loopholetape",
            "license": "CC-BY-4.0",
            "attribution": "Data from loopholetape, pump.fun launches with outcomes, CC BY 4.0.",
        },
        "target_repo_id": TARGET_REPO,
        "target_root": TARGET_ROOT,
        "files": [],
        "use_constraints": [
            "This is external supplemental data, not our primary raw transaction archive.",
            "Do not mark any coin COMPLETE based on these files.",
            "Use decoder_complete=1 for buy-derived fields and rug-related labels.",
            "Separate mayhem launches from classic launches.",
            "Use quote_asset=sol for SOL-denominated comparisons; do not treat other quote assets as SOL.",
            "Null f10/f60 fields mean not sampled, not zero; feature sampling is biased and non-random.",
            "Do not use post-launch outcome columns, model scores, or future flags as entry-time features.",
            "The launches table has a documented recorder gap on 2026-11-01 from 04:42 to 05:33 UTC; it is not a complete independent census.",
            "The features table is joined to outcome labels; enforce point-in-time filtering by t/age_s before any rule analysis.",
            "These files do not contain the full raw transaction-by-transaction first-ten-minute stream required by our primary archive.",
        ],
    }

    for kind in KINDS:
        for day in DAYS:
            source_path = f"data/{kind}/{day}.parquet"
            local = Path(hf_hub_download(
                repo_id=SOURCE_REPO,
                filename=source_path,
                repo_type="dataset",
                revision=SOURCE_REVISION,
            ))
            digest = sha256_file(local)
            target_path = f"{TARGET_ROOT}/{source_path}"
            status = upload_verified(local, target_path, digest)
            manifest["files"].append({
                "source_path": source_path,
                "target_path": target_path,
                "bytes": local.stat().st_size,
                "sha256": digest,
                "status": status,
            })

    readme = """# External Pump.fun research supplement

This directory contains byte-for-byte copies of selected daily Parquet files from
[loopholetape/pumpfun-launches](https://huggingface.co/datasets/loopholetape/pumpfun-launches),
authored by loopholetape and licensed under **CC BY 4.0**.

Attribution: Data from loopholetape, *pump.fun launches with outcomes*, CC BY 4.0.

## Scope

Imported dates: 2026-11-01 through 2026-11-05 inclusive.

- data/launches/: one row per launch with launch metadata, sampled early features,
  and later outcomes.
- data/features/: timestamped feature snapshots and flags joined to outcome labels.

## Important limitations

- This is an external supplement. It is not our own raw transaction archive and does
  not make any primary coin ledger COMPLETE.
- The source documents a recorder coverage gap on 2026-11-01 from 04:42 to 05:33 UTC;
  hundreds of launches may be missing in that interval.
- f10_* and f60_* values are sampled non-randomly. Null means not sampled, not zero.
- decoder_complete must be 1 for buy-derived features and rug-related outcomes.
- Keep mayhem separate from classic launches.
- Use only quote_asset=sol for SOL-denominated analysis.
- Outcomes, future flags, and model scores are labels or later information, not entry-time
  features. Any analysis of features/ must enforce point-in-time use by timestamp.
- The launch table and feature snapshots do not replace transaction signatures, raw
  instructions, fees, reserves, or full first-ten-minute trade observations.

See manifest.json for source revision, file hashes, sizes, and remote verification status.
"""
    manifest_path = f"{TARGET_ROOT}/manifest.json"
    readme_path = f"{TARGET_ROOT}/README.md"
    temp_manifest = Path("external-pumpfun-manifest.json")
    temp_readme = Path("external-pumpfun-README.md")
    temp_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temp_readme.write_text(readme, encoding="utf-8")

    for local, target in ((temp_readme, readme_path), (temp_manifest, manifest_path)):
        digest = sha256_file(local)
        upload_verified(local, target, digest)

    print("EXTERNAL_PUMPFUN_SUPPLEMENT_IMPORT_COMPLETE")
    print(json.dumps({
        "target_repo": TARGET_REPO,
        "files_verified": len(manifest["files"]),
        "source_revision": SOURCE_REVISION,
        "target_root": TARGET_ROOT,
        "manifest_path": manifest_path,
    }, indent=2))


if __name__ == "__main__":
    main()
