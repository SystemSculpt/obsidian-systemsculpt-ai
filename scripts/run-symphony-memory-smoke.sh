#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
symphony_elixir_root="${SYMPHONY_ELIXIR_ROOT:-$HOME/gits/symphony/elixir}"

export SYMPHONY_SMOKE_REPO_ROOT="$repo_root"

cd "$symphony_elixir_root"
exec /opt/homebrew/bin/mise exec -- mix run --no-start "$repo_root/scripts/symphony_memory_smoke.exs"
