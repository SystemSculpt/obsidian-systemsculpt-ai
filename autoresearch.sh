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
  "message-renderer-order" \
  "renderer_order_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/message-renderer-order.test.ts

run_check \
  "message-renderer-reasoning-layout" \
  "reasoning_layout_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/message-renderer-reasoning-layout.test.ts

run_check \
  "chat-markdown-serializer-order" \
  "serializer_roundtrip_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/chat-markdown-serializer-order.test.ts

run_check \
  "systemsculpt-service-hosted-tool-call-ids" \
  "hosted_unique_tool_call_ids_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/services/__tests__/SystemSculptService.test.ts

run_check \
  "desktop-automation-bridge-open-history" \
  "bridge_open_history_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/testing/automation/__tests__/DesktopAutomationBridge.test.ts

run_check \
  "desktop-automation-client-open-history" \
  "desktop_client_history_ok" \
  node --test testing/native/desktop-automation/client.test.mjs

run_check \
  "input-handler-tool-loop" \
  "input_handler_tool_loop_ok" \
  node scripts/jest.mjs \
    --config jest.config.cjs \
    --runInBand \
    --runTestsByPath \
    src/views/chatview/__tests__/input-handler-tool-loop.test.ts

printf 'METRIC failing_checks=%s\n' "$failing_checks"

if [[ "$failing_checks" -gt 0 ]]; then
  exit 1
fi

popd >/dev/null
