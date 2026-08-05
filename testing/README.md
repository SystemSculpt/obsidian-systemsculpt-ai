# Testing architecture

The plugin has four local test layers:

1. src/**/__tests__ proves module behavior with Jest, including seeded
   lifecycle, persistence, rendering, approval, queue, and recovery races.
2. testing/integration imports the production bundle and proves managed
   contracts plus Obsidian host composition.
3. scripts/*.test.mjs proves build, release, workflow, mobile-import, sync, and
   repository policy.
4. The retired managed-chat replay fixture remains hash-pinned as a released
   compatibility artifact. Behavioral validation of that legacy server route
   belongs to the website API; the plugin does not replay it through a second
   client-owned projector.

Managed fixtures live in testing/fixtures/managed; versioned settings inputs
live in testing/fixtures/settings. Default tests need no provider key, hosted
service, installed app, physical device, or remote host.

testing/e2e is the live-app lane, not a CI gate: testid-catalog.json is the
generated catalog of every `data-testid` the product renders, and scenarios/
holds deterministic GUI journeys for `npm run e2e -- script <file>` against a
running development build. See "CLI E2E driving" in docs/development.md.

## Normal loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

Use a focused Jest path when it names the behavior more clearly.

## Broader gates

~~~bash
npm run check:ui
npm run check:mobile
npm run test:embeddings
npm run test:integration
npm run test:chatview:critical
npm run test:chatview:mutants
npm run test:thin-agent:endurance
npm run check:plugin
npm run check:ci
npm run check:compat
npm run check:full
~~~

- check verifies Obsidian lint, metadata, the production bundle, CSS, cheap
  architecture policy, focused mobile interactions, ChatView critical-risk
  coverage, and the built bundle in a mobile host.
- check:mobile runs static mobile policy; focused host, narrow-pane, touch,
  accessibility, and Studio capability tests; then rebuilds the artifact and
  opens settings, Chat, Similar Notes, and Studio without desktop-only globals.
- test:integration imports the production artifact in the Obsidian host mock.
- check:plugin adds types, mobile, sync, artifact, and release guards.
- test:chatview:critical uses strict console, randomized test order with a
  printed replay seed, open-handle detection, adversarial thin-session and
  local-persistence cases, and per-file uncovered-code budgets on the
  high-risk ChatView seams.
- test:chatview:mutants copies only the required source and fixture trees into
  an isolated temporary mirror, applies 5 curated AST-anchored regressions one
  at a time, and requires focused tests to kill every one. It runs without
  coverage or randomized order so a survivor is deterministic and actionable.
- test:thin-agent:endurance drives the real headless Chat, Bridge, native
  transport, approval, mutation-journal, reconnect, and terminal seams through
  the credential-free long-run fixture.
- check:ci is the exact exhaustive PR gate: check:plugin plus the critical-risk
  and mutation gates, focused mobile interactions, strict randomized unit and
  embeddings tests, already-built integration, and release suites.
- test:unit:ci is the partitioned remainder. It excludes every focused
  critical-risk and mobile path already run earlier in check:ci, so breadth
  does not require a third execution of the same suites.
- check:compat is the exact smaller gate for the Node and operating-system
  compatibility matrix. It reruns every critical ChatView suite without
  repeating the coverage instrumentation already enforced by check:ci.
- check:full is the local alias for check:ci.

CI runs check:ci on Ubuntu/Node 22. It also runs check:compat on Node 22.18,
Node 24, macOS/Node 22, and Windows/Node 22 with fail-fast disabled. All jobs
are credential-free. A stable `required` job fails unless every lane succeeds.
There is no native-device or provider matrix.

Each top-level hosted Jest gate writes its normalized child argv and replay
seed into `.cache/ci-evidence/jest-seeds`. Failed jobs retain that evidence,
the coverage summary, artifact inspection, provenance, and exact plugin
artifact bytes for 14 days. The curated mutation runner records its baseline
plus every killed, surviving, or infrastructure-failed mutant, along with its
exact child Jest commands, in
`.cache/ci-evidence/chatview-critical-mutants.json`.
Before a failed hosted gate uploads artifacts, CI validates that build
provenance and artifact-inspection sidecars exist and are valid JSON.
Release validation records SHA-256 and size for every shipped byte plus source
revision and build-environment identity without changing the three-file plugin
artifact contract. It writes a version-qualified release record alongside the
rolling CI provenance so the tag-push gate cannot overwrite the release
evidence.

The installed pre-push hook runs check:ci. The workflow and package-script
policy tests prevent local and hosted gate definitions from silently drifting.
The merge queue event runs the same workflow. Repository branch protection
must require the stable `required` job before merge.

The release:plugin command also requires check:ci before it rebuilds and
validates release artifacts, so the local release path cannot bypass the
exhaustive gate. It only succeeds from a clean worktree when the version tag
resolves to the same full revision recorded in provenance, and the CLI cannot
reuse pre-existing artifacts without rebuilding them.

Saved chat parsing is intentionally fail-closed. Malformed or truncated
histories are excluded from indexes and never returned as a shortened prefix.
A direct load leaves the source note untouched, resets the view to a fresh
unsaved chat, and keeps a visible corruption banner.

To replay a randomized failure exactly, copy the printed seed:

~~~bash
# macOS, Linux, and Git Bash
SYSTEMSCULPT_TEST_SEED=<seed> npm run test:unit:ci
~~~

~~~powershell
# PowerShell
$env:SYSTEMSCULPT_TEST_SEED = "<seed>"
npm run test:unit:ci
~~~

## Mobile QA contract

Mobile confidence is layered. Static policy rejects Node, Electron, raw
Platform, and private host-selector leakage. Focused source tests exercise
owned mobile state, container-query contracts, touch paths, keyboard and
accessibility behavior, and Studio capability fallback. The integration suite
then loads main.js from the exact production artifact with desktop adapters
unavailable and checks that its compiled styles.css still contains the shared
touch, safe-area, and narrow-surface rules.

These deterministic layers are the PR and release gates. They do not claim to
be an installed Obsidian Mobile host. Android emulators, iOS Simulator, browser
viewport emulation, synthetic DOM events, and physical-device exploration may
provide supplemental evidence when explicitly requested, but they are not
release requirements and must not replace or weaken the deterministic checks.

## Real-app verification

systemsculpt-sync.config.json is ignored and lists local Obsidian plugin
targets. ./run.sh copies successful artifacts while watching. Use the official
Obsidian CLI or Computer Use for live reload, runtime errors, DOM inspection,
and visual behavior.

### ChatView QA loop

Run the deterministic ChatView gate before live checks:

~~~bash
npm run qa:chatview:deterministic
~~~

Confirm that the watcher uses the canonical checkout. Restart it when the QA
vault reports another revision:

~~~bash
npm run dev:watch:status
npm run dev:watch:install
npm run e2e -- status --json
~~~

The status result must name the current development build ID. Do not accept a
version-only match.

The driver reads the target manifest and fails when Obsidian loaded another
development build. Use `--expected-build <id>` for a staging manifest that has
no development identity. Every evidence report records the plugin version,
loaded build, and expected build.

Run the normal live acceptance in the configured QA vault:

~~~bash
npm run qa:chatview:live -- --evidence /absolute/path/chatview-live.json
~~~

This journey uses provider credits. It checks an exact text response, copy
feedback, saved history, a text attachment, and manual approval. It verifies
the proposed path and content before approval. It then reads the unique file
under `QA/E2E` and requires exact content. A failed journey does not hide later
journeys. The command still exits with failure.

Run one live journey when you must isolate a failure:

~~~bash
npm run qa:chatview:live:text -- --evidence /absolute/path/chatview-text.json
npm run qa:chatview:live:attachment -- --evidence /absolute/path/chatview-attachment.json
npm run qa:chatview:live:approval -- --evidence /absolute/path/chatview-approval.json
~~~

Run the long tool loop only when the normal live acceptance passes:

~~~bash
npm run qa:chatview:stress -- --evidence /absolute/path/chatview-stress.json
~~~

The stress journey uses provider credits and creates a unique folder under
`QA`. It makes about 30 separate vault calls. It fails on a silent stall.

Each `waitForRun` result records these client-visible durations:

- `runStartedMs`: Submit to active-run UI.
- `firstVisibleFeedbackMs`: Submit to visible assistant activity.
- `firstVisibleContentMs`: Submit to the first visible reasoning, tool, or text part.
- `completedMs`: Submit to the finished UI.

These values start when the wait action begins, a few milliseconds after the
synthetic Enter event. They are UI acceptance values. They are not provider
TTFT or browser-paint measurements.
