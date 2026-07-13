# Managed Chat request flow

Last verified against code: **2026-07-12**.

Chat has one execution path: an accepted SystemSculpt request followed by a
managed stream. The plugin does not select a provider or model.

## Main flow

1. `InputHandler` commits the user message and captures a durable transcript
   snapshot.
2. Managed admission returns a lease for the accepted chat turn.
3. `ChatRequestPreparationService` prepares context and normalized built-in
   tools once for that accepted operation. The server owns the chat system
   prompt.
4. `AcceptedChatRequestSnapshot` freezes the managed request (`ai-agent`) and
   its policy audit before dispatch.
5. `ManagedChatRuntimeAdapter` creates a transport ticket, derives an
   idempotency key, and streams the accepted request through
   `ManagedCapabilityClient`.
6. `StreamingController` renders stream events and persists the assistant
   result.
7. When the managed response requests tool use, `InputHandler` applies the
   local approval policy, executes the built-in vault tool, persists the tool
   checkpoint, and sends a continuation from the new durable snapshot.

## Key modules

- UI and turn orchestration: `src/views/chatview/InputHandler.ts`
- Accepted request preparation: `src/services/chat/ChatRequestPreparationService.ts`
- Immutable wire snapshot: `src/services/chat/AcceptedChatRequestSnapshot.ts`
- Managed dispatch: `src/views/chatview/turn/ManagedChatRuntimeAdapter.ts`
- Managed capability contract: `src/services/managed/ManagedCapabilityClient.ts`
- Hosted transport: `src/services/managed/adapters/HostedTransportAdapter.ts`
- Stream rendering and persistence: `src/views/chatview/controllers/StreamingController.ts`
- Tool execution and policy: `src/views/chatview/ToolCallManager.ts`, `src/utils/toolPolicy.ts`

## Request ownership

The frozen request contains:

- the fixed managed model identity `ai-agent`;
- normalized conversation history;
- selected vault context and document references;
- normalized built-in tool declarations.

The API base is compiled into the plugin. Settings never own network routing,
provider credentials, or model selection.

## Built-in tool surfaces

- Local filesystem tools
- Local YouTube transcript tool

Web search is negotiated as a managed chat capability and executes on the
server. The plugin has no direct `web_search`/`web_fetch` tool or corpus writer.

Read-only tools can run automatically under the local policy. Destructive vault
tools require approval unless the user has explicitly trusted them.

## Continuations and failure behavior

Tool continuations reuse the accepted request and append only messages that
were durably committed after its original snapshot. Each phase gets a stable
idempotency key. The turn fails with a typed managed error when admission,
transport, continuation identity, or the maximum continuation depth fails; it
does not fall back to a local runtime or external provider.

`StreamingController` handles content, reasoning, tool-call, annotation, meta,
and footnote events and persists the final stop reason with the assistant turn.
