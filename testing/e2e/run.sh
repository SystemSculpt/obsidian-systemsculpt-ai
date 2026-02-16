#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

load_env_file() {
  local file_path="${1:?file path required}"
  if [[ ! -f "${file_path}" ]]; then
    return
  fi
  # shellcheck disable=SC1090
  set -a
  source "${file_path}"
  set +a
}

load_env_file "${REPO_ROOT}/.env.local"
load_env_file "${REPO_ROOT}/.env"

MODE="${1:-live}"
SPEC="${SYSTEMSCULPT_E2E_SPEC:-}"
VAULT="${SYSTEMSCULPT_E2E_VAULT:-}"
SETTINGS_JSON="${SYSTEMSCULPT_E2E_SETTINGS_JSON:-}"
PRIVATE_VAULT_FALLBACK="${SYSTEMSCULPT_E2E_PRIVATE_VAULT_FALLBACK:-$HOME/gits/private-vault/.obsidian/plugins/systemsculpt-ai/data.json}"
DISABLE_PRIVATE_VAULT_FALLBACK="${SYSTEMSCULPT_E2E_DISABLE_PRIVATE_VAULT_FALLBACK:-0}"
SKIP_BUILD="${SYSTEMSCULPT_E2E_SKIP_BUILD:-0}"
ALLOW_PAID_LIVE_TESTS="${SYSTEMSCULPT_E2E_ALLOW_PAID_LIVE_TESTS:-0}"
MOCK_SERVER_PID=""
DEFAULT_LIVE_SERVER_URL="https://api.systemsculpt.com/api/v1"

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

