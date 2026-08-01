# thin-agent-v1 application contract

`thin-agent-v1` is the stable boundary between the SystemSculpt plugin and the server-owned agent.

The server owns the durable session, ordered history, model execution, provider state, retries, compaction, caching, and server tools. The plugin owns Obsidian UI, vault capabilities, approvals, and local mutation receipts.

## Canonical fixture

The fixture exists at both paths:

- Website: `src/lib/plugin/contracts/fixtures/thin-agent-v1/thin-agent-v1.json`
- Plugin: `testing/fixtures/managed/thin-agent-v1/thin-agent-v1.json`

The files have identical bytes with SHA-256 `50b8cf158c4a8b3de6a5353abb49e22bbe5c9db91290c233a136564b6932e0ce`.

A fixture change is a protocol change. It requires compatibility review against released plugin builds.

## Bootstrap

The plugin sends `POST /api/plugin/agent/bootstrap` through the normal license-authenticated API.

```json
{
  "contract_version": "thin-agent-v1",
  "conversation_id": "conversation_<32 lowercase hex>",
  "client_id": "client_<32 lowercase hex>",
  "plugin_build_id": "sha256:<64 lowercase hex>",
  "capability_manifest": {
    "contract_version": "thin-agent-capabilities-v1",
    "capabilities": [
      { "id": "obsidian.vault", "version": 1 }
    ]
  }
}
```

The request includes `x-plugin-version`. The body does not repeat that value. The server rejects a bootstrap request larger than 32 KiB. The plugin rejects a bootstrap response larger than 64 KiB.

The response is:

```json
{
  "contract_version": "thin-agent-v1",
  "conversation_id": "conversation_<32 lowercase hex>",
  "session": {
    "id": "session_<32 lowercase hex>"
  },
  "access": {
    "token": "<short-lived opaque token>",
    "expires_at": "2030-01-01T00:01:00.000Z"
  },
  "run_state": {
    "version": 1,
    "cursor": 0,
    "state": "idle"
  },
  "client_input_limits": {
    "image_mime_types": ["image/png", "image/jpeg", "image/webp"],
    "max_content_blocks_per_message": 16,
    "max_images_per_turn": 6,
    "max_image_bytes": 6291456,
    "max_total_image_bytes": 16777216,
    "max_text_bytes_per_block": 1048576,
    "max_total_text_bytes": 2097152,
    "max_document_bytes": 26214400
  },
  "accepted_capabilities": [
    { "id": "obsidian.vault", "version": 1 }
  ]
}
```

The server derives session identity from the authenticated account and conversation ID. An exact bootstrap retry returns the same session. It can return a new access token.

The token binds the account, session, conversation, client, contract, and capability hash. The raw license never appears in an agent URL.

The plugin can reuse one valid bootstrap for snapshot reads, context staging, and turns. It bootstraps again after token expiry or a `401` response.

## Run state

Idle state contains `version`, `cursor`, and `state`.

A `running` or `waiting_for_client` state also contains:

```json
{
  "request_id": "<request ID>",
  "run_id": "run_<32 lowercase hex>",
  "root_message_id": "<user message ID>"
}
```

`waiting_for_client` means that the server waits for an approval or vault-tool result.

The cursor increases with durable run-state changes. A client ignores lower cursors. Different states at one cursor are a protocol error.

## Snapshot synchronization

Before command delivery, the plugin reads:

```text
GET /api/plugin/agent/connect/get-messages?access_token=<access token>
```

The response body is one `session_snapshot` event. It contains the complete authoritative UI history and run state. Its encoded size cannot exceed 64 MiB. There is no rolling message-count cap. Server-side model compaction does not truncate this UI history.

The snapshot can include up to 256 `queued_request_ids`. It contains no queued message content. It also includes up to 256 recent `cancelled_queued_request_ids`. These receipts let a disconnected client settle a queued cancellation after restart. The server retains every cancellation identity for direct idempotent replay, even when it leaves this bounded snapshot projection.

The response also carries the bounded `x-systemsculpt-agent-run-state` header. This header lets compatible clients compare state by cursor.

A session does not send commands before it accepts a valid snapshot.

## Streaming command route

The plugin sends commands to:

```text
POST /api/plugin/agent/turn?access_token=<access token>
```

The request body is one `systemsculpt.agent.command.v1` JSON object. The response is `text/event-stream`. Each event contains one `systemsculpt.agent.event.v1` JSON object. One command or event frame cannot exceed 64 MiB.

The stream closes when the command segment ends. A segment ends at terminal state or when the server parks for client work. Concurrent commands remain queued with their own response open. Each response receives only events for its request. A scoped `queue_snapshot` never exposes another request's queued user message. An admission `session_snapshot` goes only to its request stream.

### Commands

Supported command kinds are:

- `submit`
- `regenerate`
- `client_tool_approval`
- `client_tool_result`
- `cancel`

A submit includes one new user message and an optional `context_ref`:

```json
{
  "type": "systemsculpt.agent.command.v1",
  "version": 1,
  "kind": "submit",
  "request_id": "<stable request ID>",
  "user_message": {
    "id": "<same stable user message ID>",
    "role": "user",
    "parts": [
      { "type": "text", "text": "User text" }
    ]
  },
  "context_ref": "<optional opaque context reference>"
}
```

