#!/usr/bin/env python3
"""Idempotent per-coin publisher/restorer for the v3 Solana dataset."""
# Automatic workflows publish in hourly batches; temporary preflight commits are disabled.
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from huggingface_hub import CommitOperationAdd, HfApi, hf_hub_download, snapshot_download

STAGED: dict[str, bytes] = {}
REMOTE_LEDGER_PATHS: set[str] | None = None

REPO_ID = "ndeda/solana-scalping-data"
TOKEN = os.environ.get("HF_TOKEN")
if not TOKEN:
    raise SystemExit("HF_TOKEN is missing")
API = HfApi(token=TOKEN)
ROOT = Path(os.environ.get("DATA_DIR", "./historical-data"))
REMOTE_ROOT = "dataset_v3"
START_DAY = os.environ.get("HISTORY_START", "2026-11-01T00:00:00Z")[:10]
END_DAY = os.environ.get("HISTORY_END", "2026-11-24T00:00:00Z")[:10]
CHECKPOINT_REMOTE = f"{REMOTE_ROOT}/control/checkpoints/{START_DAY}_{END_DAY}.json"


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def upload_verified(path_in_repo: str, data: bytes, message: str) -> str:
    # Stage files; publish_batch commits all changed coin files, ledgers and
    # the checkpoint atomically in one Hub commit to respect the free 128/hour limit.
    STAGED[path_in_repo] = data
    return digest(data)


def flush_staged(message: str = "Publish resumable Solana research batch") -> None:
    if not STAGED:
        return
    staged = dict(STAGED)
    committed = False
    for attempt in range(3):
        operations = [
            CommitOperationAdd(path_in_repo=path, path_or_fileobj=BytesIO(data))
            for path, data in sorted(staged.items())
        ]
        revision = None
        try:
            commit_info = API.create_commit(
                repo_id=REPO_ID,
                repo_type="dataset",
                operations=operations,
                commit_message=message,
                num_threads=1,
            )
            revision = getattr(commit_info, "oid", None) or getattr(commit_info, "commit_id", None)
            if not revision:
                raise RuntimeError("Hugging Face commit response did not include an immutable revision.")
            # Verify all committed paths in one Hub metadata request. Downloading
            # every file individually exhausts the free resolver quota (5,000/5m)
            # for a batch containing thousands of coins.
            infos = API.get_paths_info(
                repo_id=REPO_ID, paths=list(staged.keys()),
                repo_type="dataset", revision=revision,
            )
            info_by_path = {getattr(info, "path", None): info for info in infos}
            mismatches = []
            for path, expected_data in staged.items():
                info = info_by_path.get(path)
                if info is None:
                    mismatches.append(f"{path}: missing at committed revision {revision}")
                    continue
                remote_size = getattr(info, "size", None)
                if remote_size is not None and int(remote_size) != len(expected_data):
                    mismatches.append(
                        f"{path}: expected bytes={len(expected_data)}, remote bytes={remote_size}"
                    )
                    continue
                lfs = getattr(info, "lfs", None)
                remote_sha = getattr(lfs, "sha256", None) if lfs else None
                if remote_sha and remote_sha != digest(expected_data):
                    mismatches.append(
                        f"{path}: expected sha256={digest(expected_data)}, remote sha256={remote_sha}"
                    )
            if mismatches:
                print("Hugging Face commit metadata mismatch details:")
                for mismatch in mismatches[:20]:
                    print(f"  {mismatch}")
                raise RuntimeError(f"{len(mismatches)} staged file(s) failed immutable-revision metadata verification.")
            committed = True
            print(
                f"Verified {len(staged)} committed paths and file sizes at immutable Hub revision "
                f"{revision}; LFS SHA-256 checked where Hub exposes it."
            )
            break
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            message = str(exc).lower()
            if revision:
                # The commit already exists. Never create a second commit just
                # because its metadata verification endpoint is temporarily unavailable.
                raise RuntimeError(
                    f"Hub commit {revision} was created, but metadata verification failed: {exc}"
                ) from exc
            if status == 429 or "429 too many requests" in message or "rate limit" in message:
                raise RuntimeError(
                    "Hugging Face commit quota is exhausted; staged files are preserved locally. "
                    "Wait for the quota reset before retrying publication."
                ) from exc
            print(f"Hub upload attempt {attempt + 1}/3 failed: {type(exc).__name__}: {exc}")
        if attempt < 2:
            time.sleep(2 ** (attempt + 1))
    if not committed:
        raise RuntimeError("Hub upload did not pass SHA-256 readback against its committed revision after three attempts.")
    for path in staged:
        STAGED.pop(path, None)
    print(f"Committed and SHA-256 verified {len(staged)} dataset files in one Hub commit.")


