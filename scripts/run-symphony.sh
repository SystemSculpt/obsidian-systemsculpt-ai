#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
args=("$@")
workflow_path="$repo_root/WORKFLOW.md"
linear_api_key_path="${LINEAR_API_KEY_PATH:-$HOME/.linear_api_key}"

if [ -z "${LINEAR_API_KEY:-}" ] && [ -f "$linear_api_key_path" ]; then
  export LINEAR_API_KEY="$(tr -d '\r\n' < "$linear_api_key_path")"
fi

if [ "${#args[@]}" -gt 0 ] && [[ "${args[0]}" == *.md ]]; then
  workflow_path="${args[0]}"
  args=("${args[@]:1}")
fi

if [ "${#args[@]}" -gt 0 ]; then
  exec symphony \
    --i-understand-that-this-will-be-running-without-the-usual-guardrails \
    "${args[@]}" \
    "$workflow_path"
else
  exec symphony \
    --i-understand-that-this-will-be-running-without-the-usual-guardrails \
    "$workflow_path"
fi
