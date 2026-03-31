# Autoresearch: ChatView Live Assistant Turn Compaction

## Objective

Make live hosted ChatView streaming use the same compact assistant-turn shape that
we already like after reload.

When one user prompt triggers multiple hosted continuation rounds, the UI should
keep everything inside one assistant container from the start:

- reasoning stays in chronological order
- tool calls stay in chronological order
- final answer content lands in that same assistant container

The current bad shape is:

- the first streamed assistant round renders in one assistant container
- later hosted continuation rounds create fresh assistant containers
- reload looks better because the persisted transcript is compacted after the
  fact

## Experiment Contract

- `autoresearch.md` is the durable program for this comparable segment.
- `autoresearch.sh` / `autoresearch.checks.sh` / `autoresearch.config.json`
  stay fixed unless this experiment contract changes materially.
- If the objective, metric, benchmark workload, editable surface, or locked
  harness changes materially, append a new `config` record to
  `autoresearch.jsonl` before comparing results again.

## Branch Context

- current branch: `main`
- baseline tree at segment start: clean tracked files, branch ahead of origin by
  one commit
- prior chronology/reload work is already present in the repo; this segment is
  specifically about live hosted continuation parity

## Primary Metric

- **Name:** `failing_checks`
- **Direction:** lower
- **Unit:** count

## Secondary Metrics

- `assistant_root_reuse_ok` — hosted continuation rounds reuse the existing
  assistant root instead of creating a new live container
- `seeded_empty_continuation_ok` — a seeded continuation with no new renderable
  output returns `empty` and preserves the prior assistant render
- `reload_compaction_ok` — the reload normalization path still compacts
  consecutive assistant messages into one assistant turn
- `build_ok` — plugin bundle still builds cleanly

## Iteration Budget

- local harness budget: under 3 minutes
- broader build pass only after a keep candidate

## Confidence Policy

- low-confidence threshold: `0`
- confirm runs required: `1`
- noise estimate source: deterministic local Jest and build checks
- confidence is high only when:
  - the new live-compaction regressions pass
  - seeded empty continuation handling stays correct
  - reload compaction still passes
  - the bundle still builds

## Current Baseline

- `InputHandler.streamAssistantTurn()` always creates a fresh assistant
  container before each hosted streamed round.
- `StreamingController.stream()` already supports `seedParts`, but the hosted
  continuation path does not currently use that capability.
- Because continuation rounds create fresh assistant roots, live hosted turns
  look split across multiple assistant containers even though reload later looks
  compact.
- A seeded stream with no new content/tool output is currently at risk of being
  treated as non-empty because completion is derived from the aggregate seeded
  summary instead of this round's new output.

## How To Run

```bash
bash autoresearch.sh
bash autoresearch.checks.sh
```

## Files In Scope

- `src/views/chatview/InputHandler.ts`
- `src/views/chatview/controllers/StreamingController.ts`
- `src/views/chatview/__tests__/input-handler-tool-loop.test.ts`
- `src/views/chatview/__tests__/streaming-controller.test.ts`
- `src/views/chatview/__tests__/chat-storage-normalization.test.ts`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.jsonl`

## Editable Surface

- `src/views/chatview/InputHandler.ts`
- `src/views/chatview/controllers/StreamingController.ts`
- `src/views/chatview/__tests__/input-handler-tool-loop.test.ts`
- `src/views/chatview/__tests__/streaming-controller.test.ts`
- `src/views/chatview/__tests__/chat-storage-normalization.test.ts`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.jsonl`

## Locked Harness

- `scripts/jest.mjs`
- `jest.config.cjs`
- message-part rendering/runtime modules outside the chatview continuation path

## Off Limits

- unrelated provider/model/auth changes
- full-chat rerender fallbacks during streaming
- message data-model redesigns or new dependencies

## Constraints

- no new dependencies
- keep streaming incremental; do not solve this by reloading the whole chat on
  every continuation round
- preserve the persisted reload compaction experience the user already likes
- keep the final user-facing flow visually compact from the first streamed round

## Logs

- ledger: `autoresearch.jsonl`
- benchmark/check logs: `autoresearch-logs/`
- deferred ideas: `autoresearch.ideas.md`

## Benchmark Notes

- the benchmark is invalid if it stops checking either:
  - live hosted continuation root reuse, or
  - reload compaction parity
- this segment is local-only; it does not require live desktop automation to
  establish pass/fail

## What's Been Tried

- prior chronology work already made reload/persisted rendering feel right
- the remaining mismatch is specifically that live hosted continuation rounds do
  not stream back into the already-rendered assistant root