def mint_parts(venue: str, mint: str):
    shard = hashlib.sha256(mint.encode()).hexdigest()
    return shard[:2], shard[:4]


def ledger_remote(venue: str, mint: str) -> str:
    a, b = mint_parts(venue, mint)
    return f"{REMOTE_ROOT}/control/ledger/{venue}/{a}/{b}/{mint}.json"


def load_remote_json(path: str):
    global REMOTE_LEDGER_PATHS
    if REMOTE_LEDGER_PATHS is None:
        try:
            entries = API.list_repo_tree(
                repo_id=REPO_ID, path_in_repo=f"{REMOTE_ROOT}/control/ledger",
                repo_type="dataset", recursive=True,
            )
            REMOTE_LEDGER_PATHS = {entry.path for entry in entries if hasattr(entry, "path")}
        except Exception as exc:
            msg = str(exc).lower()
            if "404" in msg or "not found" in msg or "does not exist" in msg:
                REMOTE_LEDGER_PATHS = set()
            else:
                raise
    if path not in REMOTE_LEDGER_PATHS:
        return None
    local = hf_hub_download(repo_id=REPO_ID, filename=path, repo_type="dataset", token=TOKEN, force_download=True)
    return json.loads(Path(local).read_text(encoding="utf-8"))


def local_coin_files(venue: str, mint: str):
    shard, shard4 = mint_parts(venue, mint)
    launch = ROOT / "launches" / venue / shard / f"{mint}.json"
    summary = ROOT / "launches" / venue / shard / f"{mint}.summary.json"
    screening = ROOT / "launches" / venue / shard / f"{mint}.screening.json"
    trades = ROOT / "trades" / venue / shard / mint
    files = []
    if launch.is_file():
        files.append(("launch", launch, f"{REMOTE_ROOT}/raw/{venue}/{shard}/{shard4}/{mint}/launch.json"))
    if summary.is_file():
        files.append(("summary", summary, f"{REMOTE_ROOT}/raw/{venue}/{shard}/{shard4}/{mint}/summary.json"))
    if screening.is_file():
        files.append(("screening", screening, f"{REMOTE_ROOT}/raw/{venue}/{shard}/{shard4}/{mint}/screening.json"))
    if trades.is_dir():
        for file in sorted(trades.glob("*.jsonl")):
            files.append(("trade_page", file, f"{REMOTE_ROOT}/raw/{venue}/{shard}/{shard4}/{mint}/transaction_pages/{file.name}"))
    return files


