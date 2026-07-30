# thin-agent-v1 application contract

`thin-agent-v1` is the permanent application boundary between the
SystemSculpt plugin and the server-owned agent. It is intentionally smaller
than the transport beneath it.

The client uses the maintained native chat client and streaming transport.
Turn submission, UI message streaming, client-tool results, tool approvals,
cancellation, reconnect, and stream resumption use their native chat
behavior. SystemSculpt does not define competing streaming commands or RPC
methods for any of those actions.

The public SystemSculpt contract contains only:

1. an authenticated HTTP bootstrap;
2. an aggregate client capability manifest;
3. one short-lived-access context staging request that returns an opaque
   `context_ref`, plus native UI file parts;
4. one stable terminal data part per accepted run; and
5. the frozen legacy compatibility boundary.

The canonical fixture is stored at both repository-specific paths:

- Website:
  `src/lib/plugin/contracts/fixtures/thin-agent-v1/thin-agent-v1.json`
- Plugin:
  `testing/fixtures/managed/thin-agent-v1/thin-agent-v1.json`

The files have identical bytes with SHA-256
`3edb7a33693add512291e17c1955d754be22b05734abf004b11a195369acc527`.
A fixture change is a protocol change and requires compatibility review
against the first released thin-client artifact.

## Bootstrap

The plugin sends `POST /api/plugin/agent/bootstrap` using the normal
license-authenticated plugin API. A create or resume request is:

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

The request carries the mandatory installed plugin version in the
`x-plugin-version` header. It is not duplicated in the body.

`client_id` is an installation identifier. `conversation_id` is a
client-generated, opaque routing identifier scoped under the authenticated
account. Neither is execution authority. A server-owned session and its
ordered message history remain authoritative.

`plugin_build_id` is the SHA-256 of the installed `main.js` bytes read through
the Obsidian vault adapter. A development sync also records that digest in
`systemsculptDevBuild.artifacts["main.js"]`, but the plugin independently
hashes the installed bundle and rejects a mismatch instead of trusting the
manifest claim. A version label or source revision is not an artifact identity.

The server response is:

