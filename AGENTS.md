# AGENTS.md

Single source of truth for AI agents working in this repo (the SystemSculpt AI
Obsidian plugin). `CLAUDE.md` is a symlink to this file — **edit `AGENTS.md`**.

## Merge autonomy, proven by CI

- An agent driving an approved work program may branch, push, open PRs, and
  merge **without per-step human approval**.
- A change is "done" only when **CI/CD proves it on the PR**. Local green is
  necessary, never sufficient — CI is the proof of correctness.
- Merge **only** when every required check **and** every automated review is
  green on the merge commit:
  - `ci.yml` — tsc/bundle check, full unit suite, embeddings, production build,
    built-bundle integration suite.
  - `macos-e2e.yml` — real Obsidian install + release smoke (provider listing,
    chat round-trip, recorder, embeddings) against local provider fixtures.
  - `windows-e2e.yml` — Obsidian install, clean-install parity, provider pass,
    Windows desktop baselines.
  - The automated PR reviewer — read the posted findings, not just the check
    rollup.
- Never merge red, pending, or unverified. Never bypass CI. Treat
  HIGH/MEDIUM/CRITICAL review findings as blockers: fix them, or justify
  accepting each one in the PR before merging.
- **One issue per PR.** Stay with the PR until it is green, then merge.

## Always strengthen the test net

- Every behavioral change lands **failing-test-first**, at the cheapest layer
  that actually catches the regression (see `CONTRIBUTING.md` for the layer
  table).
- A recurring regression earns a **permanent CI guard**, never a one-off manual
  check. Example: #201 (provider dropdown) → `testing/integration/provider-listing.test.ts`.
- Leave the suite stronger than you found it: each PR adds or tightens coverage
  for what it touched. Testing should get better every release, not just stay
  level.
- #215 built the foundation — the built-bundle integration harness, reusable
  provider fixtures (`testing/fixtures/providers/`), and the CI release-smoke
  lanes. New rework rides on it.

## Where things live

- Test layers, provider fixtures, and pre-PR gates: `CONTRIBUTING.md`.
- Native/runtime harness (desktop, mobile, device lanes): `testing/native/` and
  `testing/README.md`.
- Unattended orchestration (Symphony/Codex) keeps its own stricter publish
  rule — publish only when the issue explicitly asks: see `WORKFLOW.md`.

## Local gates before pushing

```bash
npm run check:plugin:fast   # tsc + bundle + script tests + unit
npm test                    # full unit suite
npm run test:integration    # production build + built-bundle suite
```

CI re-runs these plus the macOS and Windows E2E lanes on every PR. A PR is
ready to merge when all of them — and the automated reviewer — are green.
