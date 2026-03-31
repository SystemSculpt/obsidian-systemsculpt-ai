# Autoresearch: ChatView Chronology And Hosted Continuation Completion

## Objective

Keep assistant output truly chronological in ChatView and prevent managed
SystemSculpt turns from stalling after repeated hosted tool rounds.

The visible turn must preserve emitted order during streaming and after reload.
If the model emits reasoning, tool calls, more reasoning, and then content, the
UI must show that same interleaving instead of collapsing whole sections.

Managed SystemSculpt continuations must also finish with final answer content
when upstream tool-call ids repeat across rounds. The bad failure shape is:
multiple assistant tool-use messages with blank content, no final answer, and a
turn that stops only because the continuation loop cap is hit.

The same request must still complete on Pi/provider-backed models so we can
prove the cutoff bug is isolated to the managed hosted transcript path.

## Experiment Contract

- `autoresearch.md` is the durable program for this comparable segment.
- `autoresearch.sh` / `autoresearch.checks.sh` / `autoresearch.config.json`
  stay fixed unless the experiment contract itself changes.
- If the objective, metric, benchmark workload, editable surface, or locked
  harness changes materially, start a new `config` segment in
  `autoresearch.jsonl`.

## Branch Context

- current branch: `main`
- comparison boundary for this segment starts from an already-dirty tree that
  contains the chronology v1 renderer/serializer changes

## Primary Metric

- **Name:** `failing_checks`
- **Direction:** lower
- **Unit:** count

## Secondary Metrics

- `renderer_order_ok` — live DOM keeps assistant parts in emitted order
- `reasoning_layout_ok` — only adjacent reasoning merges; separated reasoning
  stays separate
- `serializer_roundtrip_ok` — persisted markdown reload preserves chronology
- `hosted_unique_tool_call_ids_ok` — hosted continuation requests keep repeated
  raw tool-call ids unique round to round
- `bridge_open_history_ok` — desktop automation bridge can reopen saved chats
  for durable reload QA
- `desktop_client_history_ok` — desktop automation client can drive the history
  reopen route directly
- `input_handler_tool_loop_ok` — hosted/local continuation behavior stays green
- `streaming_controller_ok` — nearby stream assembly guard still passes
- `build_ok` — plugin bundle still builds cleanly after the touched changes

## Iteration Budget

- benchmark wall-clock budget: under 5 minutes for the local deterministic
  harness
- broader checks and live desktop proof run after keep candidates

## Confidence Policy

- low-confidence threshold: `0`
- confirm runs required: `1`
- noise estimate source: deterministic local Jest and `node --test` suites
- confidence is high only when:
  - chronology suites pass
  - hosted repeated-id regression stays green
  - bridge/client reload helpers stay green
  - nearby stream loop checks pass
  - real Obsidian proof shows the managed prompt now finishes with final
    content and the provider-backed parity turn also finishes

## Current Best

- failing history repro:
  - saved chat `2026-03-31 00-40-04` reloads as 5 messages total
  - 4 assistant messages are blank and contain only completed tool calls
  - duplicate raw tool ids appear across rounds, matching the bad managed
    continuation shape
- live fixed managed proof:
  - chat `2026-03-31 03-57-53` on `systemsculpt@@systemsculpt/ai-agent`
    finished with final answer content after 3 assistant messages
  - the managed rerun no longer stalls at blank tool-use rounds
- live provider parity proof:
  - chat `2026-03-31 03-58-18` on
    `local-pi-openrouter@@openai/gpt-5.4-mini` also finished with final answer
    content
  - this points to the cutoff bug being isolated to the managed hosted
    transcript-remapping path, not the Pi/provider execution path
- why this is kept:
  - `SystemSculptService.toSystemSculptApiMessages()` now allocates unique API
    tool-call ids per assistant occurrence and binds later tool results to the
    correct occurrence instead of reusing raw upstream ids across rounds
  - chronology reload rendering remains green
  - open-history bridge/client helpers make the failing saved chat easy to
    reopen for future QA

## How To Run

```bash
bash autoresearch.sh
bash autoresearch.checks.sh
```

