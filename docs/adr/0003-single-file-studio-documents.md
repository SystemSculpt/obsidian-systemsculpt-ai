# One collaborative Studio document

Studio previously saved whole snapshots and replaced the workspace DOM during refresh. Stale writers could restore deleted or edited content, while unrelated catalog and file events interrupted active gestures and editors.

A new canvas is one readable `.systemsculpt` JSON document containing its Automerge state in `document`. The readable canvas remains searchable and editable. Stable entity maps merge separate fields and memberships, collaborative text merges within one value, and deletion tombstones prevent stale edits from restoring a removed entity. Explicit Undo or restore can bring it back. There are no authored-state sidecars or conflict copies.

The shared document service serializes scoped edits from the UI and agents and atomically publishes the resulting file on desktop. Agents read revision heads and submit set/create/delete/restore batches through the same service. Independent agents use native Studio tools or call the service through the official Obsidian CLI. Atomic rename prevents partial publication but is not a cross-process compare-and-swap. All concurrent writers must use the live service. Arbitrary simultaneous whole-file replacements, or a sync provider overwriting bytes before Studio can observe them, cannot be guaranteed lossless by any in-file metadata.

The mobile adapter uses Obsidian's process operation; host storage controls atomicity. Failed publication remains an error with pending in-memory intent. Closing cannot discard an unsaved session. The desktop temporary sibling exists only during atomic publication and is removed on failure; it is not a second authored document.

Views keep a persistent workspace and patch cards by stable ID. Geometry updates preserve pointer ownership, and unrelated changes retain focused editors and their DOM. Undo records authored intent without replacing the document session.

Existing projects can be opened into this format, but new-document correctness takes priority over elaborate migration. Media, permission settings and execution records remain separate product data; normal canvas saves no longer copy those resources into generations.

History retention is deliberate: Automerge keeps causal operations so an older
agent revision can merge without a second authored file. We do not automatically
reset that history, which would invalidate outstanding revisions. Unlike the
old generation store, each edit adds compressed operations, not another copy of
media, caches and run records. A local 10,000-edit geometry/text soak measured
605,832 bytes of encoded state, 6 ms serialization and 171 ms cold load. History still grows with edits; this is not a
constant-size format. Future compaction must explicitly expire revisions and
rebase all live editors before replacing the history, rather than silently
losing stale work. Native documents have scoped ownership and are released on
validation/I/O failure and service disposal.
