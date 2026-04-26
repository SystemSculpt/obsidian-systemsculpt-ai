# ChatView Continuation And Session Rework Plan

Date: 2026-04-26

## Goal

Make ChatView continuation boringly reliable.

The user should always understand what is happening during a turn, especially when the assistant is thinking, calling tools, executing tools, waiting on a hosted continuation, retrying, or failing after partial work. A submitted user message must not randomly disappear after the system has accepted it. Completed local tool work must not vanish from the visible transcript because a later hosted continuation returned empty.

## Live Failure Evidence

- A realistic vault discovery prompt succeeded: ChatView listed a scenario folder, read relevant notes, ignored the unrelated note, and answered with the expected root cause, owner, due date, impact, and source files.
- A follow-up realistic write/readback prompt failed with `The hosted agent returned an empty response.` The requested output file was not created.
- A heavier live task listed and read files, kept the progress counter visible for the wait, then failed with `The hosted agent returned an empty continuation after tool execution.` The output report was not created.
- Before progress plumbing changes, the visible UI could sit in a silent gap after tool rows completed. After progress plumbing changes, the visible status stayed attached as `Preparing... 0:50`, which confirms the status surface direction is right but the continuation/session contract is still broken.

## Root Causes

1. **Hosted continuation can be empty after valid tool results.**
   The plugin shapes OpenAI-compatible history with assistant `tool_calls` and matching `tool` messages, but the active hosted Workers AI path can still proxy a successful empty stream. The website route does not currently enforce "content, another tool call, or typed error" for post-tool continuations.

2. **ChatView uses preflight-style rollback for partially committed turns.**
   `resetFailedAssistantTurn()` removes the submitted user message from memory/DOM and restores the prompt to the composer. That may be acceptable before the turn is committed, but it is wrong after assistant/tool work has been rendered or saved.

3. **DOM, memory, and disk are not updated atomically on failure.**
   The user message is saved before streaming. Tool results can be saved before continuation. The failure path can remove DOM without removing or saving the corresponding memory state, causing visible transcript drift.

4. **Streaming completion classification is too coarse.**
   `StreamingController` returns only `completed`, `aborted`, or `empty`. Reasoning-only, no-events, and empty-after-seed all collapse into `empty`, so the turn loop cannot make precise retry/recovery decisions.

5. **Retries are blind repeats.**
   Empty continuation retries change the UI status but do not change the server-visible request or prompt. If the backend/provider deterministically returns an empty continuation for a transcript, the client repeats the same failure.

6. **Progress ownership was split across stream lifecycle and turn lifecycle.**
   The new `ChatTurnProgressController` moves this in the right direction, but the final design should make turn progress the only owner for visible turn status.

## Target State Model

Every chat send should have an explicit turn transaction. The source of truth is `ChatView.messages`; DOM is rendered from that state, not manually patched as an alternate truth.

States:

- `composer_draft`: text only exists in the composer.
- `submitted_user`: user message has been accepted, rendered, and saved. It should stay visible unless the failure happened before commit.
- `assistant_draft`: streaming shell exists but has no committed visible content or tool call.
- `assistant_committed`: assistant emitted visible content or a tool call. Preserve it.
- `tool_execution_committed`: local tool result has completed and is durable evidence. Preserve it.
- `continuing`: waiting for hosted continuation after one or more local tool results.
- `retrying_continuation`: empty/no-events/reasoning-only continuation is being retried.
- `failed_after_commit`: turn failed after the submitted user, assistant, or tool work committed. Keep committed transcript rows and append a compact failure status.
- `completed`: final answer was emitted and the turn closed cleanly.

## Ownership Boundaries

### `InputHandler`

Owns turn orchestration:

- create a turn transaction
- submit the user message
- stream assistant rounds
- execute local hosted tools
- persist intermediate tool results
- retry continuation
- call failure recovery with enough metadata to distinguish preflight failure from post-commit failure

### `StreamingController`

Owns stream assembly and classification:

- assemble reasoning/content/tool-call parts
- preserve seeded parts during continuation
- return richer completion states:
  - `completed`
  - `aborted`
  - `no_events`
  - `reasoning_only`
  - `empty_after_seed`
- never decide whether to remove committed user/tool state

### `ChatTurnProgressController`

Owns visible turn status:

- one elapsed timer per turn
- status labels for preparing, thinking, using tools, running tools, continuing, retrying, failed, completed
- reattach across message rerenders
- clear every old target indicator/footnote when the turn ends

### `ChatView`

