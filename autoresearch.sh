#!/usr/bin/env bash
set -uo pipefail

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
  local status=0

  printf '[autoresearch] %s\n' "$name"
  "$@" >"$log_file" 2>&1 || status=$?
  cat "$log_file"

  if [[ "$status" -eq 0 ]]; then
    printf 'METRIC %s=1\n' "$metric"
  else
    printf 'METRIC %s=0\n' "$metric"
    failing_checks=$((failing_checks + 1))
  fi
}

run_check \
  "pi-local-executor" \
  "pi_local_executor_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/services/pi-native/__tests__/PiLocalAgentExecutor.test.ts

run_check \
  "streaming-controller" \
  "streaming_controller_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/streaming-controller.test.ts

run_check \
  "input-handler-tool-loop" \
  "input_handler_tool_loop_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/input-handler-tool-loop.test.ts

run_check \
  "desktop-runner" \
  "desktop_runner_ok" \
  node --test testing/native/desktop-automation/runner.test.mjs

printf 'METRIC failing_checks=%s\n' "$failing_checks"

if [[ "$failing_checks" -gt 0 ]]; then
  exit 1
fi

popd >/dev/null