```json
{
  "contract_version": "thin-agent-v1",
  "conversation_id": "conversation_<32 lowercase hex>",
  "session": {
    "id": "session_<32 lowercase hex>"
  },
  "access": {
    "token": "<short-lived opaque access token>",
    "expires_at": "2030-01-01T00:01:00.000Z"
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

`client_input_limits` contains only picker and local-read safety limits. It is
server-owned and may change on any bootstrap without a plugin release. The
plugin keeps conservative hard ceilings to protect mobile memory, but does not
read these values from the frozen managed capability catalog.

The live-session path is the compile-time contract constant
`/api/plugin/agent/connect`, resolved against the configured first-party API
origin. The plugin supplies the returned access token to the maintained native
client.

The raw license never appears in the live-session URL. The access token has a
short expiry, binds the account, session, conversation, client, contract,
capability hash, and a unique grant ID, and is signed by the server. Its
account subject is an opaque account identifier, never a raw internal user ID.

Unknown request contract versions, unknown required capability versions,
malformed identities, malformed manifests, and unaccepted live-session paths
fail before short-lived access is issued.

## Idempotency and server authority

The authenticated account plus `conversation_id` is the bootstrap
idempotency key. An exact retry resolves the same server session and may
return fresh short-lived access. It never creates a second run history.

A retry that supplies conflicting creation intent returns
`conversation_conflict`. A request body cannot contain
`capability_manifest_sha256`, `history`, `messages`, `plugin_version`,
`resume_cursor`, `session_id`, or `transcript`. The server can derive the
manifest hash itself, so requiring the client to echo it would add work
without adding authority.
In particular, neither a local ChatView cache nor a legacy session
checkpoint can replace the server’s history.

The opaque `session.id` in the response is useful for correlation and display.
The client does not send it back as authority. Reconnecting the same
conversation goes through bootstrap again, and the authenticated server
resolves the current session.

## Context staging

After bootstrap and before committing or submitting a user turn, the plugin
sends exactly one request to:

```text
POST /api/plugin/agent/context?access_token=<bootstrap access token>
```

The request body is:

```json
{
  "contract_version": "thin-agent-v1",
  "root_message_id": "<native user message ID>",
  "context_sources": [
    {
      "kind": "text",
      "path": "Projects/Plan.md",
      "content": "Private selected vault context."
    }
  ]
}
```

Context sources use the bounded text, image data URL, and document reference
union from `client_input_limits`. The HTTP body ceiling is 24 MiB. The same
short-lived bootstrap access token authenticates history, context staging, and
the live session until its existing expiry. Staging does not consume the
access token.

A successful `201` response is:

```json
{
  "contract_version": "thin-agent-v1",
  "context_ref": "<opaque signed reference>",
  "expires_at": "2030-01-01T02:00:00.000Z",
  "bytes": 143,
  "sha256": "sha256:<64 lowercase hex>"
}
```

The two-hour reference is bound server-side to the authenticated account,
session, client, root message ID, expiry, bytes, and digest. The plugin treats
it as opaque. It does not retry staging automatically. Cancellation aborts
the one request, and failure stops before the local user commit or native turn
submission. Client diagnostics may include a safe error code, incident ID,
status, and retryability, but never raw context.

The lazy native turn body is exactly:

```json
{
  "context_ref": "<opaque signed reference>"
}
```

The new plugin does not emit `preferences`; search is autonomous and
server-owned. A server may continue accepting that field from older clients
during their compatibility window. `context_sources`, server implementation authority,
tool schemas, history, and prompt text are forbidden from this body.

## Historical edit and resubmit

Editing an earlier user message creates a branch. The plugin allocates a new
`conversation_id` and adds this bootstrap field:

```json
{
  "fork": {
    "source_conversation_id": "conversation_<32 lowercase hex>",
    "before_message_id": "<native UI message ID>"
  }
}
```

The server resolves the source conversation under the authenticated account,
verifies ownership, locates the boundary in authoritative history, and copies
history strictly before `before_message_id` into the new server session. The
edited user message is then sent through the native chat transport.

The target conversation must be new. Repeating the identical fork is
idempotent and resolves the same target session. Reusing the target
conversation with different fork intent returns `conversation_conflict`.
Another account’s source is indistinguishable from a missing source and
returns `fork_source_not_found`. An absent boundary in an owned source returns
`fork_boundary_not_found`.

The local chat document may retain its UI continuity, but its contract
conversation pointer follows the new branch. The client never replays a full
transcript to create a branch.

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

The plugin does not send tool descriptions, JSON schemas, model names, risk
classifications, or mutation flags. `obsidian.vault@1` maps on the server to
the exact twelve released local capabilities:

`context`, `create_folders`, `edit`, `find`, `list_items`, `move`,
`multi_edit`, `open`, `read`, `search`, `trash`, and `write`.

The server owns their exact model-facing descriptions, input schemas, and risk
classification. The canonical catalog is sorted by tool name, every object
key is sorted recursively, array order is preserved, and the result is compact
UTF-8 JSON. Approval requirement and risk classification are fields of that
catalog rather than a parallel hard-coded name list. The locked catalog is
12,722 bytes with SHA-256
`b04234ead8b523cdb4c17977d6f4c747867648bb4561598d523c62cf64b61fb8`.

An intentional schema or local behavior change publishes a new aggregate
capability version. It cannot silently change `obsidian.vault@1`.

### Server-computed capability hash

The server hashes an accepted manifest and binds the result into the
short-lived access grant. The plugin does not compute or send this hash. To derive
it:

1. validate the manifest contract and every capability version;
2. sort capabilities by ID and numeric version;
3. recursively sort object keys by Unicode code point;
4. preserve all remaining array order;
5. serialize compact JSON as UTF-8; and
6. prefix its hexadecimal SHA-256 with `sha256:`.

The v1 canonical string is:

```text
{"capabilities":[{"id":"obsidian.vault","version":1}],"contract_version":"thin-agent-capabilities-v1"}
```

Its hash is
`sha256:fb3e72b592556f80d6047339bdef5d82c0570b195f1abc8a8c9a3d7bf162d22c`.

## Native chat transport

After bootstrap:

1. the plugin creates the maintained native chat client for the returned path
   and access token;
2. it constructs the maintained native transport around that client;
3. selected vault context is staged once and the opaque `context_ref` is
   placed in the lazy turn body;
4. user text and native UI message parts are submitted through the transport;
5. the server’s canonical tool catalog produces native tool input parts;
6. the plugin applies its local approval policy and uses native approval and
   client-tool result methods;
7. a stable native tool-call ID and the local mutation receipt prevent a
   replayed mutation from executing twice;
8. the server decides every later model step; and
9. reconnect and stream replay remain owned by the maintained transport.

The plugin has no continuation counter, model-step limit, server-tool loop,
service retry, compactor, or turn state machine.

## Application data parts

The sole SystemSculpt application-specific stream data part is
`data-systemsculpt-run-terminal`. Its AI SDK UI message outer shape is:

```json
{
  "type": "data-systemsculpt-<name>",
  "data": {
    "version": 1
  }
}
```

Unknown data-part types are ignored. Unknown fields on a known part are
ignored. A malformed payload or unsupported payload version for a known type
is not partially interpreted. The client records a contract diagnostic and
continues consuming the native stream when safe.

### `data-systemsculpt-run-terminal`

```json
{
  "version": 1,
  "run_id": "run_<32 lowercase hex>",
  "root_message_id": "user-<client message id>",
  "outcome": "failed",
  "code": "service_temporarily_unavailable",
  "message": "The service is temporarily unavailable.",
  "incident_id": "incident_<32 lowercase hex>",
  "retryable": true
}
```

Every accepted run produces exactly one persisted terminal part. A successful
terminal has `outcome: "succeeded"` and `code: "completed"` with no error
fields. A cancelled terminal has `outcome: "cancelled"`,
`code: "cancelled"`, and an optional bounded display message. A failed
terminal requires a bounded error `code`, safe display `message`,
`incident_id`, and `retryable` boolean.

`root_message_id` is required for every outcome and identifies the user
message that started the server run. The client accepts a terminal only when
that value exactly matches the active user turn, so replayed or delayed
terminal parts from another turn cannot settle the current run.

The incident identifies private server diagnostics. Upstream service bodies,
credentials, prompts, vault contents, server implementation identities,
usage, costs, and credit accounting never appear in the public stream. Native
chat status, native tool and approval states, and maintained transport
recovery own live UI state. Native stream finish is not a substitute for the
terminal part, and reconnect replay must recover it.

## Message files and vault context

Composer files use native AI SDK UI file parts. Images retain truthful image
MIME types. Text attachments retain their truthful text MIME type. A PDF is
processed through the existing first-party document service, then its
extracted, explicitly framed untrusted Markdown is sent as
`text/markdown` with a derived `.extracted.md` service-facing filename. The
original PDF name and MIME remain local presentation metadata. Extracted
Markdown is never mislabeled as `application/pdf`.

Selected vault context is sent only to the access-authenticated staging
endpoint. The turn body carries only its opaque `context_ref` and optional
preferences. Local vault paths never become remote file identifiers or
execution authority.

## Frozen legacy compatibility

`managed-capabilities-v2` remains byte-for-byte frozen for pre-migration
clients and stays on its legacy endpoint. It does not negotiate
`thin-agent-v1`, cannot gain additive data parts, and must not be used as the
new server session authority.

The first released thin client and this fixture become permanent compatibility
targets. Later server runtime, model, prompt, retry, caching, compaction, or
server-tool changes must work against that unchanged artifact.