Owns transcript state and recovery:

- replace broad `resetFailedAssistantTurn()` usage with a commit-aware recovery path
- keep submitted user messages after commit
- keep completed tool rows after commit
- remove only uncommitted assistant drafts
- persist failure markers through `saveChat()`

### `ContextFileService` And `toChatCompletionsMessages`

Own transport correctness:

- expand compact assistant/tool histories
- synthesize missing tool result messages for completed local tool calls
- remap tool-call ids and matching `tool_call_id`s together
- provide debug validation that every assistant tool call has a following matching tool result before a continuation request is sent

### Website `/api/v1/chat/completions`

Own hosted continuation semantics:

- if a transcript ends with assistant tool calls plus matching tool results, the next response must contain visible assistant content, another tool call, or a typed error
- Workers AI path must track whether a stream emitted content/reasoning/tool-call payloads
- empty successful streams must fail, retry with a fallback route, or return a typed continuation error
- add a Workers AI continuation regression test

## Implementation Task List

### Phase 1: Freeze The Contract With Tests

- Add deterministic InputHandler test for a two-tool, three-round hosted turn:
  - round 1 emits reasoning + `mcp-filesystem_list_items` + `toolUse`
  - local execution completes
  - round 2 emits reasoning + `mcp-filesystem_read` + `toolUse`
  - local execution completes
  - round 3 emits final content
  - assert one user message, one assistant message, completed tool calls, final content, no duplicate IDs, no blank assistant
- Add deterministic failure test for empty continuation after completed tools:
  - user message stays in transcript
  - completed tool rows stay in transcript
  - composer may optionally contain retry text, but transcript is not rolled back
  - failure marker is visible/persisted
- Add StreamingController tests for `no_events`, `reasoning_only`, and `empty_after_seed`.
- Add progress tests for reattachment and cleanup across multiple message targets.
- Add SystemSculptService request-preview validation for generated continuation transcripts:
  - assistant `tool_calls` are followed by matching `tool` messages
  - remapped IDs stay consistent

### Phase 2: Turn Transaction Model

- Introduce a small `ChatTurnTransaction` or equivalent internal object.
- Track:
  - `turnId`
  - submitted user message ID/text
  - assistant message ID
  - committed phase
  - completed tool count
  - latest stream completion classification
  - failure reason
- InputHandler should pass transaction metadata into ChatView failure recovery.
- Avoid adding broad framework abstractions; keep it close to ChatView/InputHandler.

### Phase 3: Commit-Aware Failure Recovery

- Replace default catch-all `resetFailedAssistantTurn()` with `recoverFailedTurn(transaction, error)`.
- Pre-commit failures:
  - restore composer
  - remove transient user draft if it was never saved
- Post-user-commit failures:
  - keep the user message
  - remove only uncommitted empty assistant shell
  - show a compact error status
- Post-tool-commit failures:
  - keep the user message
  - keep assistant tool rows and completed results
  - append/update failure status on the assistant turn
  - do not visually erase tool evidence
- Save after recovery so disk matches memory/DOM.

### Phase 4: Rich Stream Classification

- Change `StreamCompletionState` from `completed | aborted | empty` to include:
  - `no_events`
  - `reasoning_only`
  - `empty_after_seed`
- Track `eventCount`, reasoning output, content output, and tool output in StreamingController.
- InputHandler retry policy:
  - retry `no_events`
  - retry `reasoning_only` only when no content/tool output arrived
  - after tools, convert exhausted retries into `failed_after_commit`, not rollback
  - log classification metadata for debug snapshots

### Phase 5: Continuation Prompt Guardrail

- When retrying after a post-tool empty continuation, add a minimal server-visible continuation hint rather than blindly repeating the exact transcript.
- Keep this hint transport-local; do not pollute visible user transcript.
- Example intent:
  - "The previous continuation produced no assistant content after tool results. Continue from the provided tool results and either call the next tool or provide the final answer."
- Add a test proving the retry request differs from the first continuation request.

### Phase 6: Website Hosted Contract

In `/Users/systemsculpt/gits/systemsculpt-website`:

- Add Workers AI regression coverage for:
  - assistant tool call history + matching tool result -> final content
  - empty Workers AI stream after tool result -> typed error or fallback
- Track streamed payload classes on the Workers AI branch:
  - role only
  - content
  - reasoning
  - tool call
  - finish only
