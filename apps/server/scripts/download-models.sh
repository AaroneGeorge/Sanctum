#!/usr/bin/env bash
# Download the MedPsy GGUF weights used by Sanctum.
# These are Apache-2.0, hosted on the official QVAC Hugging Face org.
# NOTE the "-imat" suffix in the filenames (imatrix-calibrated) — the plain
# name (without -imat) returns HTTP 404.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

DL=0  # set DL_4B=1 to also fetch the 2.72 GB quality-tier model

echo "==> Downloading MedPsy-1.7B Q4_K_M (~1.28 GB) [primary model]"
curl -L --fail --progress-bar \
  -o models/medpsy-1.7b-q4_k_m-imat.gguf \
  "https://huggingface.co/qvac/MedPsy-1.7B-GGUF/resolve/main/medpsy-1.7b-q4_k_m-imat.gguf"

if [[ "${DL_4B:-0}" == "1" ]]; then
  echo "==> Downloading MedPsy-4B Q4_K_M (~2.72 GB) [quality tier, CPU/partial-GPU]"
  curl -L --fail --progress-bar \
    -o models/medpsy-4b-q4_k_m-imat.gguf \
    "https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf"
else
  echo "==> Skipping MedPsy-4B (run 'DL_4B=1 npm run models' to include it)"
fi

echo "==> Recording SHA-256 checksums for reproducibility"
sha256sum models/*.gguf | tee models/SHA256SUMS.txt

echo "==> Done. Expected sizes: medpsy-1.7b ~1282439360 bytes, medpsy-4b ~2716068640 bytes"
ls -l models/*.gguf
