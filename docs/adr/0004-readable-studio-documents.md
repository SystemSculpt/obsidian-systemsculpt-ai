# Readable Studio documents with a three-way merge

Supersedes the merge engine of [ADR-0003](0003-single-file-studio-documents.md); its single file, shared edit service and atomic publication remain.

A Studio project has one user, and Studio already serializes its own writers per file: the canvas, agents through `studio_edit_document`, and chat file tools that compare and swap. The only other writer is a whole-file replacement, such as Sync or another device. Embedding Automerge state for that case cost 4.8 MB of WebAssembly in every launch, a full load and save of the CRDT on every keystroke, and files that grew by about 50 bytes per typed character and never shrank.

A `.systemsculpt` file now holds readable v2 JSON only. Every writer states the file state its edit was based on, and the edit merges by entity and field onto the current file with `reconcileStudioProject`:

- a canvas save against the session's last accepted file;
- an external replacement, imported by the watcher, against the session's base and its unsaved edits;
- an agent batch against the revision it read. The revision is the SHA-256 of the canonical file text. A batch that conflicts with a later change to the same field is rejected whole, so the agent reads again.

When both sides change the same text field, separate changes to prose fields combine (a diff3 restricted to one changed range per side). Touching or overlapping changes, and any other same-field conflict, keep the file's value; the session keeps its own version as an Undo step. Character-level merging of simultaneous edits to the same passage on two devices is the accepted loss.

Deletions leave the entity key and deletion time in `<project>.systemsculpt-assets/tombstones.json`, pruned after 30 days and capped at 1,000 entries. An imported file cannot bring a tombstoned entity back; only Studio's own Undo or an agent `restore` can, which clears the tombstone. The sidecar keeps the project file in the format 6.10 can still read.

A replacement written by a device that never saw the latest save is merged against this device's last accepted file, not the base that device used. Its stale values of fields changed since, and its lack of entities created since, read as its own edits. Tombstones stop the stale copy from restoring deletions; nothing in the file can make such a replacement lossless.

Files written by 6.10 still carry `document` merge state. Studio reads their readable canvas, which is the content, and drops the state on the next edit rather than on load, so a device still running 6.10 cannot trade rewrites with this one. Before the first such rewrite of a project, Studio keeps its original bytes once in `legacy/<timestamp>-document-state-original.json`.
