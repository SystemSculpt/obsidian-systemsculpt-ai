# SystemSculpt Benchmark (v2)

This benchmark runs *inside the SystemSculpt Obsidian plugin* and is designed to help users compare the vault-tooling efficacy of different models/providers under the same tasks, tools, and constraints.

## What it measures

Each benchmark case is an agent workflow inside a sandboxed vault. Scoring is points-based and includes:

- **Correctness**: did the agent produce the expected final vault state?
- **Efficiency**: how efficiently did it get there (tool calls, time, estimated tokens, etc.)?

The benchmark is deterministic and auto-graded (no LLM judge required).

## Difficulty tiers (single suite)

SystemSculpt runs a single benchmark suite that is ordered by difficulty:

- **Easy** → baseline vault-editing and tool-usage sanity checks
- **Medium** → distractors + cross-file invariants (including link integrity) + a large-file task (~100KB) to stress search/reading efficiency
- **Hard** → reserved for future expansion (more adversarial multi-step workflows)

When you click **Run**, the suite runs from beginning to end (Easy first, then Medium, then Hard when added).

To speed up iteration, the BenchView has a **difficulty filter** (All/Easy/Medium/Hard). It defaults to **All tests**.

## Hard-case design goals

Hard cases are designed to increase *cognitive load* (not just “more tool calls”), while remaining deterministic and auto-graded. Common hard levers:

- Multi-criteria disambiguation (choose the correct target among near-duplicates)
- Cross-file invariants (indices, backlinks, logs, derived fields that must stay consistent)
- Instruction-hierarchy safety (ignore “do X” instructions embedded in vault files)
- Precision constraints (update links everywhere *except* fenced code blocks, preserve quoted/code sections exactly)

### Avoiding brittleness

To keep the benchmark professional and fair:

- Prefer “copy/transform exact text from the vault” over open-ended writing.
- Include explicit tie-break rules so there is only one correct outcome.
- Keep prompts explicit about what must not change (callouts/code fences/frontmatter/etc.).

### Calibration loop (to avoid saturation)

If a state-of-the-art model scores 100% across Easy+Medium+Hard, the benchmark is saturated. Iterate by adding one additional complexity lever at a time to Hard cases, using the difficulty filter to run **Hard only** during tuning.

## How to run

1. In Obsidian, open the command palette
2. Run: **Open SystemSculpt Benchmark**
3. Select a model
4. Click **Run**
5. Optionally click **Save Results** to export a markdown report to your configured `benchmarksDirectory` (default: `SystemSculpt/Benchmarks`)

## Sandbox and artifacts

Runs execute in a sandboxed benchmark vault under:

- Active sandbox root: `.systemsculpt/benchmarks/v2/active`
- Run artifacts: `.systemsculpt/benchmarks/v2/runs/<runId>/`

Per-case artifacts are stored under:

- `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/result.json`
- `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/transcript.json`
- `.systemsculpt/benchmarks/v2/runs/<runId>/cases/<caseId>/vault/` (snapshot of the sandbox after the case)

The run summary is stored at:

- `.systemsculpt/benchmarks/v2/runs/<runId>/run.json`

## Scoring model

### Points + percent

- Each case has a `maxPoints` (or inherits the suite default).
- The UI and reports display both:
  - `pointsEarned / maxPoints`
  - `scorePercent = (pointsEarned / maxPoints) * 100`

### Correctness vs efficiency weighting

Each suite defines default weights:

- `weights.correctness` (0..1)
- `weights.efficiency` (0..1)

By default, Obsidian Core uses:

- `0.7` correctness
- `0.3` efficiency

### Correctness grading

Correctness is graded by comparing the final sandbox snapshot to the expected snapshot (fixture + `expectedUpdates`), using whitespace-tolerant normalization for Markdown bodies.

For scoring (not pass/fail), correctness is computed from:

- **Required paths**: the paths listed in the case’s `expectedUpdates`. Each required path earns partial credit based on how close the final file is to the expected file (line-diff based).
- **Collateral changes**: any diffs outside of `expectedUpdates` are treated as correctness failures for scoring (i.e., “don’t touch unrelated files” matters).

### Efficiency grading

Efficiency is graded against per-case or suite-default budgets (when provided), using a simple decay above budget:

- If `actual <= budget`: full credit for that metric
- If `actual > budget`: score scales by `budget / actual`

Current budgetable metrics:

- Tool calls (`maxToolCalls`)
- Wall time (`maxWallTimeMs`)
- Tool execution time (`maxToolExecutionMs`)
- Estimated tokens (`maxEstimatedTokens`)
- Read/write character counts (`maxReadChars`, `maxWriteChars`) derived deterministically from tool requests/results (best-effort)

### Status vs score

Case `status` reflects correctness execution state:

- `pass`: no mismatches in the expected snapshot
- `fail`: mismatches exist
- `error`: case failed to execute
- `skipped`: run aborted before the case

Efficiency affects the score even if a case is `pass`.

## Extending the benchmark

When adding new cases/suites:

- Keep cases deterministic and auto-gradable.
- Set `difficulty` (`easy` | `medium` | `hard`) and keep cases ordered by increasing difficulty (single suite; no separate “easy suite”, “medium suite”, etc.).
- Prefer invariant checks and structured grading over brittle full-text diffs where possible.
- Define realistic efficiency budgets per case to discourage wasted tool calls and unnecessary reads/writes.
- Ensure all tools are still scoped to the sandbox root.
