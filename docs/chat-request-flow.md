# ChatView → Request Flow (Baseline)

This document maps the end-to-end path when a user sends a message from ChatView, showing the exact order of message assembly, system prompt handling, context injection, tool usage, and streaming.

## High-level Flow

1. User types text and clicks Send.
2. `InputHandler.handleSendMessage()` creates a user `ChatMessage` and appends it to history/UI.
3. `ChatTurnOrchestrator.runTurn()` starts one assistant stream; if Agent Mode is on and tools run, it may continue with follow-up assistant turns.
4. `SystemSculptService.streamMessage()` builds the outbound request (system prompt + context + messages + tools), opens a streaming request, and yields chunks.
5. `StreamingController` renders streaming parts (reasoning/content/tool calls) and finalizes the assistant message.
6. `onAssistantResponse` merges/saves the finalized assistant message in `ChatView.messages`.

## Call Graph (key pieces)

- UI: `ChatView` → `uiSetup.ts` wires `InputHandler`
- Send: `InputHandler.handleSendMessage()` → `ChatTurnOrchestrator.runTurn()`
- Stream: `ChatTurnOrchestrator.streamAssistant()` → `SystemSculptService.streamMessage()`
- Assembly: `ContextFileService.prepareMessagesWithContext()` + `SystemPromptService.getSystemPromptContent()`
- Tools: `ToolCallManager` (create, update, and collect results)
- Render: `StreamingController` + `MessagePartManager` + `MessageRenderer`

## Request Assembly Order (what is sent to the model)

The request `messages` array is produced inside `ContextFileService.prepareMessagesWithContext()` and then used by `SystemSculptService.streamMessage()`.

1) System message (always first)

- Source: `SystemPromptService.getSystemPromptContent(type, path, agentMode)`.
- If Agent Mode is ON and the selected prompt type is not `agent`, the agent prompt is prefixed to the selected prompt (concatenation) before sending.
- If prompt cannot be resolved, a minimal fallback prompt is used.

2) Conversation history (prior turns)

- All user/assistant messages from `ChatView.messages` are included with their `role`, `content`, `message_id`.
- Assistant tool calls:
  - If Agent Mode is ON, assistant messages with `tool_calls` are kept and normalized for the API. Matching tool result messages (role=`tool`) are generated on-the-fly from stored results and appended immediately after the assistant message.
  - If Agent Mode is OFF, tool calls are stripped from assistant messages and only their textual content is sent.
- Any existing `role: "tool"` messages in `ChatView.messages` are ignored (tool results are reconstructed from `tool_calls`).

3) Context messages (files and vault structure)

- Context files are inserted immediately before the most recent user message.
- For regular files: a `user` message is created as `Context from <path>:\n\n<contents>`.
- For images: a multi-part `user` message is created with a `text` part and an `image_url` part.
- Vault structure (if enabled): a `user` message with a summarized directory map is created.
- Document references (`doc:<id>`) are attached to the last user message via `documentContext.documentIds` and not sent as separate messages.

4) Tooling hint in system prompt (when tools available)

- Now unified via `PromptBuilder.buildSystemPrompt(...)` which assembles: base prompt → optional agent prefix → optional tools hint. `SystemSculptService` computes tools up front, calls `PromptBuilder`, and passes the final prompt to `ContextFileService.prepareMessagesWithContext(...)` so the system message ID is deterministic for the final content.

5) Plugins / Web search (optional)

- If web search is enabled, an OpenRouter-compatible `plugins` array is included in the provider-specific request (e.g., `{ id: "web-search", max_results: N }`).

## Provider/Transport

- Custom providers use an adapter that builds a provider-specific body and transforms the response into a consistent stream format.
- Transport/streaming decisions are centralized in `PlatformContext`, which flags mobile/runtime constraints and chooses between native `fetch` streaming and Obsidian `requestUrl` fallbacks (including SSE replay when streaming is unavailable).
- The native SystemSculpt API receives `{ model, messages, stream: true, include_reasoning: true, ... }`.
- Image parts are preserved initially; if the provider rejects them, the request is retried without images with an inline footnote in the UI.
- If a provider rejects tools, a retry without tools occurs (with inline footnote explaining the downgrade).

## Runtime Checks and Guardrails

- Model availability: errors bubble to `ChatView.handleError()` which switches models or prompts user.
- Images: detection and conditional retry without images when unsupported.
- Tools: conditional inclusion based on Agent Mode and provider capability; read-only tools auto-approve, mutating tools require approval unless allowlisted in settings.
- Tool schemas are normalized before requests: all properties are marked required for provider compatibility and any `strict` flags are stripped.
- Continuations: after tools finish, if no newer user message exists, run another assistant stream without resending context files.

## Streaming & Finalization

- Streaming chunks yield `reasoning`, `content`, and `toolCalls`.
- `StreamingController` interleaves parts, updates tool call UI, and saves incrementally (debounced).
- Final assistant message merges any tool calls and is persisted via `onAssistantResponse`.

## Observations (baseline organization)

- System prompt construction is centralized: `PromptBuilder` composes the effective prompt and `ContextFileService` inserts it. No later mutation of the system message.
- Chat storage records both `content` and `messageParts` for assistant messages. `messageParts` drives rendering; `content` acts as a fallback/snapshot.
- Tool messages are not stored directly; they are derived from `assistant.tool_calls` on request assembly, preventing drift between UI and request payload.
- Context files are injected at a single, clear point: immediately before the latest user message.
- Retries (without tools/images) are handled within the service layer and surfaced to the UI via inline footnotes.

## Notable Friction / Potential Cleanups

- Tool hint in system prompt: consolidated in `PromptBuilder`.
- System prompt export path uses the same agent-prefix combination helper in `SystemPromptService` (kept consistent).
- `getMessages()` → `toApiBaseMessages()` helper replaces ad‑hoc stripping of `messageParts`.
- Web search/plugin flags are injected in adapters via an `extras` parameter to `buildRequestBody` (currently used by OpenRouter).

## TL;DR Order

1) System message (selected prompt; maybe agent-prefixed) 
2) Conversation messages up to now (assistant tool_calls normalized when Agent Mode ON) 
3) Context messages inserted immediately before the latest user message (files, images, vault summary) 
4) Document IDs attached to the latest user message (if any) 
5) Optional tools declaration + system prompt note (Agent Mode ON) 
6) Optional `plugins` (web search) depending on provider