- Treat role-only/finish-only success as a contract failure.
- For tool-result continuations, prefer one of:
  - fallback to the Pi/OpenAI-compatible path
  - retry with explicit continuation instruction
  - return typed `EMPTY_TOOL_CONTINUATION` error
- Do not charge credits for empty contract-failure completions.

### Phase 7: Native And Live Proof

- Run deterministic Jest first; native/live model tests are proof, not the main gate.
- Run `chatview-stress` after code-level tests pass.
- Run live private-vault scenarios:
  - find/read folder notes
  - write handoff file and read it back
  - multi-tool report with list/read/write/readback
- Use Computer Use screenshots during a long turn to confirm the progress surface remains visible.

## Acceptance Criteria

- Submitted user message never disappears after it has been accepted into the transcript.
- Completed tool calls and results remain visible after a later continuation failure.
- Empty/reasoning-only continuations do not create persisted blank assistant messages.
- Progress status remains visible through preparing, thinking, running tools, continuation wait, retry, and failure.
- The elapsed timer does not reset between tool execution and hosted continuation in a single turn.
- The transcript, DOM, and saved markdown agree after both success and failure.
- Transport preview proves every assistant tool call has a matching tool result before hosted continuation.
- Website hosted route cannot silently proxy an empty successful continuation after tool results.
- Live write/readback task creates the requested output file and verifies it.

## Verification Commands

Plugin focused tests:

```bash
npm test -- --runInBand \
  src/views/chatview/__tests__/input-handler-tool-loop.test.ts \
  src/views/chatview/__tests__/streaming-controller.test.ts \
  src/views/chatview/controllers/__tests__/ChatTurnProgressController.test.ts \
  src/views/chatview/handlers/__tests__/MessageElements.test.ts \
  src/services/__tests__/SystemSculptService.test.ts \
  src/services/__tests__/ContextFileService.test.ts
```

Plugin full ChatView slice:

```bash
npm test -- src/views/chatview
```

Plugin build and live reload:

```bash
npm run build
npm run sync:local
node scripts/reload-local-obsidian-plugin.mjs
```

## Implementation Notes

Implemented on 2026-04-26:

- `StreamingController` now distinguishes `no_events`, `reasoning_only`, and `empty_after_seed` instead of collapsing every non-renderable stream into `empty`.
- `InputHandler` now tracks hosted turn transaction metadata, retries empty continuations with a transport-only continuation hint, and marks post-commit failures as recoverable transcript failures.
- `ChatView` now has committed-turn recovery: submitted user messages remain visible, completed tool rows remain visible, transient empty assistant drafts are removed, and a compact failure marker is persisted on the assistant turn.
- `ChatTurnProgressController` owns the visible turn status for the whole hosted loop, including retrying and local tool execution phases.
- The website Workers AI stream path now checks that a stream contains assistant content, reasoning, or tool calls before forwarding final success and charging credits. Empty Workers AI tool continuations return a typed `EMPTY_TOOL_CONTINUATION` stream error instead.

Verification completed:

- Plugin focused continuation tests: `47` tests passed across `StreamingController`, `InputHandler`, committed-turn recovery, and `SystemSculptService`.
- Full ChatView slice: `57` suites / `395` tests passed.
- Plugin checker: TypeScript, bundle, script tests, and unit tests passed through `npm run check:plugin`.
- Website route regression: `tests/plugin/chat-completions-api.test.ts` passed with the new empty Workers AI continuation case.
- Website type check: `npm run type-check` passed.
- Native desktop ChatView stress: `5/5` passes against the reloaded `private-vault` Obsidian instance.
- Live local Pi/Codex tool task: completed `3` filesystem tool calls, wrote the output file, and replied with the exact token.
- Live managed SystemSculpt tool task: completed `2` filesystem tool calls, wrote the output file, and replied with the exact token.

Known environment warning:

- `npm run sync:local` updated the macOS vaults and reloaded `private-vault`, but the Windows UTM mirror target timed out over SSH at `192.168.64.2:22`.

Native proof:

```bash
node testing/native/desktop-automation/run.mjs \
  --case chatview-stress \
  --repeat 3 \
  --pause-ms 750 \
  --no-reload
```

Website route tests:

```bash
pnpm vitest --run tests/plugin/chat-completions-api.test.ts
```

## Non-Goals

- Do not redesign the whole ChatView visual language in this pass.
- Do not add another parallel transcript format.
- Do not hide backend/provider empty continuation failures behind fake success.
- Do not make live model behavior the only regression gate.
- Do not preserve local/custom-provider compatibility branches that conflict with the hosted SystemSculpt path.