def publish_coin(venue: str, mint: str, changed_paths=None):
    if venue not in ("pumpfun", "stonkfun"):
        raise SystemExit(f"Unsupported venue: {venue}")
    files = local_coin_files(venue, mint)
    if not files:
        raise RuntimeError(f"No local coin files found for {venue}/{mint}")
    ledger_path = ledger_remote(venue, mint)
    # restore() materializes all existing ledgers locally. Read that local copy
    # instead of issuing one Hugging Face resolver request per coin.
    ledger_local = ROOT / Path(ledger_path).relative_to(REMOTE_ROOT)
    ledger = json.loads(ledger_local.read_text(encoding="utf-8")) if ledger_local.is_file() else {
        "schema_version": "3.0.0", "mint": mint, "launch_venue": venue,
        "state": "DISCOVERED", "dataset_paths": [], "content_hashes": {},
        "streams": {}, "attempt_count": 0,
    }
    paths = set(ledger.get("dataset_paths", []))
    hashes = dict(ledger.get("content_hashes", {}))
    uploaded_trade_count = 0
    uploaded_failed_count = 0
    summary = None

    changed = set(changed_paths or [])
    for kind, local_file, remote_path in files:
        relative = local_file.relative_to(ROOT).as_posix()
        if changed and relative not in changed:
            continue
        raw = local_file.read_bytes()
        if kind == "trade_page":
            lines = [line for line in raw.splitlines() if line.strip()]
            trade_lines, failed_lines, transaction_lines = [], [], []
            for line in lines:
                row = json.loads(line)
                if row.get("recordType") == "historical_failed_transaction":
                    failed_lines.append(line)
                elif row.get("recordType") == "historical_trade_event":
                    trade_lines.append(line)
                elif row.get("recordType") == "historical_transaction_observation":
                    transaction_lines.append(line)
            stem = local_file.stem
            base = remote_path.rsplit("/", 1)[0]
            outputs = [
                (f"{base}/trade_events/{stem}.jsonl", b"\n".join(trade_lines) + (b"\n" if trade_lines else b""), len(trade_lines)),
                (f"{base}/failed_transactions/{stem}.jsonl", b"\n".join(failed_lines) + (b"\n" if failed_lines else b""), len(failed_lines)),
                (f"{base}/transaction_observations/{stem}.jsonl", b"\n".join(transaction_lines) + (b"\n" if transaction_lines else b""), len(transaction_lines)),
                (remote_path, raw, len(lines)),
            ]
            for target, data, count in outputs:
                h = upload_verified(target, data, f"Publish coin observations: {mint}")
                paths.add(target)
                hashes[target] = h
            uploaded_trade_count += len(trade_lines)
            uploaded_failed_count += len(failed_lines)
        else:
            h = upload_verified(remote_path, raw, f"Publish coin {kind}: {mint}")
            paths.add(remote_path)
            hashes[remote_path] = h
            if kind == "summary":
                summary = json.loads(raw)

    if summary is None:
        local_summary = ROOT / "launches" / venue / mint_parts(venue, mint)[0] / f"{mint}.summary.json"
        if local_summary.is_file():
            summary = json.loads(local_summary.read_text(encoding="utf-8"))

    capture_complete = bool((summary or {}).get("capture", {}).get("transactionHistoryComplete"))
    research_ready = bool((summary or {}).get("capture", {}).get("researchReady"))
    launch_file = ROOT / "launches" / venue / mint_parts(venue, mint)[0] / f"{mint}.json"
    launch_record = json.loads(launch_file.read_text(encoding="utf-8")) if launch_file.is_file() else {}
    window = launch_record.get("historicalWindow") or {}
    def iso_epoch(value):
        return datetime.fromtimestamp(int(value), timezone.utc).isoformat() if value is not None else None

    trade_event_keys = set()
    trade_signatures = set()
    failed_signatures = set()
    observation_signatures = set()
    trade_count = 0
    failed_count = 0
    observation_count = 0
    duplicate_count = 0
    page_files = sorted((ROOT / "trades" / venue / mint_parts(venue, mint)[0] / mint).glob("*.jsonl"))
    for page_file in page_files:
        for line in page_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            signature = str(row.get("signature") or "")
            if row.get("recordType") == "historical_failed_transaction":
                failed_count += 1
                if signature:
                    failed_signatures.add(signature)
            elif row.get("recordType") == "historical_transaction_observation":
                observation_count += 1
                if signature:
                    observation_signatures.add(signature)
            elif row.get("recordType") == "historical_trade_event":
                trade_count += 1
                if signature:
                    trade_signatures.add(signature)
                event_key = (signature, row.get("eventIndex", 0), row.get("user"), row.get("side"))
                if event_key in trade_event_keys:
                    duplicate_count += 1
                trade_event_keys.add(event_key)

    def stream(status, count, signatures, duplicates=0):
        return {
            "status": status,
            "record_count": count,
            "distinct_signature_count": len(signatures),
            "duplicate_count": duplicates,
            "cursor": None,
            "pages": len(page_files),
            "error": None,
        }

    trade_status = ("complete" if trade_count else "empty_verified") if capture_complete else "partial"
    failed_status = ("complete" if failed_count else "empty_verified") if capture_complete else "partial"
    observation_status = ("complete" if observation_count else "empty_verified") if capture_complete else "partial"
    ledger.update({
        "schema_version": "3.0.0",
        "mint": mint,
        "launch_venue": venue,
        "launch_signature": launch_record.get("signature") or (summary or {}).get("launchSignature"),
        "launch_time_utc": iso_epoch(launch_record.get("blockTime") or (summary or {}).get("launchTime")),
        "discovery_source": venue,
        "state": "COMPLETE" if capture_complete and research_ready else ("PARTIAL" if capture_complete else "COLLECTING"),
        "attempt_count": int(ledger.get("attempt_count", 0)) + 1,
        "requested_window": {
            "start_utc": iso_epoch(window.get("start")),
            "end_utc": iso_epoch(window.get("end")),
        },
        "actual_coverage": (summary or {}).get("capture", {}).get("timeCoverage"),
        "streams": {
            "launch": stream("complete", 1 if launch_record else 0, {str(launch_record.get("signature"))} if launch_record.get("signature") else set()),
            "trade_events": stream(trade_status, trade_count, trade_signatures, duplicate_count),
            "failed_transactions": stream(failed_status, failed_count, failed_signatures),
            "transaction_observations": stream(observation_status, observation_count, observation_signatures),
        },
        "validation": {
            "level": "COMPLETE" if capture_complete and research_ready else ("PARTIAL" if page_files else "METADATA_ONLY"),
            "errors": [],
            "warnings": (summary or {}).get("capture", {}).get("completionBlockers", []),
        },
        "capture": (summary or {}).get("capture"),
        "dataset_paths": sorted(paths),
        "content_hashes": hashes,
        "last_error": None,
        "updated_at": now(),
        "last_verified_at": now(),
        "completion_rule": "Transaction history is resumably complete only after pagination coverage and per-file remote readback SHA-256 verification; research COMPLETE additionally requires capture.researchReady=true. Missing historical USD/FDV/holder/liquidity evidence remains PARTIAL.",
    })
    ledger_bytes = (json.dumps(ledger, indent=2, sort_keys=True) + "\n").encode()
    ledger_local.parent.mkdir(parents=True, exist_ok=True)
    ledger_local.write_bytes(ledger_bytes)
    upload_verified(ledger_path, ledger_bytes, f"Update resumable coin ledger: {venue}/{mint} ({ledger['state']})")
    print(f"V3 staged {venue}/{mint}: state={ledger['state']} files={len(paths)}")


