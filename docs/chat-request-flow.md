# ChatView thin-agent flow

Architecture requirement adopted: **2026-07-29**.

ChatView is a thin UI and Obsidian capability adapter for one authoritative
server-side agent. A harness, model, provider, prompt, caching, compaction,
retry, or server-tool change must not require another plugin release.

## Reused native harness

The plugin subclasses the official `AbstractChat` class from `ai` with a tiny
observable non-React state, and uses Cloudflare `AgentClient` and
`WebSocketChatTransport`.

Cloudflare currently ships `WebSocketChatTransport` from
`agents/chat/react`, whose module imports React and `@ai-sdk/react` at runtime.
Those peer dependencies remain explicit for clean mobile installs even though
ChatView itself does not use React or its hook state.

Those dependencies own:

- native UI message assembly and streaming;
- tool input, output, and approval parts;
- cancellation;
- stream continuation after a client-tool result;
- reconnect probes, pending streams, replay, and resume acknowledgement;
- authoritative message snapshots and message updates.

The plugin does not parse an AI SDK byte stream, reduce a private event
protocol, count continuation rounds, impose a turn limit, select a provider,
or decide when the model should stop. There is no client-side harness.

The small headless state exists because Obsidian does not use React. It
only:

- subscribes to the official headless `Chat` state;
- maps native UI parts into the existing Obsidian renderer model;
- applies local approval policy;
- executes requested Obsidian vault capabilities;
- returns native tool results and approval responses;
- resumes the native stream after those client interactions;
- reconciles native full-message and message-update broadcasts;
- records local mutation receipts; and
- persists the final assistant turn in the user’s chat note.

## Authority boundary

The server owns:

- the agent harness and every model continuation;
- authoritative conversation history;
- model and provider selection;
- provider retry and rate-limit handling;
- server tools such as web search;
- memory, context construction, compaction, and prompt caching;
- usage, cost, credit reservation, and settlement;
- incident diagnostics and terminal run outcome.

The plugin owns:

- ChatView input and rendering;
- native message file parts;
- reading user-selected vault context into source records;
- the implementation of `obsidian.vault@1`;
- local approval UI and policy;
- crash-safe local mutation receipts;
- a non-authoritative conversation routing pointer in the chat note.

The plugin announces only the aggregate `obsidian.vault@1` capability. It does
not send model-facing tool schemas, prompt text, provider identities, or local
history as bootstrap authority.

## Turn flow

1. The plugin bootstraps a conversation with a client ID, conversation ID,
   exact loaded `main.js` SHA-256, and `obsidian.vault@1`.
2. It constructs the official Cloudflare client and transport.
3. It installs native message, open, and close listeners before awaiting the
   socket’s ready state, so the initial authoritative history cannot race past
   the headless `Chat`.
4. After bootstrap, it stages selected vault sources once through the
   short-lived-access context endpoint and receives one opaque `context_ref`.
5. It submits the native UI user message. User attachments are native file
   parts. The Think body contains only `context_ref`.
6. The server runs for however long and through however many server-tool or
   model steps are needed.
7. A vault tool arrives as a native client-tool part.
8. The plugin obtains local approval when required, executes the one requested
   operation, and returns its native result.
9. The official transport resumes the server stream. There is no continuation
   counter or locally chosen finish condition.
10. Native message updates reconcile durable server state. Exactly one
   `data-systemsculpt-run-terminal` part identifies success, cancellation, or
   correlated failure.
11. On success, the plugin persists the assistant presentation and refreshes
    credits from the existing authoritative balance endpoint.

## Context and files

After bootstrap, the plugin stages selected context once:

```ts
{
  contract_version: "thin-agent-v1";
  root_message_id: string;
  context_sources: Array<
    | { kind: "text"; path: string; content: string }
    | { kind: "image"; path: string; data_url: string }
    | { kind: "document_ref"; path: string; document_id: string }
  >;
}
```

The server returns one opaque, expiring `context_ref`. The lazy native turn
body is then exactly:

```ts
{
  context_ref: string;
}
```

Raw context is not sent through Think, recorded in client diagnostics, or
retried by a client staging loop. These are source records, not prompt
instructions. The server decides how they enter model context. Text and image
message attachments remain native UI file parts so future supported media
types do not require a second chat protocol.

Web search is server policy and a server-side tool. It is not a client request
preference, queued-item field, or plugin-owned capability.

## Historical edit

Editing an earlier user turn creates a new conversation ID and bootstraps:

```json
{
  "fork": {
    "source_conversation_id": "conversation_<32 lowercase hex>",
    "before_message_id": "<native message ID>"
  }
}
```

The server copies authoritative history before that boundary. The plugin does
not reconstruct or replay a local transcript as execution authority.

## Mutation replay safety

Vault mutations are the only operations that require local delivery
deduplication. Before execution, the plugin durably records the tuple:

`conversation_id`, native tool-call ID, tool name, and input fingerprint.

A completed receipt returns the recorded result. A started receipt has an
unknown outcome and is never repeated automatically. A reused call ID with
different input fails closed. Receipts have no rolling cap and live until that
server conversation is deliberately deleted.

If the vault operation returns but its completed receipt cannot be written,
the plugin reports `TOOL_MUTATION_OUTCOME_UNKNOWN` as a resolved tool result
and leaves the journal unavailable. It does not retry the mutation.

## Diagnostics

Server-side runs already carry a correlated terminal incident. For client-only
failures, the plugin sends one best-effort extension frame:

`systemsculpt.client_diagnostic.v1`

It contains only a safe code, phase, severity, run ID, optional tool identity,
HTTP status, and retryability. It never contains prompts, paths, file content,
arguments, results, credentials, tickets, or stack traces. Diagnostic delivery
cannot change the user-visible turn and never retries recursively.

## Compatibility proof

The local gate exercises the official packages through a deterministic
40-continuation scenario with more than 40 vault calls, parallel tool batches,
approval, mutation replay, and reconnect. It asserts that the client has no
hard continuation limit. Focused bridge tests additionally cover:

- more than 30 parallel client-tool calls;
- initial-history listener ordering;
- post-stream native message-update terminalization;
- approval acknowledgement before mutation;
- corrupt, started, completed, conflicting, and write-failed receipts;
- receipt retention beyond the removed 256-entry cap; and
- bounded rate-limit and client-diagnostic behavior.