hydrate_e2e_env_from_settings_json() {
  SETTINGS_JSON="$(resolve_settings_json)"

  if [[ -z "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
    export SYSTEMSCULPT_E2E_LICENSE_KEY="$(read_settings_json_key licenseKey "${SETTINGS_JSON}")"
  fi
  if [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
    export SYSTEMSCULPT_E2E_SERVER_URL="$(read_settings_json_key serverUrl "${SETTINGS_JSON}")"
  fi
  if [[ -z "${SYSTEMSCULPT_E2E_MODEL_ID:-}" && -n "${SETTINGS_JSON}" && -f "${SETTINGS_JSON}" ]]; then
    export SYSTEMSCULPT_E2E_MODEL_ID="$(read_settings_json_key selectedModelId "${SETTINGS_JSON}")"
  fi
}

require_e2e_license_key() {
  if [[ -n "${SYSTEMSCULPT_E2E_LICENSE_KEY:-}" ]]; then
    return
  fi
  echo "Missing SYSTEMSCULPT_E2E_LICENSE_KEY." >&2
  echo "Set it in .env.local or provide SYSTEMSCULPT_E2E_SETTINGS_JSON / SYSTEMSCULPT_E2E_VAULT for auto-loading." >&2
  exit 1
}

require_live_spend_confirmation() {
  if [[ "${ALLOW_PAID_LIVE_TESTS}" == "1" ]]; then
    return
  fi
  echo "Refusing to run paid live E2E image generation without explicit opt-in." >&2
  echo "Set SYSTEMSCULPT_E2E_ALLOW_PAID_LIVE_TESTS=1 for an intentional live run." >&2
  exit 1
}

ensure_live_server_url() {
  if [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" ]]; then
    export SYSTEMSCULPT_E2E_SERVER_URL="${DEFAULT_LIVE_SERVER_URL}"
  fi

  export SYSTEMSCULPT_E2E_SERVER_URL="$(node - <<'NODE'
const raw = (process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim();
const fallback = "https://api.systemsculpt.com/api/v1";
if (!raw) {
  process.stdout.write(fallback);
  process.exit(0);
}

const normalizeApiUrl = (input) => {
  try {
    const parsed = new URL(input);
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    if (/\/api\/v1$/i.test(trimmedPath)) {
      parsed.pathname = trimmedPath || "/api/v1";
      return parsed.toString();
    }
    if (/\/api$/i.test(trimmedPath)) {
      parsed.pathname = `${trimmedPath}/v1`;
      return parsed.toString();
    }
    const basePath = trimmedPath === "" || trimmedPath === "/" ? "" : trimmedPath;
    parsed.pathname = `${basePath}/api/v1`.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    const withoutTrailing = input.replace(/\/+$/, "");
    if (withoutTrailing.endsWith("/api/v1")) return withoutTrailing;
    if (withoutTrailing.endsWith("/api")) return `${withoutTrailing}/v1`;
    return `${withoutTrailing}/api/v1`;
  }
};

try {
  const normalized = normalizeApiUrl(raw);
  const parsed = new URL(normalized);
  if (parsed.hostname === "systemsculpt.com" || parsed.hostname === "www.systemsculpt.com") {
    parsed.hostname = "api.systemsculpt.com";
    parsed.port = "";
    process.stdout.write(parsed.toString());
    process.exit(0);
  }
  process.stdout.write(parsed.toString());
  process.exit(0);
} catch {
  process.stdout.write(fallback);
  process.exit(0);
}
NODE
)"
}

preflight_live_image_api() {
  node - <<'NODE'
const serverUrlRaw = (process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim();
const licenseKey = (process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim();
if (!serverUrlRaw) {
  console.error("[e2e-live] Missing SYSTEMSCULPT_E2E_SERVER_URL for live API preflight.");
  process.exit(1);
}
if (!licenseKey) {
  console.error("[e2e-live] Missing SYSTEMSCULPT_E2E_LICENSE_KEY for live API preflight.");
  process.exit(1);
}

const normalizeBase = (value) => value.replace(/\/+$/, "");
const base = normalizeBase(serverUrlRaw);
const headers = {
  "x-license-key": licenseKey,
  "content-type": "application/json",
  "accept": "application/json",
};

const readJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const fail = (message) => {
  console.error(`[e2e-live] ${message}`);
  process.exit(1);
};

(async () => {
  const modelsUrl = `${base}/images/models`;
  const modelsResp = await fetch(modelsUrl, { method: "GET", headers });
  if (!modelsResp.ok) {
    const payload = await readJson(modelsResp);
    fail(`Image models preflight failed (${modelsResp.status}) at ${modelsUrl}. body=${JSON.stringify(payload)}`);
  }

  const jobsUrl = `${base}/images/generations/jobs`;
  const invalidPayloadResp = await fetch(jobsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (invalidPayloadResp.status === 404) {
    const payload = await readJson(invalidPayloadResp);
    fail(`Image jobs endpoint returned 404 at ${jobsUrl}. This usually means image generation is disabled/unavailable on the target API. body=${JSON.stringify(payload)}`);
  }
  if (invalidPayloadResp.status === 401 || invalidPayloadResp.status === 403) {
    const payload = await readJson(invalidPayloadResp);
    fail(`Image jobs endpoint auth failed (${invalidPayloadResp.status}) at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }
  if (invalidPayloadResp.status >= 500) {
    const payload = await readJson(invalidPayloadResp);
    fail(`Image jobs endpoint server error (${invalidPayloadResp.status}) at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }

  // Expected success for this request is a validation error (400/422), which proves the route exists
  // and authentication reached request validation without charging credits.
  if (!(invalidPayloadResp.status === 400 || invalidPayloadResp.status === 422)) {
    const payload = await readJson(invalidPayloadResp);
    fail(`Image jobs route preflight returned unexpected status ${invalidPayloadResp.status} at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }

  console.log(`[e2e-live] API preflight passed for ${base}`);
})();
NODE
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
    require_live_spend_confirmation
    hydrate_e2e_env_from_settings_json
    require_e2e_license_key
    ensure_live_server_url
    preflight_live_image_api

    run_build_if_needed
    if [[ -n "$SPEC" ]]; then
      npx wdio testing/e2e/wdio.live.conf.mjs --spec "$SPEC"
    else
      npx wdio testing/e2e/wdio.live.conf.mjs
    fi
    ;;
  emu)
    require_live_spend_confirmation
    hydrate_e2e_env_from_settings_json
    require_e2e_license_key
    ensure_live_server_url
    preflight_live_image_api

    run_build_if_needed
    if [[ -n "$SPEC" ]]; then
      npx wdio testing/e2e/wdio.emu.conf.mjs --spec "$SPEC"
    else
      npx wdio testing/e2e/wdio.emu.conf.mjs
    fi
    ;;
  mock)
    start_mock_server
    hydrate_e2e_env_from_settings_json
    require_e2e_license_key
    if [[ "${SYSTEMSCULPT_E2E_ALLOW_EXTERNAL_SERVER_IN_MOCK:-0}" != "1" ]]; then
      export SYSTEMSCULPT_E2E_SERVER_URL="http://127.0.0.1:${SYSTEMSCULPT_E2E_MOCK_PORT}/api/v1"
    elif [[ -z "${SYSTEMSCULPT_E2E_SERVER_URL:-}" ]]; then
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
