#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

HEADLESS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless)
      HEADLESS=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

[[ $HEADLESS -eq 1 ]] || echo "[run.sh] Starting plugin build watcher"

CMD=(npm run dev)
if [[ $# -gt 0 ]]; then
  CMD+=(-- "$@")
fi

exec "${CMD[@]}"
