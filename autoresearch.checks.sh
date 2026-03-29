#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

npm test -- \
  src/testing/automation/__tests__/DesktopAutomationBridge.test.ts \
  src/__tests__/settings-providers-tab.test.ts \
  src/__tests__/settings-providers-tab.import-safe.test.ts \
  src/studio/piAuth/__tests__/studio-pi-auth-storage-fetch-shim.test.ts \
  src/services/pi/__tests__/PiSdkRuntime.paths.test.ts

npm run build
