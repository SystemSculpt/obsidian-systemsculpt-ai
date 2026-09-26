# Source ownership

Start with [the glossary](../CONTEXT.md), then find the owner below. Read its
public operations and behavioral tests before following private helpers.
[AGENTS.md](../AGENTS.md) defines product constraints;
[CONTRIBUTING.md](../CONTRIBUTING.md) defines design and review standards.

## Find the behavior to change

| Behavior | Start here | Ownership |
|---|---|---|
| Plugin startup and disposal | `src/main.ts`, `src/core/plugin/` | Composes capabilities and Obsidian commands/views; delegates their state and policies. |
| Chat execution | `src/chat/ChatSession.ts`, `src/chat/managed/ChatSession.ts` | Shared session contract and managed conversation synchronization, local tools, approvals, and replay safety. |
| Managed conversation projection | `src/chat/managed/ConversationProjection.ts` | Optimistic display, interrupted responses, exact local-result overlays, and live/durable message conversion. |
| Chat presentation | `src/views/chatview/AgentChatView.ts`, `AgentConversationRenderer.ts` | Composer, conversation projection, interaction, rendering, and view lifecycle. |
| Saved chats | `src/views/chatview/ChatStorageService.ts`, `storage/`, `persistence/`, `attachments/` | Local transcript and attachment storage, strict parsing, and restore. A saved note is not execution authority. |
| Managed operations | `src/services/managed/` | First-party capability admission, job transport, reconnect, and delivery contracts. Capability-specific consumers live beside audio, images, video, and embeddings. |
| Native Codex | `src/services/codex/LocalCodexClient.ts`, `CodexChatSession.ts`, `StudioAgentRuns.ts` | Native transport, one-turn execution, chat adaptation, and explicit project run instances. Codex owns the agent loop. |
| Studio project edits | `src/studio/StudioProjectSession.ts`, `StudioProjectSessionManager.ts` | Shared editable project state, save/rebase, and retained session lifetime. |
| Studio persistence | `src/studio/StudioProjectStore.ts`, `document/`, `persistence/` | One readable `.systemsculpt` document per project: validated import, three-way merged UI and agent edits, stamped field merges of copies from other devices by the merge record each file carries, atomic publication, and independent support-file reconciliation. |
| Studio execution | `src/studio/StudioService.ts`, `StudioRuntime.ts`, `StudioGraphCompiler.ts`, `nodes/` | User-requested scopes, typed dependency plans, immutable run snapshots, execution gates, and node results. |
| Studio interaction | `src/views/studio/SystemSculptStudioView.ts`, `canvas/`, `connections/` | Obsidian leaf, canvas cards, visual connections, editors, and pointer/keyboard interaction. |
| Studio edit history | `src/views/studio/StudioGraphHistory.ts` | Each view's local edit transactions, rebased onto the shared canvas for undo/redo. Restoration preserves unrelated peer edits and the accepted disk baseline. |
| Vault operations | `src/tools/FirstPartyToolService.ts`, `src/tools/vault/` | Advertised local actions, validated vault paths, execution, and typed results. |
| Audio Processor | `src/features/audio-processor/AudioProcessorService.ts`, `AudioProcessorDelivery.ts` | Input/job workflow and durable local output delivery respectively. |
| Inbox automation | `src/features/inbox-transcription/InboxTranscriptionService.ts` | Vault event admission, batching, user confirmation, and cancellation for automatic transcription. |
| Search and Similar notes | `src/services/search/`, `src/services/embeddings/` | Vault indexing/search and managed semantic index integration. |
| Account and settings | `src/core/settings/`, `src/settings/`, `src/services/AccountConnectService.ts` | Settings persistence/migration, settings presentation, and account connection respectively. |
| Diagnostics | `src/core/diagnostics/` | Content-free incident capture, bounded persistence, session startup, rotation, and teardown. |
| Shared data primitives | `src/utils/sha256.ts`, `base64.ts` | Content hashing and byte encoding used across capabilities. These are independent of Studio and presentation. |
| Desktop and window behavior | `src/platform/`, `src/core/ui/surface/` | Host capabilities, desktop adapters, mobile host chrome, owner-window DOM, and shared surface interaction. |

`src/studio/` owns project semantics; `src/views/studio/` owns their presentation.
Execution edges, diagram arrows, and parent links have distinct meanings even
when all three are visible on the canvas. The Studio service is the external
composition point; its store and session objects own their own invariants.

`src/chat/` holds backend-independent conversation contracts and the managed
session implementation. Native Codex adapts to that contract without importing
a view. `src/views/chatview/` owns the Obsidian workspace and readable local
transcripts. Do not add an agent continuation loop to either module.

## Interfaces and dependencies

Import the capability that owns the operation directly. There is no repository
wide barrel or generic service layer to forward every call. Private helpers may
be split within an owner, but callers must not assemble its state machine from
those helpers or mutate its backing collections.

The fast gate's `scripts/module-ownership.test.mjs` parses imports, including
type-only, re-exported, and lazy imports. It enforces host independence and
prevents chat and Studio domain code, vault tools, diagnostics, and generic utilities
from depending on presentation. Composition belongs in `src/main.ts` and
`src/core/plugin/`; those modules intentionally know the capabilities they wire.
Managed-service and native-process seams use deterministic test adapters.

Use a focused dependency type when a module needs only a small capability from
the plugin. Do not introduce another universal plugin interface or a wrapper
that forwards the same calls. Add a new adapter only when a real dependency
variation needs it.

## Verify at the owning interface

Tests live beside the capability under `__tests__/`. A concurrency or recovery
test should drive the same public operation the caller drives and inspect
observable events, results, or persisted bytes. Shared host mocks are in
`src/tests/`; managed wire fixtures are in `testing/fixtures/managed/`.

`testing/integration/` loads the actual production bundle in an Obsidian host
mock. It proves composition and wire compatibility that isolated source tests
cannot. Script tests enforce build, artifact, import, and release contracts;
they should not pin private member names or the order of constructor statements.
See [development.md](development.md) for the exact focused and exhaustive gates.

Durable tradeoffs are recorded in [execution authority](adr/0001-execution-authority.md)
and [project publication](adr/0002-project-publication.md). These explain why
some recovery and compatibility code is necessary even when it is not the
shortest implementation.
