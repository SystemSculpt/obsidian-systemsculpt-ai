#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

node scripts/jest.mjs \
  --config jest.config.cjs \
  --runInBand \
  --runTestsByPath \
  src/services/pi-native/__tests__/PiLocalAgentExecutor.test.ts

node scripts/jest.mjs \
  --config jest.config.cjs \
  --runInBand \
  --runTestsByPath \
  src/views/chatview/__tests__/streaming-controller.test.ts

node scripts/jest.mjs \
  --config jest.config.cjs \
  --runInBand \
  --runTestsByPath \
  src/views/chatview/__tests__/input-handler-tool-loop.test.ts

node --test testing/native/desktop-automation/runner.test.mjs
