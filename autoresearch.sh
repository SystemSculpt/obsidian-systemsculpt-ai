#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/autoresearch-logs"
RUN_ID="${AUTORESEARCH_RUN_ID:-$(date -u +"%Y%m%dT%H%M%SZ")}"
RUN_DIR="$LOG_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

CHECK_LOG="$RUN_DIR/checks.log"
MANAGED_JSON="$RUN_DIR/managed-baseline.json"
PROVIDER_JSON="$RUN_DIR/provider-connected-baseline.json"

PROVIDER_ID="${SYSTEMSCULPT_DESKTOP_PROVIDER_ID:-openrouter}"
PROVIDER_MODEL_ID="${SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID:-openai/gpt-5.4-mini}"
PROVIDER_API_KEY="${SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY:-${OPENROUTER_API_KEY:-}}"

if [[ -z "$PROVIDER_API_KEY" ]]; then
  echo "Missing provider API key. Set SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY or OPENROUTER_API_KEY." >&2
  exit 1
fi

pushd "$ROOT" >/dev/null

./autoresearch.checks.sh | tee "$CHECK_LOG"

node testing/native/device/windows/run-desktop-automation.mjs \
  --case managed-baseline \
  --no-reload \
  --json-output "$MANAGED_JSON"

SYSTEMSCULPT_DESKTOP_PROVIDER_ID="$PROVIDER_ID" \
SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY="$PROVIDER_API_KEY" \
SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID="$PROVIDER_MODEL_ID" \
node testing/native/device/windows/run-desktop-automation.mjs \
  --case provider-connected-baseline \
  --no-reload \
  --json-output "$PROVIDER_JSON"

node - "$MANAGED_JSON" "$PROVIDER_JSON" <<'NODE'
const fs = require("node:fs");

const managed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const provider = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));

const managedResult = managed?.iterations?.[0]?.results?.["managed-baseline"] || {};
const providerResult = provider?.iterations?.[0]?.results?.["provider-connected-baseline"] || {};

const boolMetric = (value) => (value ? 1 : 0);
const systemsculptModelId = "systemsculpt@@systemsculpt/ai-agent";

const managedHostedTurnOk = Boolean(managedResult.hostedTurn || managedResult.recoveryTurn);
const managedTransientClassifiedOk = Array.isArray(managedResult.transientFailures);
const providerConnectedOk = Boolean(providerResult.providerTurn);
const providerRecoveryOk =
  providerResult?.recoverySelection?.selectedModelId === systemsculptModelId &&
  provider?.statusSummary?.chat?.selectedModelId === systemsculptModelId;

console.log(`METRIC runner_tests_ok=1`);
console.log(`METRIC managed_hosted_turn_ok=${boolMetric(managedHostedTurnOk)}`);
console.log(`METRIC managed_transient_classified_ok=${boolMetric(managedTransientClassifiedOk)}`);
console.log(`METRIC provider_connected_ok=${boolMetric(providerConnectedOk)}`);
console.log(`METRIC provider_recovery_ok=${boolMetric(providerRecoveryOk)}`);
console.log(
  `METRIC windows_baselines_ok=${boolMetric(managedHostedTurnOk && providerConnectedOk && providerRecoveryOk)}`
);

console.log(
  `DETAIL managed_transient_failure_count=${JSON.stringify(
    Array.isArray(managedResult.transientFailures) ? managedResult.transientFailures.length : 0
  )}`
);
NODE

popd >/dev/null
