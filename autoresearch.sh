#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/autoresearch-logs"
RUN_ID="${AUTORESEARCH_RUN_ID:-$(date -u +"%Y%m%dT%H%M%SZ")}"
RUN_DIR="$LOG_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

pushd "$ROOT" >/dev/null

failing_checks=0

run_check() {
  local name="$1"
  local metric="$2"
  shift 2

  local log_file="$RUN_DIR/${name}.log"
  printf '[autoresearch] %s\n' "$name"

  if "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    printf 'METRIC %s=1\n' "$metric"
  else
    cat "$log_file"
    printf 'METRIC %s=0\n' "$metric"
    failing_checks=$((failing_checks + 1))
  fi
}

run_check \
  "streaming-controller" \
  "seeded_empty_continuation_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/streaming-controller.test.ts

run_check \
  "input-handler-tool-loop" \
  "assistant_root_reuse_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/input-handler-tool-loop.test.ts

run_check \
  "chat-storage-normalization" \
  "reload_compaction_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/chat-storage-normalization.test.ts

printf 'METRIC failing_checks=%s\n' "$failing_checks"

if [[ "$failing_checks" -gt 0 ]]; then
  exit 1
fi

popd >/dev/null
