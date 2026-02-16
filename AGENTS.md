# Repository Guidelines

## Multi-Agent Safety (CRITICAL)

Assume multiple agents (and humans) may work in parallel.

- NEVER run destructive git commands unless explicitly asked.
- Only stage files you personally changed.

## Scope & Invariants

- This repo is the canonical SystemSculpt Obsidian plugin codebase.
- Prefer clean modular architecture over backward-compat layering.
- Fail loudly on invalid config/provider states.

## Build/Test/Run

```bash
npm install
npm run build
npm run lint
npm test
```

## Code/Review Rules

- Keep UI, services, and provider integration boundaries explicit.
- No silent fallback logic for provider failures.

## Security & Side Effects

- Never commit API keys, tokens, or local vault private data.
- External sends/publishes require explicit approval.

## E2E Reality Checks

- For real integration verification, run live E2E (`bash testing/e2e/run.sh live`) against the real SystemSculpt API.
- Live E2E must use a real local `SYSTEMSCULPT_E2E_LICENSE_KEY` (from local env/private settings), never mocked keys.
- `npm run check:e2e` is TypeScript validation only; it does not execute browser E2E flows.
- Treat image-generation E2E as valid only after API preflight for `/images/models` and `/images/generations/jobs`.

## Memory Hygiene

- Durable behavior rules only.
- Keep root AGENTS <= 8192 bytes.
