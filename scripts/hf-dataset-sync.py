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
            allow_patterns=["historical/**"],
        ))
    except Exception as exc:
        message = str(exc).lower()
        if "404" in message or "not found" in message or "does not exist" in message:
            print("No previous historical archive found; starting with an empty checkpoint.")
            return
        raise
    source = snapshot / "historical"
    if source.exists():
        shutil.copytree(source, local, dirs_exist_ok=True)
    print(f"Restored historical archive into {local}")

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
        path_in_repo="historical",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="Update resumable Solana historical research archive",
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
    print("Historical archive uploaded.")

if __name__ == "__main__":
    import sys
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    {"restore": restore, "write-test": write_test, "upload": upload}.get(command, lambda: (_ for _ in ()).throw(SystemExit("Use restore, write-test, or upload")))()
