# Readable Studio documents with stamped field merges

Supersedes the merge engine of [ADR-0003](0003-single-file-studio-documents.md); its single file, shared edit service and atomic publication remain.

A Studio project has one user, and Studio already serializes its own writers per file: the canvas, agents through `studio_edit_document`, and chat file tools that compare and swap. The only other writer is a whole-file replacement, such as Sync or another device. Embedding Automerge state for that case cost 4.8 MB of WebAssembly in every launch, a full load and save of the CRDT on every keystroke, and files that grew by about 50 bytes per typed character and never shrank.

A `.systemsculpt` file is readable v2 JSON. Studio's own writers merge by entity and field with `reconcileStudioProject` against the state each edit was based on:

- a canvas save against the session's last accepted file;
- an agent batch against the revision it read. The revision is the SHA-256 of the canonical canvas text, without the merge record below. A batch that conflicts with a later change to the same field is rejected whole, so the agent reads again.

## The merge record

A copy from a device that never saw this device's latest save cannot be merged against this device's own base: its older values would read as edits. Studio therefore dates values, and every file Studio publishes carries them in a `merge` record after the canvas:

- `at`: a hybrid-logical-clock stamp for the publication. Each device's clock combines wall milliseconds, a counter and a random device ID, encoded so that string order is clock order. Stamps seen from other devices move it forward, except stamps more than a day in the future. The device ID is kept in vault-scoped local storage, which is not synchronized; hosts without it use one ID per session.
- `canvas`: the agent revision of the canvas it was published with.
- `stamps`: when each created or restored entity, and each changed field (a top-level field, one config key, or one group member), was set. A field's stamp also records the stamp of the value it replaced.
- `deleted`: tombstones, one key and stamp per deleted entity.

Stamps and tombstones expire after 30 days, the stamps of a deleted entity go with it, and tombstones are capped at 1,000 entries.

Because the record travels inside the file it describes, a copy always arrives with exactly what its writer knew when it wrote it, in whatever order synchronization delivers files.

## Merging a copy

When a file arrives, Studio compares it with the state this device accepted:

- **Another device's publication** merges field by field, by the stamps in its record:
  - The newer stamp wins.
  - If this device changed a field and then changed it back, an independent edit from the same earlier value on another device stands. A peer republishing this device's superseded value does not reverse Undo.
  - If both devices changed the same earlier text of a prose field (value, prompt, systemPrompt, source, text, title, label, description, instructions), and the changes are separate, they combine with diff3. The replaced-value stamps show that both started from the same text; otherwise the newer change wins.
  - An entity the copy lacks is deleted only when a tombstone is newer than its creation. Every deletion leaves a tombstone, so without one the copy was written before its writer knew the entity.
  - An entity only the copy has is dropped when a tombstone is newer than its writer's creation or restore stamp. Undo on any device therefore restores a deletion everywhere.
  - Adopted deletions keep their own stamp, so a later restore still wins.
- **The publication this device accepted, edited outside Studio's merge** keeps that publication's `at` but changes the canvas. So does a file without a merge record. Examples are an agent's file tools and a text editor. Its differences are this device's own edits, deletions included. They are stamped here, and published with the next save, so the file is not rewritten under the editor that wrote it. Another device that accepted the same publication applies the edit the same way.
- **A file from SystemSculpt 6.10** carries Automerge state and no merge record. Whatever this device dated stays, entities it lacks are kept, and its other changes apply. Studio says so and asks the user to update SystemSculpt on every device.

If the merge changed anything, the result is published so the other device receives it. The other device converges when it merges that file the same way.

## Compatibility

SystemSculpt 6.10 rejects any root field it does not know, so it cannot open a project after a newer version has saved it. It reports that it cannot read the file and does not write to it. This is deliberate: a merge record that travels in a separate file can arrive after the project file, and every way of merging before it arrives can lose work. Update SystemSculpt on every device that edits the same projects.

## Limits

- Concurrent changes to the same non-prose field keep the newer one. So do overlapping prose changes, and prose changes that did not start from the same text. Studio does not keep the older value.
- A deletion wins over a concurrent edit to the deleted entity.
- The merge needs this device's accepted content in memory. If a stale copy replaces the file while Studio is not running on this device, the copy is taken as it is. A stale copy that arrives again after a restart is taken the same way.
- A device offline for more than 30 days has outlived the stamps and tombstones. Its older values lose to any dated change, and entities deleted since then may come back.
- A device whose clock is more than a day behind the others loses every concurrent change, because its stamps never catch up.

## Migration

Files written by 6.10 still carry `document` merge state. Studio reads their readable canvas, which is the content, and drops the state on the next edit rather than on load. Before the first such rewrite of a project, Studio keeps its original bytes once in `legacy/<timestamp>-document-state-original.json`.