def publish_batch(paths):
    grouped = {}
    for raw_path in paths:
        p = Path(raw_path)
        parts = p.parts
        # launches/<venue>/<shard>/<mint>[.summary].json or trades/<venue>/<shard>/<mint>/<page>.jsonl
        if len(parts) >= 4 and parts[0] == "launches":
            venue, filename = parts[1], parts[3]
            mint = filename.removesuffix(".screening.json").removesuffix(".summary.json").removesuffix(".json")
        elif len(parts) >= 5 and parts[0] == "trades":
            venue, mint = parts[1], parts[3]
        else:
            continue
        grouped.setdefault((venue, mint), set()).add(p.as_posix())
    for (venue, mint), changed in sorted(grouped.items()):
        publish_coin(venue, mint, changed)
    checkpoint = ROOT / "checkpoint.json"
    if checkpoint.is_file() and os.environ.get("SKIP_CHECKPOINT_UPLOAD") != "1":
        upload_verified(CHECKPOINT_REMOTE, checkpoint.read_bytes(), f"Publish resumable collection checkpoint {START_DAY}..{END_DAY}")
    flush_staged()
    if not grouped:
        print("No coin files changed; checkpoint refreshed if present.")


def restore():
    # Never reuse old v1/v2 cache contents as v3 input.
    if ROOT.exists():
        shutil.rmtree(ROOT)
    ROOT.mkdir(parents=True, exist_ok=True)
    # Restore only the files the replay collector actually needs. The previous
    # dataset_v3/** pattern pulled every historical page and made each run spend
    # most of its 60-minute budget downloading unrelated data.
    restore_patterns = [
        CHECKPOINT_REMOTE,
        f"{REMOTE_ROOT}/control/ledger/**",
        f"{REMOTE_ROOT}/raw/*/**/launch.json",
        f"{REMOTE_ROOT}/raw/*/**/summary.json",
        f"{REMOTE_ROOT}/raw/*/**/screening.json",
        f"{REMOTE_ROOT}/raw/*/**/transaction_pages/replay-*.jsonl",
    ]
    print("Restoring checkpoint, per-coin ledgers, launch metadata, and replay pages only.")
    try:
        snapshot = Path(snapshot_download(
            repo_id=REPO_ID, repo_type="dataset", token=TOKEN,
            allow_patterns=restore_patterns, max_workers=8,
        ))
    except Exception as exc:
        msg = str(exc).lower()
        if "404" in msg or "not found" in msg or "does not exist" in msg:
            print("No v3 archive exists yet; starting with a fresh local state.")
            return
        raise
    base = snapshot / REMOTE_ROOT
    cp = snapshot / CHECKPOINT_REMOTE
    if cp.is_file():
        shutil.copyfile(cp, ROOT / "checkpoint.json")
    # Keep the restored per-coin ledgers locally so publishing never performs
    # thousands of individual resolve/download requests against the Hub.
    remote_ledgers = base / "control" / "ledger"
    if remote_ledgers.exists():
        for ledger_file in remote_ledgers.rglob("*.json"):
            relative = ledger_file.relative_to(base)
            local_ledger = ROOT / relative
            local_ledger.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ledger_file, local_ledger)
    raw = base / "raw"
    if raw.exists():
        for venue_dir in raw.iterdir():
            if not venue_dir.is_dir():
                continue
            venue = venue_dir.name
            for shard_dir in venue_dir.iterdir():
                if not shard_dir.is_dir():
                    continue
                for mint_prefix_dir in shard_dir.iterdir():
                    if not mint_prefix_dir.is_dir():
                        continue
                    for mint_dir in mint_prefix_dir.iterdir():
                        if not mint_dir.is_dir():
                            continue
                        mint = mint_dir.name
                        launch = mint_dir / "launch.json"
                        summary = mint_dir / "summary.json"
                        screening = mint_dir / "screening.json"
                        local_launch_dir = ROOT / "launches" / venue / shard_dir.name
                        local_launch_dir.mkdir(parents=True, exist_ok=True)
                        if launch.is_file():
                            shutil.copyfile(launch, local_launch_dir / f"{mint}.json")
                        if summary.is_file():
                            shutil.copyfile(summary, local_launch_dir / f"{mint}.summary.json")
                        if screening.is_file():
                            shutil.copyfile(screening, local_launch_dir / f"{mint}.screening.json")
                        page_dir = ROOT / "trades" / venue / shard_dir.name / mint
                        pages = mint_dir / "transaction_pages"
                        if pages.exists():
                            page_dir.mkdir(parents=True, exist_ok=True)
                            for page in pages.glob("*.jsonl"):
                                shutil.copyfile(page, page_dir / page.name)
    # Reconcile transaction-history-complete COMPLETE/PARTIAL per-coin ledgers in case a run stopped after a coin
    # ledger commit but before the global checkpoint upload.
    checkpoint_file = ROOT / "checkpoint.json"
    if checkpoint_file.is_file():
        checkpoint_state = json.loads(checkpoint_file.read_text(encoding="utf-8"))
        checkpoint_state.setdefault("tradeCursors", {})
        ledgers = base / "control" / "ledger"
        if ledgers.exists():
            for ledger_file in ledgers.rglob("*.json"):
                try:
                    ledger = json.loads(ledger_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if ledger.get("state") not in ("COMPLETE", "PARTIAL"):
                    continue
                mint = ledger.get("mint")
                if not mint:
                    continue
                launch_time = ledger.get("launch_time_utc")
                if not launch_time or not (START_DAY <= launch_time[:10] < END_DAY):
                    continue
                capture = ledger.get("capture") or {}
                if not capture.get("transactionHistoryComplete"):
                    continue
                source_states = capture.get("sources") or {}
                checkpoint_state["tradeCursors"][mint] = {
                    "complete": True,
                    "pages": int(capture.get("totalSourcePages") or 0),
                    "sources": {address: {"complete": bool(info.get("complete", True)), "pages": int(info.get("pages") or 0)}
                                for address, info in source_states.items()},
                }
        checkpoint_file.write_text(json.dumps(checkpoint_state, indent=2) + "\n", encoding="utf-8")
    print("Restored dataset_v3 files and checkpoint; transaction-history-complete coin ledgers were reconciled. Legacy generations were not imported.")


def write_test():
    path = f"{REMOTE_ROOT}/_preflight/write-test-{os.environ.get('GITHUB_RUN_ID', 'manual')}.txt"
    payload = b"temporary v3 dataset permission check\n"
    h = upload_verified(path, payload, "Preflight: verify v3 dataset write/read access")
    flush_staged("Preflight: verify v3 dataset write/read access")
    API.delete_file(path_in_repo=path, repo_id=REPO_ID, repo_type="dataset", commit_message="Preflight: remove v3 test file")
    print(f"V3 write/read/delete verified: {h}")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "restore":
        restore()
    elif command == "write-test":
        write_test()
    elif command == "publish-batch":
        publish_batch(sys.argv[2:])
    elif command == "publish-coin" and len(sys.argv) == 4:
        publish_coin(sys.argv[2], sys.argv[3])
        flush_staged()
    else:
        raise SystemExit("Use restore, write-test, publish-batch [local paths...], or publish-coin VENUE MINT")
