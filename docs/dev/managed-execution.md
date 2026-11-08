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

## Audio Processor durable device sources

Device uploads intentionally finish local staging before sending multipart bytes.
This is a recovery boundary, not a leftover whole-file upload implementation:

- `AudioProcessorService.process` stages only sources without a recovery
  descriptor. Vault sources already use their vault path and modification time
  directly; they do not make a staging copy.
- `AudioProcessorDeviceStaging.stage` writes bounded, immutable chunks through
  `ManagedLocalStaging.stage`. Only the complete ready manifest publishes their
  lengths and SHA-256 digests. Its verified JSON determines `manifestSha256` in
  the historical schema-1 staged descriptor.
- `AudioProcessorUploadRecovery.rememberStarted` persists that descriptor before
  `uploadManagedParts` sends the first part. Each consumed chunk still passes
  size and SHA-256 verification; each accepted part is checkpointed before the
  next part. Staging does not redundantly read every binary write back.
- After a restart, `openForJob` can discover a complete ready source even when
  the settings checkpoint was interrupted. It deliberately refuses a partial
  staging manifest. The device picker's `File` is not saved and cannot supply
  the unstaged tail after restart.

Starting uploads from completed chunks while still reading the device tail
would leave a crash window with remote parts but no complete recoverable local
source. Recording those parts does not recover the missing bytes. Calling a
partial manifest ready, ignoring its final SHA-256 descriptor, or assuming the
user can reselect the same file would weaken the current contract. A producer
running behind the uploader would also need joined cancellation and cleanup;
`process` currently aborts the incomplete upload, removes partial staging, and
releases the device source through its existing error/finally path.

A direct desktop device path is not a drop-in alternative. `createDeviceFileSource`
exposes bounded Blob slices, not a persistent path or descriptor. Current saved
sources are only vault-relative files or SHA-bound staging manifests. Reopening
an external pathname or keeping a file handle would not preserve an immutable
copy across restart, deletion, replacement or edits. A future external-source
recovery design would need equivalent identity/content checks and historical
manifest compatibility, rather than silently skipping staging.

### Measure the local staging cost

The opt-in [real-disk benchmark](../../testing/bench/audio-staging.bench.test.ts)
drives `AudioProcessorService.process`, the real device Blob-slice path, staging,
SHA-256 verification, and multipart checkpoint ordering. Staging uses real disk;
settings checkpoints remain in memory, so the timings exclude durable initial
and per-part settings writes. It hashes the received stream and reopens the
staged source with a new owner after releasing the device source. Run its
documented command; `AUDIO_STAGING_BENCH_BYTES` selects the size. No credentials,
network, model calls or user vault are involved.

One Node 22.23.4/macOS sample on source `4f75c064` measured a non-sparse
129 MiB + 7 byte fixture: **248.91 ms staging**, **262.96 ms to first part send**,
and **474.53 ms for the local staging/upload path**. It wrote 17 chunks of at
most 8 MiB and sent 13 parts of at most 10 MiB. Unaligned upload windows caused
26 verified chunk reads. The generated fixture, received bytes and reopened
source had matching SHA-256 digests. Fixture creation and restart verification
were outside the timed path.

This is one warm-cache local-disk sample, not a mobile result, network upload
measurement, production transcription or speedup claim. The in-process sink
hashes immediately, so the local duration cannot predict an internet upload.
The measured staging cost does not justify weakening restart recovery. Issue
[#377](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/377)'s
proposed staging/upload overlap and automatic desktop bypass are therefore
retired under this contract; bounded uploads and the removed redundant staging
read-back remain implemented. No admission limit or historical format changes.

## Saved chat parsing

- Saved chat parsing fails closed. A malformed or truncated history must never
  become a shortened request. Leave the source note unchanged, open a fresh
  unsaved chat, and keep a visible corruption banner.
