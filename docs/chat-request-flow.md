# Chat request flow

Last verified against code: **2026-02-11**.

This doc describes the current send/stream pipeline for ChatView.

## Main pipeline

1. User sends a message in `ChatView`.
2. `InputHandler` appends the user message and starts `streamAssistantTurn(...)`.
3. `SystemSculptService.streamMessage(...)` prepares model, prompt, context, and tools.
4. Service opens a provider stream and yields normalized `StreamEvent` chunks.
5. `StreamingController.stream(...)` renders chunks, tracks tool calls, and persists final assistant output.
6. If PI indicates tool continuation (`stopReason = toolUse`), `InputHandler` decides whether to continue the turn.

## Key components

- Entry UI: `src/views/chatview/ChatView.ts`
- Send orchestration: `src/views/chatview/InputHandler.ts`
- Request assembly + provider routing: `src/services/SystemSculptService.ts`
- Prompt composition: `src/services/PromptBuilder.ts`, `src/services/SystemPromptService.ts`
- Context + tool-message shaping: `src/services/ContextFileService.ts`
- Streaming/render/persist: `src/views/chatview/controllers/StreamingController.ts`
- Tool execution + policy: `src/views/chatview/ToolCallManager.ts`, `src/utils/toolPolicy.ts`

## Request assembly order

`ContextFileService.prepareMessagesWithContext(...)` and `SystemSculptService.prepareChatRequest(...)` produce the request payload.

1. System message is added first.
2. Conversation history is normalized.
3. Context file messages are inserted before the latest user message.
4. Document references (`doc:<id>`) are attached to the latest user message.
5. Tool declarations are added when Agent Mode is active and tool-compatible.

## Tool surfaces currently injected in chat

- Filesystem MCP tools
- YouTube transcript MCP tool
- Web research tools (`web_search`, `web_fetch`)

Web tools are registered in `ChatView.ensureCoreServicesReady()` via `registerWebResearchTools(...)`.

## Compatibility and fallback behavior

`SystemSculptService` checks model compatibility for tools and images.

- If tools are unsupported, tool declarations are removed.
- If image input is unsupported, image context is removed.
- Service can retry without tools/images when provider responses indicate incompatibility.

## Streaming events handled

`StreamingController` processes these event types:

- `reasoning`
- `reasoning-details`
- `content`
- `tool-call`
- `annotations`
- `meta`
- `footnote`

Final assistant message includes merged content, parts, tool calls, annotations, and optional stop reason.

## Continuation logic

After a streamed turn completes, `InputHandler.shouldContinuePiTurn(...)` checks:

- Agent Mode is active
- Turn completed successfully
- `stopReason` is `toolUse`
- Tool calls for that message reached a settled state

If true, the next PI-managed turn is started.
