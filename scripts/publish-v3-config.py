#!/usr/bin/env python3
"""Publish the repository's v3 collection contract to the Hugging Face dataset and verify readback."""
import hashlib
import os
from io import BytesIO
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "ndeda/solana-scalping-data"
REMOTE_PATH = "dataset_v3/dataset_info/collection_config.json"
TOKEN = os.environ.get("HF_TOKEN")
if not TOKEN:
    raise SystemExit("HF_TOKEN is missing")

source = Path("config/collection-v3.json")
payload = source.read_bytes()
expected = hashlib.sha256(payload).hexdigest()
api = HfApi(token=TOKEN)
api.upload_file(
    path_or_fileobj=BytesIO(payload),
    path_in_repo=REMOTE_PATH,
    repo_id=REPO_ID,
    repo_type="dataset",
    commit_message="Sync v3 collection contract from scalping-bot",
)
downloaded = Path(hf_hub_download(
    repo_id=REPO_ID,
    filename=REMOTE_PATH,
    repo_type="dataset",
    token=TOKEN,
    force_download=True,
)).read_bytes()
actual = hashlib.sha256(downloaded).hexdigest()
if actual != expected:
    raise RuntimeError(f"HF config readback mismatch: expected {expected}, got {actual}")
print(f"V3 collection config synchronized and SHA-256 readback verified: {actual}")
