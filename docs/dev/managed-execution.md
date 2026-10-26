# Managed execution

Repository instructions for hosted AI, protocol compatibility, vault action
approvals and saved-chat parsing. Read with [the core](../../AGENTS.md).

## Server-upgrade independence

This is a release requirement, not an implementation preference:

- The boundary applies to ChatView, Audio Processor, transcription, document
  processing, images, embeddings, Studio AI, and future managed AI features.
  The client may capture or select local input bytes, upload them, render
  progress, obtain local approval, and save or apply a returned result.
  Provider calls, models, prompts, chunking, polling, retry, transforms, job
  orchestration, caching, billing, and durable execution state stay
  server-side.
- Harness, model, provider, retry, caching, compaction, memory, session, and
  orchestration changes must be deployable server-side without a plugin
  release.
- The plugin wire contract is harness-agnostic. Production client code,
  headers, persisted data, UI labels, and tool results must not contain Pi,
  Think, OpenRouter, AI SDK, or another harness/provider identity.
- The plugin never decides whether the agent should continue. It receives a
  typed client-tool request, applies local approval policy, executes the
  Obsidian operation, and returns one typed result. The server decides every
  subsequent model step.
- The server owns the authoritative conversation session and ordered event
  history. Local chat persistence is a cache or user export and must never
  become execution authority after reconnect.
- Client capability negotiation is additive. The plugin advertises supported
  local tool names and contract versions; the server adapts its tool catalog
  to that manifest. Unknown additive event fields and unknown server-only
  tools must not crash or stop the client.
- One migration release may replace the legacy client continuation loop with
  this thin protocol bridge. The first released thin-client artifact then
  becomes a permanent compatibility fixture. Every later server agent change
  must connect, render, execute its supported local tools, reconnect, and
  finish a long turn against that unchanged artifact.
- A plugin update is justified only by a new or changed local Obsidian
  capability, a client security correction, or an intentionally new UI
  feature. A server harness replacement is never sufficient justification.

Do not add a harness package, model SDK, agent state machine, continuation
counter, context compactor, or provider retry loop to the production plugin
bundle. A client protocol SDK is acceptable only when it remains a transport
and event/tool bridge and does not take ownership of the agent loop.

The pre-migration released plugin may use a legacy compatibility endpoint
during a bounded support window. It cannot define the new architecture
because its compiled code still owns continuation. Do not copy that behavior
into the new protocol.

Freeze `managed-capabilities-v2` and its existing strict client behavior for
that legacy path. The migration release negotiates a new additive thin-client
contract. Do not mutate v2 and mistake a breaking parser change for additive
protocol evolution.

## Product contracts

- New hosted chats default to **Auto**: reads, lists, searches, open/context actions,
  folder creation, writes and edits (including multi-edit) run without asking;
  move/rename and trash require approval. **Ask** requires approval for every vault
  mutation; **Full access** allows all vault actions without asking. Preserve saved
  hosted modes; missing or unknown saved modes fall back to Ask, not Auto.
- The client executes local vault tools but never orchestrates the agent that
  requested them.
- The server conversation session and event journal are authoritative. Local
  transcript data is a cache/export surface only.

## Saved chat parsing

- Saved chat parsing fails closed. A malformed or truncated history must never
  become a shortened request. Leave the source note unchanged, open a fresh
  unsaved chat, and keep a visible corruption banner.
