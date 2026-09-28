# Publish projects without replacing concurrent work

Refined by [ADR-0003](0003-single-file-studio-documents.md) and [ADR-0004](0004-readable-studio-documents.md): the recovery snapshot store described below was replaced by one readable project document, merged by entity and field, whose conflicting local values stay in the session as Undo steps.

A Studio project is a user-editable document shared with other views, agents, and devices, so a project session rebases edits onto the current file instead of treating its in-memory copy as the only writer. Conflicting external values remain visible while local edits are retained in undo and recovery snapshots; assets and run records reconcile independently because their arrival order cannot be assumed to match the canvas.

This costs more than saving the latest local snapshot wholesale, but preserves authored work and paid outputs across concurrent editing and synchronization. The session and persistence modules own this policy; views submit edits and render the resulting state.
