#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT_DIR"

HEADLESS=0
SYNC_ENABLED=1
HOT_RELOAD_ENABLED=1
SYNC_CONFIG="${SYSTEMSCULPT_SYNC_CONFIG:-$ROOT_DIR/systemsculpt-sync.config.json}"
DEV_ARGS=()
LOCK_FILE="${TMPDIR:-/tmp}/obsidian-systemsculpt-ai-run.sh.lock"

usage() {
  cat <<EOF
Usage: bash run.sh [options] [-- <esbuild watcher args>]

Options:
  --headless                Reduce run.sh console output.
  --no-sync                 Disable configured target auto-sync.
  --no-reload               Disable Obsidian plugin hot reload after sync.
  --sync-config <path>      Use a custom sync config JSON file.
  -h, --help                Show this help text.
EOF
}

cleanup() {
  if [[ -f "$LOCK_FILE" ]] && [[ "$(cat "$LOCK_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK_FILE"
  fi
}

acquire_lock() {
  local existing_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  fi

  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    if [[ $HEADLESS -eq 0 ]]; then
      echo "[run.sh] Killing previous watcher (pid $existing_pid)..."
    fi
    kill "$existing_pid" 2>/dev/null || true
    # Wait briefly for the process to exit
    for _ in 1 2 3 4 5; do
      kill -0 "$existing_pid" 2>/dev/null || break
      sleep 0.2
    done
    # Force kill if still alive
    if kill -0 "$existing_pid" 2>/dev/null; then
      kill -9 "$existing_pid" 2>/dev/null || true
    fi
  fi

  rm -f "$LOCK_FILE"
  printf '%s\n' "$$" > "$LOCK_FILE"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[run.sh] Error: required command not found: $cmd" >&2
    exit 1
  fi
}

install_js_dependencies_if_needed() {
  local needs_install=0
  local reason=""

  if [[ ! -d node_modules ]]; then
    needs_install=1
    reason="node_modules is missing"
  elif [[ ! -x node_modules/.bin/esbuild ]]; then
    needs_install=1
    reason="esbuild binary is missing"
  fi

  if [[ $needs_install -eq 0 ]]; then
    return
  fi

  echo "[run.sh] Repairing JS dependencies ($reason)..."
  if [[ -f package-lock.json ]]; then
    if npm ci; then
      return
    fi
    echo "[run.sh] npm ci failed; falling back to npm install."
  fi

  npm install
}

count_sync_targets() {
  node scripts/sync-local-vaults.mjs --count-targets --config "$SYNC_CONFIG"
}

print_sync_targets() {
  node scripts/sync-local-vaults.mjs --list-targets --config "$SYNC_CONFIG"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless)
      HEADLESS=1
      shift
      ;;
    --no-sync)
      SYNC_ENABLED=0
      shift
      ;;
    --no-reload)
      HOT_RELOAD_ENABLED=0
      shift
      ;;
    --sync-config)
      if [[ $# -lt 2 ]]; then
        echo "error: --sync-config requires a path" >&2
        exit 1
      fi
      SYNC_CONFIG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      if [[ $# -gt 0 ]]; then
        DEV_ARGS=("$@")
      fi
      break
      ;;
    *)
      DEV_ARGS=("$@")
      break
      ;;
  esac
done

require_cmd node
require_cmd npm
install_js_dependencies_if_needed
acquire_lock
trap cleanup EXIT INT TERM

if [[ $HEADLESS -eq 0 ]]; then
  echo "[run.sh] Starting plugin build watcher"
fi

if [[ $SYNC_ENABLED -eq 1 ]]; then
  SYNC_TARGET_COUNT="$(count_sync_targets || echo 0)"
  if [[ "$SYNC_TARGET_COUNT" =~ ^[0-9]+$ ]] && [[ "$SYNC_TARGET_COUNT" -gt 0 ]]; then
    if [[ $HEADLESS -eq 0 ]]; then
      echo "[run.sh] Auto-syncing build outputs via esbuild using: $SYNC_CONFIG"
      print_sync_targets | sed 's/^/[run.sh]  - /'
      if [[ $HOT_RELOAD_ENABLED -eq 1 ]]; then
        echo "[run.sh] Hot reloading the already-running Obsidian plugin through the desktop automation helper"
      fi
    fi
  else
    if [[ $HEADLESS -eq 0 ]]; then
      echo "[run.sh] No sync targets configured (set $SYNC_CONFIG or pass --no-sync)"
    fi
  fi
fi

CMD=(node esbuild.config.mjs)
if [[ ${#DEV_ARGS[@]} -gt 0 ]]; then
  CMD+=("${DEV_ARGS[@]}")
fi

CMD_ENV=(
  "SYSTEMSCULPT_SYNC_CONFIG=$SYNC_CONFIG"
)
if [[ $SYNC_ENABLED -eq 1 ]]; then
  CMD_ENV+=("SYSTEMSCULPT_AUTO_SYNC=1")
else
  CMD_ENV+=("SYSTEMSCULPT_AUTO_SYNC=0")
fi
if [[ $HOT_RELOAD_ENABLED -eq 1 ]]; then
  CMD_ENV+=("SYSTEMSCULPT_AUTO_RELOAD=1")
else
  CMD_ENV+=("SYSTEMSCULPT_AUTO_RELOAD=0")
fi
if [[ $HEADLESS -eq 1 ]]; then
  CMD_ENV+=("SYSTEMSCULPT_AUTO_SYNC_QUIET=1")
fi

set +e
env "${CMD_ENV[@]}" "${CMD[@]}"
DEV_EXIT_CODE=$?
set -e

exit "$DEV_EXIT_CODE"
