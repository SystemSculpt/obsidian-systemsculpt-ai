#!/bin/bash
# Claude Code pre-push gate: runs unit tests + build before allowing git push.
# For full native testing (Android/Windows), run: npm run check:pre-push
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-push] Running unit tests..."
npm test --silent 2>&1 | tail -5
if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo "DENY: Unit tests failed. Fix before pushing."
  exit 1
fi

echo "[pre-push] Building plugin..."
npm run build --silent 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo "DENY: Build failed. Fix before pushing."
  exit 1
fi

echo ""
echo "Unit tests and build passed."
echo "For full native testing before a PR, run: npm run check:pre-push"
