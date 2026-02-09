#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-live}"
SPEC="${SYSTEMSCULPT_E2E_SPEC:-}"
VAULT="${SYSTEMSCULPT_E2E_VAULT:-}"
SETTINGS_JSON="${SYSTEMSCULPT_E2E_SETTINGS_JSON:-}"
PRIVATE_VAULT_FALLBACK="${SYSTEMSCULPT_E2E_PRIVATE_VAULT_FALLBACK:-$HOME/gits/private-vault/.obsidian/plugins/systemsculpt-ai/data.json}"
DISABLE_PRIVATE_VAULT_FALLBACK="${SYSTEMSCULPT_E2E_DISABLE_PRIVATE_VAULT_FALLBACK:-0}"
SKIP_BUILD="${SYSTEMSCULPT_E2E_SKIP_BUILD:-0}"
MOCK_SERVER_PID=""

if [[ "${VAULT}" == "~/"* ]]; then
  VAULT="${HOME}/${VAULT:2}"
fi
if [[ "${SETTINGS_JSON}" == "~/"* ]]; then
  SETTINGS_JSON="${HOME}/${SETTINGS_JSON:2}"
fi

resolve_settings_json() {
  if [[ -n "${SETTINGS_JSON}" ]]; then
    echo "${SETTINGS_JSON}"
    return
  fi
  if [[ -n "${VAULT}" ]]; then
    echo "${VAULT}/.obsidian/plugins/systemsculpt-ai/data.json"
    return
  fi
  if [[ "${DISABLE_PRIVATE_VAULT_FALLBACK}" != "1" && -f "${PRIVATE_VAULT_FALLBACK}" ]]; then
    echo "${PRIVATE_VAULT_FALLBACK}"
    return
  fi
  echo ""
}

read_settings_json_key() {
  local key="${1:?key required}"
  local settings_path="${2:?settings_path required}"

  node -e 'const fs=require("fs");const p=process.argv[1];const k=process.argv[2];const j=JSON.parse(fs.readFileSync(p,"utf8"));const v=j?.[k];process.stdout.write(v==null?"":String(v))' "$settings_path" "$key"
}

run_build_if_needed() {
  if [[ "${SKIP_BUILD}" == "1" ]]; then
    return
  fi
  npm run build >/dev/null
}

cleanup_e2e() {
  if [[ -n "${MOCK_SERVER_PID}" ]]; then
    kill "${MOCK_SERVER_PID}" >/dev/null 2>&1 || true
  fi
  # Best-effort cleanup for orphaned WDIO/Obsidian processes from interrupted runs.
  pkill -P $$ >/dev/null 2>&1 || true
  pkill -f "wdio.live.conf.mjs" >/dev/null 2>&1 || true
  pkill -f "wdio.emu.conf.mjs" >/dev/null 2>&1 || true
  pkill -f "wdio.mock.conf.mjs" >/dev/null 2>&1 || true
  pkill -f ".obsidian-cache/obsidian-installer" >/dev/null 2>&1 || true
  pkill -f ".obsidian-cache/electron-chromedriver" >/dev/null 2>&1 || true
}

cleanup_e2e
trap cleanup_e2e EXIT INT TERM

start_mock_server() {
  local port="${SYSTEMSCULPT_E2E_MOCK_PORT:-43111}"
  export SYSTEMSCULPT_E2E_MOCK_PORT="${port}"

  node testing/e2e/mock-server.mjs &
  MOCK_SERVER_PID=$!

  node - <<'NODE'
const port = Number(process.env.SYSTEMSCULPT_E2E_MOCK_PORT);
const url = `http://127.0.0.1:${port}/healthz`;
const timeoutMs = 5000;
const started = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) process.exit(0);
    } catch (_) {}
    await sleep(100);
  }
  console.error(`[e2e-mock] server not healthy: ${url}`);
  process.exit(1);
})();
NODE
}

case "$MODE" in
  live)
    SETTINGS_JSON="$(resolve_settings_json)"
    if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_LICENSE_KEY="$(read_settings_json_key licenseKey "$SETTINGS_JSON")"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_SERVER_URL="$(read_settings_json_key serverUrl "$SETTINGS_JSON")"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_MODEL_ID:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_MODEL_ID="$(read_settings_json_key selectedModelId "$SETTINGS_JSON")"
    fi

    if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" ]]; then
      echo "Missing SYSTEMSCULPT_E2E_LICENSE_KEY." >&2
      echo "Set it directly or provide SYSTEMSCULPT_E2E_SETTINGS_JSON / SYSTEMSCULPT_E2E_VAULT for auto-loading." >&2
      exit 1
    fi

    run_build_if_needed
    if [[ -n "$SPEC" ]]; then
      npx wdio testing/e2e/wdio.live.conf.mjs --spec "$SPEC"
    else
      npx wdio testing/e2e/wdio.live.conf.mjs
    fi
    ;;
  emu)
    SETTINGS_JSON="$(resolve_settings_json)"
    if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_LICENSE_KEY="$(read_settings_json_key licenseKey "$SETTINGS_JSON")"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_SERVER_URL="$(read_settings_json_key serverUrl "$SETTINGS_JSON")"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_MODEL_ID:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
      export SYSTEMSCULPT_E2E_MODEL_ID="$(read_settings_json_key selectedModelId "$SETTINGS_JSON")"
    fi

    if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" ]]; then
      echo "Missing SYSTEMSCULPT_E2E_LICENSE_KEY." >&2
      echo "Set it directly or provide SYSTEMSCULPT_E2E_SETTINGS_JSON / SYSTEMSCULPT_E2E_VAULT for auto-loading." >&2
      exit 1
    fi

    run_build_if_needed
    if [[ -n "$SPEC" ]]; then
      npx wdio testing/e2e/wdio.emu.conf.mjs --spec "$SPEC"
    else
      npx wdio testing/e2e/wdio.emu.conf.mjs
    fi
    ;;
  mock)
    start_mock_server
    if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" ]]; then
      export SYSTEMSCULPT_E2E_LICENSE_KEY="mock-license"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" ]]; then
      export SYSTEMSCULPT_E2E_SERVER_URL="http://127.0.0.1:${SYSTEMSCULPT_E2E_MOCK_PORT}/api/v1"
    fi
    if [[ -z "${SYSTEMSCULPT_E2E_MODEL_ID:-}" ]]; then
      export SYSTEMSCULPT_E2E_MODEL_ID="systemsculpt@@systemsculpt/ai-agent"
    fi

    run_build_if_needed
    if [[ -n "$SPEC" ]]; then
      npx wdio testing/e2e/wdio.mock.conf.mjs --spec "$SPEC"
    else
      npx wdio testing/e2e/wdio.mock.conf.mjs
    fi
    ;;
  *)
    echo "Unknown mode: $MODE (use: live | emu | mock)" >&2
    exit 1
    ;;
esac
