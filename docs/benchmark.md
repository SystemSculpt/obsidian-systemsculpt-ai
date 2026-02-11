# Benchmark

Last verified against code: **2026-02-11**.

SystemSculpt includes an in-plugin deterministic benchmark suite for vault/tool workflows.

## Commands

- `Open SystemSculpt Benchmark` (`open-systemsculpt-benchmark`)
- `Open SystemSculpt Benchmark Results` (`open-systemsculpt-benchmark-results`)

## Current suite

Source: `src/benchmarks/obsidianCoreV2.ts`

- Suite id: `obsidian-core-v2`
- Version: `v2`
- Weights: correctness `0.7`, efficiency `0.3`
- Difficulty levels present: `easy`, `medium`, `hard`

## BenchView behavior

Source: `src/views/benchview/BenchView.ts`

- Select model for run.
- Optional difficulty filter: `All`, `Easy only`, `Medium only`, `Hard only`.
- Run selected tests.
- Save markdown report to configured `benchmarksDirectory` (defaults to `SystemSculpt/Benchmarks`).

## Artifacts and storage

Source: `src/services/benchmark/BenchmarkHarness.ts`

Runtime artifacts are written under plugin storage paths:

- Root: `.systemsculpt/benchmarks/v2`
- Active sandbox: `.systemsculpt/benchmarks/v2/active`
- Run folder: `.systemsculpt/benchmarks/v2/runs/<runId>`
- Case result JSON: `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/result.json`
- Case transcript JSON: `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/transcript.json`
- Case vault snapshot: `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/vault/`
- Run summary: `.systemsculpt/benchmarks/v2/runs/<runId>/run.json`

## Results view

Source: `src/views/benchresults/BenchResultsView.ts`

- Shows a leaderboard/results summary based on saved runs.
- Refresh button reloads run data from disk.
