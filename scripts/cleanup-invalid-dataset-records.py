import json
import os
from pathlib import Path

from huggingface_hub import (
    CommitOperationAdd,
    CommitOperationDelete,
    HfApi,
    hf_hub_download,
)

REPO_ID = os.environ.get("HF_DATASET_REPO", "ndeda/solana-scalping-data")
TOKEN = os.environ["HF_TOKEN"]
MINT = "So11111111111111111111111111111111111111112"
SIGNATURE = "3mR3oyYXHEPWWCUhv3URSCjVXABTUoGDv4eowDGJp5Dv522sghdc66janYMgm7KU4uLYwRmvTXV5CQuV6voRwQUw"
RAW_PATH = f"raw/pumpfun/{MINT}/events.jsonl"
STATE_PATH = "state/collector-state.json"


def read_repo_file(api: HfApi, path: str) -> bytes:
    local = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=path, token=TOKEN)
    return Path(local).read_bytes()


def main() -> None:
    api = HfApi(token=TOKEN)
    files = set(api.list_repo_files(repo_id=REPO_ID, repo_type="dataset"))
    operations = []

    if RAW_PATH in files:
        raw = read_repo_file(api, RAW_PATH)
        first = raw.splitlines()[0] if raw.splitlines() else b""
        launch = json.loads(first.decode("utf-8"))
        if (
            launch.get("kind") != "launch_detected"
            or launch.get("mint") != MINT
            or launch.get("launchSignature") != SIGNATURE
        ):
            raise RuntimeError("Refusing deletion: the exact known false-positive launch record did not match.")
        logs = launch.get("launchLogs") or []
        if not any("Instruction: BuyExactQuoteInV3" in str(line) for line in logs):
            raise RuntimeError("Refusing deletion: expected Pump buy instruction evidence was not present.")
        if any("Instruction: Create" in str(line) for line in logs):
            raise RuntimeError("Refusing deletion: launch logs unexpectedly contain a Create instruction.")
        operations.append(CommitOperationDelete(path_in_repo=RAW_PATH))
        print(f"Verified and queued deletion: {RAW_PATH} ({len(raw)} bytes)")
    else:
        print(f"Already absent: {RAW_PATH}")

    if STATE_PATH in files:
        state_bytes = read_repo_file(api, STATE_PATH)
        state = json.loads(state_bytes.decode("utf-8"))
        tokens = state.setdefault("tokens", {})
        entry = tokens.get(MINT)
        if entry is not None:
            if entry.get("launchSignature") != SIGNATURE:
                raise RuntimeError("Refusing checkpoint edit: wrapped-SOL entry points to a different launch signature.")
            del tokens[MINT]
        seen = state.get("seenLaunchSignatures", [])
        state["seenLaunchSignatures"] = [value for value in seen if value != SIGNATURE]
        if entry is not None or len(state["seenLaunchSignatures"]) != len(seen):
            updated = (json.dumps(state, indent=2) + "\n").encode("utf-8")
            operations.append(CommitOperationAdd(path_in_repo=STATE_PATH, path_or_fileobj=updated))
            print("Removed the confirmed false-positive mint/signature from the checkpoint.")
        else:
            print("Checkpoint already excludes the false-positive mint/signature.")

    if not operations:
        print("No dataset changes were required.")
        return

    result = api.create_commit(
        repo_id=REPO_ID,
        repo_type="dataset",
        operations=operations,
        commit_message="Delete verified wrapped-SOL false-positive record",
        commit_description="Remove only the confirmed non-token record whose launch signature is a Pump buy, not a create instruction.",
    )
    print(f"Dataset cleanup commit: {result}")

    remaining = set(api.list_repo_files(repo_id=REPO_ID, repo_type="dataset"))
    if RAW_PATH in remaining:
        raise RuntimeError("Post-commit verification failed: invalid raw file still exists.")
    checkpoint = json.loads(read_repo_file(api, STATE_PATH).decode("utf-8"))
    if MINT in checkpoint.get("tokens", {}) or SIGNATURE in checkpoint.get("seenLaunchSignatures", []):
        raise RuntimeError("Post-commit verification failed: checkpoint still references the false positive.")
    print("VERIFIED: invalid raw file is deleted and checkpoint no longer references it.")


if __name__ == "__main__":
    main()
