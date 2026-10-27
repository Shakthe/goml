#!/usr/bin/env bash
# Runs the Oversell Lab for every checkout strategy and writes evidence/k6/lab-results.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
OUT=evidence/k6
mkdir -p "$OUT"
for s in naive pessimistic optimistic queue; do
  echo "== $s"
  docker compose --profile test run --rm -e STRATEGY="$s" k6 run --quiet \
    --summary-export="/results/lab-$s.json" /scripts/lab.js > "$OUT/lab-$s.txt" 2>&1 || true
  grep -o 'LAB {.*}' "$OUT/lab-$s.txt" | sed 's/\\"/"/g' || true
done
node tests/load/lab-table.mjs > "$OUT/lab-results.md"
cat "$OUT/lab-results.md"
