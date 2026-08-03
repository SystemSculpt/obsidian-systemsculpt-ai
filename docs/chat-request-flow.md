# ChatView thin-agent flow

Architecture requirement adopted: **2026-07-29**.

ChatView is a thin UI and Obsidian capability adapter. The server owns the agent, history, model execution, and continuation.

## Client structure

Each loaded conversation owns one `AgentChatSession` instance. A view replaces that local instance when it loads another conversation. It does not cancel server work during the replacement.

The client uses:

- `StreamingTransport` for bootstrap, snapshot reads, and streaming HTTP commands;
- `AuthoritativeSession` for ordered server state and idempotent command delivery;
- `ChatSession` for Obsidian tools, approvals, rendering, and final persistence;
- `MutationJournal` for crash-safe vault mutation receipts.

The plugin does not run a model harness. It does not select a provider, build model context, compact history, or choose continuation limits.

## Authority boundary

The server owns:

- one durable session for each conversation ID;
- ordered authoritative conversation history;
- model and provider selection;
- retries and provider rate-limit handling;
- server tools such as web search;
- memory, context construction, compaction, and prompt caching;
- usage, cost, credit reservation, and settlement;
- terminal run outcomes and incident diagnostics.

The plugin owns:

- ChatView input and rendering;
- file parts from the user message;
- selected vault context source records;
- the implementation of `obsidian.vault@1`;
- local approval UI and policy;
- durable local mutation receipts;
- a non-authoritative conversation routing pointer in each chat note.

A blank new chat creates only local state. The first user submission starts server work.

## Turn flow

1. The plugin sends one bootstrap request with the conversation ID, client ID, loaded `main.js` SHA-256, and `obsidian.vault@1`.
2. The bootstrap returns a durable session ID and short-lived access token.
3. The plugin reads one authoritative session snapshot before it sends a command.
4. The plugin stages selected vault sources and receives one opaque `context_ref`.
5. The plugin sends one idempotent submit command through streaming HTTP.
6. The server runs all model and server-tool steps.
7. A vault tool arrives as an authoritative client-tool part.
8. The plugin obtains approval when required and executes the requested vault operation.
9. The plugin sends the approval or tool result with the same request and tool-call IDs.
10. The server continues from durable state and streams authoritative updates.
11. One `data-systemsculpt-run-terminal` part identifies success, cancellation, or correlated failure.
12. On success, the plugin persists the assistant presentation and refreshes credits.

The transport reuses a valid bootstrap for identity, context staging, synchronization, and turns. Token expiry causes a new bootstrap. Durable history remains the recovery source. Concurrent server commands keep separate response streams, and each stream receives events for only its request.

## Uncertain HTTP delivery

An HTTP request can fail after the server accepts its command. The plugin must not guess whether delivery succeeded.

When command delivery becomes uncertain, the transport marks the session unsynchronized. The session then:

1. obtains a fresh authoritative snapshot;
2. reconciles the pending command against server history and run state;
3. removes work that the server already accepted;
4. replays only unresolved commands with their original idempotency IDs;
5. never repeats a local vault mutation to recover delivery.

This rule applies to submits, regenerations, approvals, tool results, and cancellations. The plugin shows `Stopping` until a terminal, snapshot, or durable queued-cancel acknowledgement confirms cancellation. A clean snapshot can also show that a run completed while the view was absent.

## Context and files

The plugin stages selected context after bootstrap:

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

The server returns one opaque, expiring `context_ref`. The turn command contains that reference, not raw vault context.

Web search is server policy and a server-side tool. It is not a plugin capability.

## Resume and historical edit

Opening a saved chat reuses its persisted conversation ID. The server snapshot replaces stale local cache state.

Editing an earlier user turn creates a new conversation ID and sends:

```json
{
  "fork": {
    "source_conversation_id": "conversation_<32 lowercase hex>",
    "before_message_id": "<message ID>"
  }
}
```

The server copies the authoritative prefix before that boundary. The destination session stays isolated. It retains the source cache-affinity lineage so matching provider prefixes can reuse cache entries.

## Mutation replay safety

Before a vault mutation runs, the plugin records this tuple:

`conversation_id`, tool-call ID, tool name, and input fingerprint.

Journal instances share one adapter-and-path state. Concurrent views serialize claims and writes to the common receipt file.

A completed receipt returns its recorded result. A started receipt has an unknown outcome and never runs automatically again. A reused call ID with different input fails closed.

If receipt persistence fails after a mutation returns, the plugin reports `TOOL_MUTATION_OUTCOME_UNKNOWN`. It does not repeat the mutation.

## Diagnostics

Client lifecycle records stay local. They contain safe identities and status fields. They do not contain prompts, paths, file content, arguments, results, credentials, access tokens, or stack traces.

## Compatibility proof

The deterministic streaming HTTP endurance test runs 40 ordered rounds with 44 vault calls. It covers parallel calls, web search, approval recovery, tool-result recovery, and exactly-once mutation replay.

Focused tests also cover:

- snapshot-first synchronization;
- uncertain submit recovery without a duplicate user message;
- approval and result acknowledgement;
- repeated synchronization after request failure;
- completed, started, conflicting, and write-failed receipts;
- receipt retention beyond the removed 256-entry cap;
- concurrent journal instances without lost receipts;
- independent overlapping conversations and historical forks;
- descendant-fork cache affinity and full-input fallback after cache expiry.
