import os
import shutil
from io import BytesIO
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

REPO_ID = "ndeda/solana-scalping-data"
TOKEN = os.environ.get("HF_TOKEN")
if not TOKEN:
    raise SystemExit("HF_TOKEN is missing")
api = HfApi(token=TOKEN)

def restore():
    local = Path("historical-data")
    local.mkdir(parents=True, exist_ok=True)
    try:
        snapshot = Path(snapshot_download(
            repo_id=REPO_ID,
            repo_type="dataset",
            token=TOKEN,
            allow_patterns=["historical/**", "historical-v2/**"],
        ))
    except Exception as exc:
        message = str(exc).lower()
        if "404" in message or "not found" in message or "does not exist" in message:
            print("No previous historical archive found; starting with an empty checkpoint.")
            return
        raise
    source_v2 = snapshot / "historical-v2"
    source_legacy = snapshot / "historical"
    source = source_v2 if source_v2.exists() else source_legacy
    if source.exists():
        shutil.copytree(source, local, dirs_exist_ok=True)
    # One-time migration: shard legacy flat launch files and mint trade folders
    # by a stable SHA-256 prefix so no Hugging Face directory exceeds 10,000 entries.
    import hashlib
    launches = local / "launches"
    if launches.exists():
        for venue_dir in [p for p in launches.iterdir() if p.is_dir()]:
            for item in list(venue_dir.iterdir()):
                if not item.is_file() or item.suffix != ".json":
                    continue
                mint = item.name.removesuffix(".summary.json").removesuffix(".json")
                shard = hashlib.sha256(mint.encode()).hexdigest()[:2]
                target_dir = venue_dir / shard
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / item.name
                if not target.exists():
                    shutil.move(str(item), str(target))
                else:
                    item.unlink()
    trades = local / "trades"
    if trades.exists():
        for venue_dir in [p for p in trades.iterdir() if p.is_dir()]:
            for mint_dir in list(venue_dir.iterdir()):
                if not mint_dir.is_dir() or len(mint_dir.name) != 44:
                    continue
                shard = hashlib.sha256(mint_dir.name.encode()).hexdigest()[:2]
                target_dir = venue_dir / shard
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / mint_dir.name
                if target.exists():
                    shutil.copytree(mint_dir, target, dirs_exist_ok=True)
                    shutil.rmtree(mint_dir)
                else:
                    shutil.move(str(mint_dir), str(target))
    print(f"Restored and sharded historical archive into {local} (source={'historical-v2' if source == source_v2 else 'legacy historical'})")

def write_test():
    path = f"_preflight/write-test-{os.environ.get('GITHUB_RUN_ID', 'manual')}.txt"
    try:
        api.upload_file(
            path_or_fileobj=BytesIO(b"temporary dataset write permission check; no user data\n"),
            path_in_repo=path,
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message="Preflight: verify dataset write permission",
        )
        api.delete_file(
            path_in_repo=path,
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message="Preflight: remove temporary write permission check",
        )
    except Exception:
        print("Dataset write/delete permission check failed.")
        raise
    print("Hugging Face dataset write and cleanup permissions verified.")

def upload():
    folder = Path("historical-data")
    if not folder.exists():
        print("No historical-data directory to upload.")
        return
    api.upload_folder(
        folder_path=str(folder),
        path_in_repo="historical-v2",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="Upload sharded resumable Solana research archive",
    )
    exports = Path("dataset-export")
    if exports.exists():
        api.upload_folder(
            folder_path=str(exports),
            path_in_repo="data",
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message="Publish queryable Parquet research tables",
        )
        api.upload_file(
            path_or_fileobj=str(exports / "README.md"),
            path_in_repo="README.md",
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message="Publish Solana research dataset card",
        )
        print("Queryable Parquet exports and dataset card uploaded.")
    print("Sharded historical archive uploaded to historical-v2.")

if __name__ == "__main__":
    import sys
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    {"restore": restore, "write-test": write_test, "upload": upload}.get(command, lambda: (_ for _ in ()).throw(SystemExit("Use restore, write-test, or upload")))()
