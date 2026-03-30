# Autoresearch: ChatView Pi Tool Calling

## Objective

Stabilize ChatView local Pi tool-calling so Pi-executed tools are rendered as
completed local work instead of being reinterpreted as hosted external tool
requests.

This segment also needs the desktop provider-connected baseline to exercise real
ChatView filesystem tool prompts on `local-pi-openrouter@@openai/gpt-5.4-mini`
so the same contract is covered on both macOS and Windows.

Windows exposed a second requirement for this segment: provider auth inventory
must read the canonical bundled Pi auth storage directly. Silent runtime-
relative fallbacks are not acceptable because they hide broken production paths
instead of surfacing the real failure.

## Experiment Contract

- `autoresearch.md` is the durable program for this comparable segment.
- `autoresearch.sh` / `autoresearch.checks.sh` / `autoresearch.config.json`
  stay fixed unless the experiment contract itself changes.
- If the objective, metric, benchmark workload, editable surface, or locked
  harness changes materially, start a new `config` segment in
  `autoresearch.jsonl`.

## Branch Context

- current branch: `main`
- branch state: `ahead 1`
- working tree: intentionally dirty with the active autoresearch edits listed
  below

## Primary Metric

- **Name:** `failing_checks`
- **Direction:** lower
- **Unit:** count

## Secondary Metrics

- `pi_local_executor_ok` — local Pi stream contract covers tool execution end-state
- `streaming_controller_ok` — ChatView stream layer updates tool calls correctly
- `input_handler_tool_loop_ok` — hosted loop does not re-execute completed Pi tools
- `desktop_runner_ok` — desktop runner coverage proves the provider-connected baseline case
- `mac_provider_connected_ok` — live macOS provider-connected tool-call pass
- `windows_provider_connected_ok` — live Windows provider-connected tool-call pass

## Iteration Budget

- benchmark wall-clock budget: under 10 minutes for local checks
- checks cadence: every run for local targeted tests, live macOS/Windows
  provider-connected passes on keep candidates when the bridges/auth are
  available

## Confidence Policy

- low-confidence threshold: `0`
- confirm runs required: `1`
- noise estimate source: deterministic pass/fail local checks
- confidence is high once the local checks pass together, the targeted auth
  preflight stays green, and the live provider-connected lanes are re-run on
  both platforms

## Current Best

- run: `chatview-pi-tool-calling-v2 keep @ 2026-03-30T16:22:10Z`
- `failing_checks`: `0`
- local benchmark log: `autoresearch-logs/20260330T161837Z`
- live macOS provider pass: `mac_provider_connected_ok=1`
- live Windows provider pass: `windows_provider_connected_ok=1`
- why it stays kept: the rebuilt plugin kept the full local harness green,
  Windows now flips OpenRouter auth state from `none` to `api_key` through the
  canonical bundled auth-storage path, and both macOS and Windows completed the
  real filesystem tool turn on `local-pi-openrouter@@openai/gpt-5.4-mini` with
  `completedRelevantToolCallCount=3`

## How to Run

```bash
bash autoresearch.sh
npm test -- --runInBand \
  src/studio/piAuth/__tests__/studio-pi-auth-storage-fetch-shim.test.ts \
  src/services/pi/__tests__/PiSdkRuntime.paths.test.ts \
  src/__tests__/settings-providers-tab.import-safe.test.ts
npm run build
node testing/native/device/windows/remote-run.mjs --entry ./testing/native/device/windows/bootstrap.mjs -- --launch
SYSTEMSCULPT_DESKTOP_PROVIDER_ID=openrouter \
SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID=openai/gpt-5.4-mini \
SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY="$OPENROUTER_API_KEY" \
  npm run test:native:windows:provider-connected
SYSTEMSCULPT_DESKTOP_PROVIDER_ID=openrouter \
SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID=openai/gpt-5.4-mini \
SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY="$OPENROUTER_API_KEY" \
  npm run test:native:desktop:provider-connected
```

## Files in Scope

- `src/services/pi-native/PiLocalAgentExecutor.ts` — local Pi stream bridge
- `src/streaming/types.ts` — stream tool-call contract
- `src/views/chatview/controllers/StreamingController.ts` — ChatView tool-call assembly
- `src/views/chatview/InputHandler.ts` — hosted tool-loop continuation rules
- `src/studio/piAuth/StudioPiAuthInventory.ts` — provider auth inventory must use
  the canonical bundled auth-storage path
