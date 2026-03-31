#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bash autoresearch.sh

node scripts/jest.mjs \
  --config jest.config.cjs \
  --runInBand \
  --runTestsByPath \
  src/views/chatview/__tests__/streaming-controller.test.ts

npm run build
