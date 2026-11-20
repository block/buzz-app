#!/usr/bin/env bash
# Linux CPU lane. No desktop, public mesh, credentials or GPU required.
set -euo pipefail
cd "$(dirname "$0")/.."
cache="${MESH_SMOKE_CACHE:-$PWD/.cache/mesh-cross-node}"
output="${MESH_SMOKE_OUTPUT:-$PWD/test-results/mesh-cross-node}"
mkdir -p "$cache" "$output"
archive="$cache/runtime-linux-v0.80.0.tar.gz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --max-time 180 \
    https://github.com/Mesh-LLM/mesh-llm/releases/download/v0.80.0/meshllm-native-runtime-linux-x86_64-cpu.tar.gz \
    --output "$archive"
fi
echo "bc7987f3f11c441c00d8e37a5b0372a45042e6a291bb2ecc4a0879b814fc7dd8  $archive" | sha256sum --check
tar -xzf "$archive" -C "$cache"
python3 src/bundled/mesh-compute/compute/tests/cross_node/run.py \
  --runtime-bundle "$cache/meshllm-native-runtime-linux-x86_64-cpu" \
  --cache "$cache" --output "$output"