- `src/services/pi-native/__tests__/PiLocalAgentExecutor.test.ts` — local Pi regression lock
- `src/views/chatview/__tests__/streaming-controller.test.ts` — stream/tool-call state regression lock
- `src/views/chatview/__tests__/input-handler-tool-loop.test.ts` — hosted-loop regression lock
- `testing/native/desktop-automation/runner.mjs` — provider-connected baseline coverage
- `testing/native/desktop-automation/runner.test.mjs` — desktop runner regression lock
- `src/studio/piAuth/__tests__/studio-pi-auth-storage-fetch-shim.test.ts` —
  auth inventory preflight verification
- `src/services/pi/__tests__/PiSdkRuntime.paths.test.ts` — bundled auth-path
  preflight verification
- `src/__tests__/settings-providers-tab.import-safe.test.ts` — import-safety
  guard around provider surfaces
- `autoresearch.*` — durable experiment state

## Editable Surface

- `src/services/pi-native/PiLocalAgentExecutor.ts`
- `src/streaming/types.ts`
- `src/views/chatview/controllers/StreamingController.ts`
- `src/views/chatview/InputHandler.ts`
- `src/studio/piAuth/StudioPiAuthInventory.ts`
- `src/services/pi-native/__tests__/PiLocalAgentExecutor.test.ts`
- `src/views/chatview/__tests__/streaming-controller.test.ts`
- `src/views/chatview/__tests__/input-handler-tool-loop.test.ts`
- `testing/native/desktop-automation/runner.mjs`
- `testing/native/desktop-automation/runner.test.mjs`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.jsonl`

## Locked Harness

- `testing/native/desktop-automation/client.mjs`
- `testing/native/device/windows/run-desktop-automation.mjs`
- `scripts/jest.mjs`
- provider auth/setup flows and existing desktop bridge attach behavior

## Off Limits

- hosted tool execution semantics for non-Pi chats
- unrelated model inventory/catalog behavior
- mobile runtime smoke unless the desktop baseline change requires shared helper reuse

## Constraints

- preserve hosted external tool-call execution for managed/SystemSculpt chats
- keep the provider-connected baseline pinned to the Pi OpenRouter GPT-5.4 Mini path
- no new dependencies
- macOS and Windows automation should assert completed tool calls, not just text output
- do not add silent fallbacks that mask broken canonical auth/runtime paths

## Logs

- ledger: `autoresearch.jsonl`
- benchmark/check logs: `autoresearch-logs/`
- deferred ideas: `autoresearch.ideas.md`
- latest local harness: `autoresearch-logs/20260330T161837Z`
- latest Windows tool output: `SystemSculpt/QA/NativeRuntimeFixtures/current/desktop-automation-output-1774887633770.md`
- latest macOS tool output: `SystemSculpt/QA/NativeRuntimeFixtures/current/desktop-automation-output-1774887693956.md`

## Benchmark Notes

- The fast benchmark is local and deterministic: targeted Jest + desktop runner
  node tests only.
- Run the targeted auth preflight before live desktop passes whenever the
  provider inventory or auth-storage path changes.
- Live provider-connected verification depends on existing bridge availability
  and provider auth on the local macOS vault and the Windows QA machine.
- If the fast checks pass but a live provider-connected lane fails, treat that
  as a keep/discard decision point instead of claiming success.

## What's Been Tried

- Segment reset: widened the editable surface from the initial ChatView-only
  files to include `src/studio/piAuth/StudioPiAuthInventory.ts` after the real
  Windows failure proved the provider auth read path was part of the same end-
  to-end contract.
- Keep:
  - Wire Pi `tool_execution_end` through the local executor, stream contract,
    and ChatView controller so completed local Pi tools stay completed instead
    of being re-executed as hosted tool calls.
  - Extend the provider-connected desktop baseline so both macOS and Windows
    assert the real filesystem tool turn, output preview, and completed tool
    call counts on `local-pi-openrouter@@openai/gpt-5.4-mini`.
  - Remove the runtime-relative auth-storage fallback from
    `StudioPiAuthInventory` and import `createBundledPiAuthStorage` directly.
- Discard:
  - Returning `null` from a runtime-relative `require("../../services/pi/PiSdkAuthStorage")`
    fallback in `StudioPiAuthInventory`, because it hides broken bundled reads
    in production instead of failing on the canonical path.
- Open questions:
  - Audit nearby provider/setup code for any other silent runtime-relative
    fallbacks that can hide broken canonical paths in the built plugin.