## Files In Scope

- `src/views/chatview/MessageRenderer.ts`
- `src/views/chatview/storage/ChatMarkdownSerializer.ts`
- `src/views/chatview/__tests__/message-renderer-order.test.ts`
- `src/views/chatview/__tests__/message-renderer-reasoning-layout.test.ts`
- `src/views/chatview/__tests__/chat-markdown-serializer-order.test.ts`
- `src/services/SystemSculptService.ts`
- `src/services/__tests__/SystemSculptService.test.ts`
- `src/testing/automation/DesktopAutomationBridge.ts`
- `src/testing/automation/__tests__/DesktopAutomationBridge.test.ts`
- `testing/native/desktop-automation/client.mjs`
- `testing/native/desktop-automation/client.test.mjs`
- `src/css/components/chat-activity-block.css`
- `src/css/components/messages.css`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.jsonl`

## Editable Surface

- `src/views/chatview/MessageRenderer.ts`
- `src/views/chatview/storage/ChatMarkdownSerializer.ts`
- `src/views/chatview/__tests__/message-renderer-order.test.ts`
- `src/views/chatview/__tests__/message-renderer-reasoning-layout.test.ts`
- `src/views/chatview/__tests__/chat-markdown-serializer-order.test.ts`
- `src/services/SystemSculptService.ts`
- `src/services/__tests__/SystemSculptService.test.ts`
- `src/testing/automation/DesktopAutomationBridge.ts`
- `src/testing/automation/__tests__/DesktopAutomationBridge.test.ts`
- `testing/native/desktop-automation/client.mjs`
- `testing/native/desktop-automation/client.test.mjs`
- `src/css/components/chat-activity-block.css`
- `src/css/components/messages.css`
- `autoresearch.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.ideas.md`
- `autoresearch.jsonl`

## Locked Harness

- `scripts/jest.mjs`
- `jest.config.cjs`
- `src/views/chatview/__tests__/streaming-controller.test.ts`
- `src/views/chatview/__tests__/input-handler-tool-loop.test.ts`
- the already-open native Obsidian desktop host and its bridge discovery path

## Off Limits

- unrelated model catalog or provider-auth UX changes
- non-chat desktop automation features unrelated to reload/history proof
- changing the message-part data model or introducing new dependencies

## Constraints

- no new dependencies
- preserve the existing message-part data model
- keep streaming updates incremental; do not regress assistant rendering to a
  full chat reload
- reload ordering must come from persisted message parts, not ad hoc UI sorting
- live desktop proof must stay attach-only to the already-open vault

## Logs

- ledger: `autoresearch.jsonl`
- benchmark/check logs: `autoresearch-logs/`
- live proof bundle:
  `autoresearch-logs/20260330T195753801Z/cutoff-live-proof/`
- deferred ideas: `autoresearch.ideas.md`

## Benchmark Notes

- The local benchmark is deterministic and fully repo-local.
- The benchmark is invalid if it stops checking either:
  - chronology render/reload order, or
  - hosted repeated-id regression coverage.
- The live proof uses the real `private-vault` desktop bridge and reopens the
  original failing chat before sending fresh managed and provider-backed turns.

## What's Been Tried

- chronology v1:
  - renderer now keeps assistant parts as keyed chronological blocks instead of
    aggregate activity/reasoning sections
  - serializer now round-trips sequential reasoning/tool/content blocks in
    source order
- hosted cutoff diagnosis:
  - failing managed bundle showed 8 completed hosted continuation requests, no
    errors, and 8 assistant tool-use messages before the loop cap
  - raw hosted tool-call ids such as `functions.mcp-filesystem_list_items:0`
    and `functions.mcp-filesystem_search:1` repeat across rounds
  - the old managed transcript mapper reused those raw ids globally, which
    collapsed distinct assistant rounds onto the same API tool-call ids
- durability work:
  - desktop automation bridge gained `/v1/chat/open-history`
  - desktop automation client gained `openChatHistory()`
  - saved failing chat can now be reopened in the automation leaf for future
    QA and screenshots