A regenerate command identifies the authoritative root message. It does not carry client history.

Approval and result commands include the original request ID and stable tool-call ID. Result state is `output-available` or `output-error`.

### Events

Supported event kinds are:

- `session_snapshot`
- `assistant_snapshot`
- `run_state`
- `terminal`
- `queue_snapshot`
- `command_ack`

The server can also add bounded forward-compatible events. The client ignores unknown event kinds after identity validation.

`command_ack` confirms acceptance. A duplicate acknowledgement has no additional effect.

## Uncertain delivery recovery

A failed HTTP response does not prove that the server rejected its command.

After uncertain delivery, the client must:

1. mark the session unsynchronized;
2. read a fresh authoritative snapshot;
3. reconcile the pending command against history and run state;
4. remove a command already accepted by the server;
5. replay only unresolved work with the same request and tool-call IDs.

Submit, regenerate, approval, result, and cancel admission are idempotent for their stable IDs.

A cancel request does not create terminal state before server authority. The client shows `Stopping` until an authoritative terminal event or snapshot confirms cancellation. A request-scoped snapshot precedes the cancel `command_ack`; the acknowledgement alone confirms delivery, not the final outcome. The client reconciles and replays an uncertain cancel like every other command. The server retains cancellation identities so a replay receives the same snapshot receipt. If no matching work remains, the server acknowledges cancellation as an authoritative idempotent no-op. The no-op durably fences that request ID so delayed delivery cannot start it.

The client never repeats a local vault mutation to recover command delivery. It reuses the durable mutation receipt and replays only the recorded result.

## Context staging

After bootstrap, the plugin can send:

```text
POST /api/plugin/agent/context?access_token=<access token>
```

```json
{
  "contract_version": "thin-agent-v1",
  "root_message_id": "<user message ID>",
  "context_sources": [
    {
      "kind": "text",
      "path": "Projects/Plan.md",
      "content": "Private selected vault context."
    }
  ]
}
```

Context sources support bounded text, image data URLs, and document references. The HTTP body limit is 24 MiB.

A successful response is:

```json
{
  "contract_version": "thin-agent-v1",
  "context_ref": "<opaque signed reference>",
  "expires_at": "2030-01-01T02:00:00.000Z",
  "bytes": 143,
  "sha256": "sha256:<64 lowercase hex>"
}
```

The turn command carries only `context_ref`. It does not carry raw context, tool schemas, provider settings, or history.

## Historical edit and fork

Editing an earlier user message creates a new conversation ID. Bootstrap adds:

```json
{
  "fork": {
    "source_conversation_id": "conversation_<32 lowercase hex>",
    "before_message_id": "<message ID>"
  }
}
```

The server verifies source ownership and copies authoritative history before the boundary. The edited user message starts the destination branch.

An exact fork retry is idempotent. Conflicting target intent returns `conversation_conflict`.

The destination has a separate durable session. The server also preserves source cache-affinity lineage. This affinity allows provider cache reuse for matching prefixes without sharing mutable session state.

## Capability ownership

The complete v1 manifest is:

```json
{
  "contract_version": "thin-agent-capabilities-v1",
  "capabilities": [
    { "id": "obsidian.vault", "version": 1 }
  ]
}
```

`obsidian.vault@1` maps to these released local tools:

`context`, `create_folders`, `edit`, `find`, `list_items`, `move`, `multi_edit`, `open`, `read`, `search`, `trash`, and `write`.

The server owns model-facing tool descriptions, schemas, and risk classes. The plugin sends only the aggregate capability.

The canonical capability manifest is:

```text
{"capabilities":[{"id":"obsidian.vault","version":1}],"contract_version":"thin-agent-capabilities-v1"}
```

Its server-computed hash is `sha256:fb3e72b592556f80d6047339bdef5d82c0570b195f1abc8a8c9a3d7bf162d22c`.

## Application data parts

### Client tool request

`data-systemsculpt-client-tool-request` identifies one requested Obsidian capability. It includes the stable tool-call ID, tool name, `obsidian.vault@1` target, and bounded input.

### Run terminal

`data-systemsculpt-run-terminal` is persisted in the final assistant message:

```json
{
  "type": "data-systemsculpt-run-terminal",
  "data": {
    "version": 1,
    "run_id": "run_<32 lowercase hex>",
    "root_message_id": "<user message ID>",
    "outcome": "failed",
    "code": "service_temporarily_unavailable",
    "message": "The service is temporarily unavailable.",
    "incident_id": "incident_<32 lowercase hex>",
    "retryable": true
  }
}
```

A successful terminal uses `outcome: "succeeded"` and `code: "completed"`. A cancelled terminal uses `outcome: "cancelled"` and `code: "cancelled"`.

The client accepts a terminal only for the active root message and run identity.

## Message files

Composer files use AI SDK UI file parts. Images keep their image MIME type. Text files keep their text MIME type.

The document service extracts a PDF as framed, untrusted Markdown. The remote part uses `text/markdown` and a derived `.extracted.md` name. The plugin keeps the original PDF name and MIME type for local presentation.

## Frozen legacy compatibility

`managed-capabilities-v2` stays byte-for-byte frozen for pre-migration clients. It does not become execution authority for `thin-agent-v1`.

Later model, prompt, provider, retry, caching, compaction, or server-tool changes must work with the stable application contract.
