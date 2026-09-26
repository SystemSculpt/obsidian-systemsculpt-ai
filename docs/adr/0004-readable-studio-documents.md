# Readable Studio documents with stamped field merges

Supersedes the merge engine of [ADR-0003](0003-single-file-studio-documents.md); its single file, shared edit service and atomic publication remain.

A Studio project has one user, and Studio already serializes its own writers per file: the canvas, agents through `studio_edit_document`, and chat file tools that compare and swap. The only other writer is a whole-file replacement, such as Sync or another device. Embedding Automerge state for that case cost 4.8 MB of WebAssembly in every launch, a full load and save of the CRDT on every keystroke, and files that grew by about 50 bytes per typed character and never shrank.

A `.systemsculpt` file now holds readable v2 JSON only. Studio's own writers merge by entity and field with `reconcileStudioProject` against the state each edit was based on:

- a canvas save against the session's last accepted file;
- an agent batch against the revision it read. The revision is the SHA-256 of the canonical file text. A batch that conflicts with a later change to the same field is rejected whole, so the agent reads again.

When both sides change the same prose field (value, prompt, systemPrompt, source, text, title, label, description, instructions), separate changes combine with a diff3 restricted to one changed range per side. Touching or overlapping changes, and any other same-field conflict in a session, keep the file's value; the session keeps its own version as an Undo step.

## Whole-file copies from another device

A copy from a device that never saw this device's latest save cannot be merged against this device's own base: its stale values would read as edits. Studio therefore dates values instead of files.

- **Stamps.** Each device keeps a hybrid logical clock: wall milliseconds, a counter and a random device ID, encoded so that string order is clock order. Clocks seen from other devices move it forward, except stamps more than a day in the future. When the canvas or an agent changes something, the device stamps each created or restored entity, and each changed field: a top-level field, one config key, or one group member.
- **Watermarks.** Each publication records the file's SHA-256 and the clock at that moment.
- **Clock files.** Stamps, deletion tombstones and the newest 16 watermarks live in `<project>.systemsculpt-assets/clock/<device>.json`. Each device writes only its own file, before the project file it describes, so synchronization never has two devices overwrite one another's clock. The project file keeps the format 6.10 reads. The device ID is kept in vault-scoped local storage, which is not synchronized; hosts without it use one ID per session. Stamps and tombstones expire after 30 days, the stamps of a deleted entity go with it, and tombstones are capped at 1,000 entries. A device's file stops counting once it has not written for 30 days.

When a copy arrives, Studio looks up its hash in every device's clock and merges it into the state this device accepted, field by field:

- The newer stamp wins. A writer's stamp later than the copy's watermark belongs to a later file, so it counts as the watermark.
- When this device also changed prose since the last merge, and the copy changed it from the same earlier value, the changes combine with diff3 if they are separate.
- An entity the copy lacks is deleted when a tombstone is newer than its creation. It is kept when this device created it after the copy's watermark, or when the writer's clock never knew it. Otherwise the copy deleted it.
- An entity only the copy has is dropped when it is tombstoned, unless the writer's clock shows it was restored after the deletion.

If the merge changed anything, the result is published so the other device receives it. The other device converges when it merges that file the same way.

**Fallbacks.** When no clock names the copy (the writer's clock has not synchronized yet, a 6.10 device, or a text editor), the file's modification time dates every value in it:

- this device's changes made after that time are kept;
- entities it created or changed after that time are kept;
- older entities missing from the copy are deleted.

Edits made on the same device, such as agent file tools, are therefore applied in full. When the host reports no modification time, the copy's values win and this device's entities are kept. Either fallback shows a notice when it kept local changes.

Synchronization may deliver a project file before its writer's clock. Its modification time then also dates values the writer never saw, so a dated merge over this device's accepted state is provisional. Studio remembers the copy's hash, this device's state before it, and what the dated merge accepted. When a clock names that copy (a clock file arriving next to the project, or any later refresh), Studio redoes the merge by stamps and corrects every entity and field that is still as the dated merge left it. Anything changed since keeps its current value. The correction is stamped like any other change, so other devices receive it. Files still carrying 6.10 merge state are not remembered, because 6.10 writes no clock.

## Limits

- The fallback relies on synchronization preserving modification times and on device clocks being roughly right. Where it does not, it degrades to taking the copy's values.
- A provisional merge is corrected only while Studio keeps this device's earlier state in memory, for up to a day. A clock that arrives after a restart, or later than that, no longer corrects it.
- Concurrent changes to the same non-prose field keep the newer one, and an overlapping prose change does too; Studio does not keep the older value.
- A deletion wins over a concurrent edit to the deleted entity.
- The stamped merge needs this device's accepted content in memory. If a stale copy replaces the file while Studio is not running on this device, the copy is taken as it is, apart from deletions, and Studio shows a notice that changes from this device may be missing.
- A device offline for more than 30 days has outlived the stamps and tombstones, and falls back as above.

## Migration

Files written by 6.10 still carry `document` merge state. Studio reads their readable canvas, which is the content, and drops the state on the next edit rather than on load, so a device still running 6.10 cannot trade rewrites with this one. Before the first such rewrite of a project, Studio keeps its original bytes once in `legacy/<timestamp>-document-state-original.json`.
