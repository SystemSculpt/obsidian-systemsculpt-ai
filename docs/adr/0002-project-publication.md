# Publish projects without replacing concurrent work

A Studio project is a user-editable document shared with other views, agents, and devices, so a project session rebases edits onto the current file instead of treating its in-memory copy as the only writer. Conflicting external values remain visible while local edits are retained in undo and recovery snapshots; assets and run records reconcile independently because their arrival order cannot be assumed to match the canvas.

This costs more than saving the latest local snapshot wholesale, but preserves authored work and paid outputs across concurrent editing and synchronization. The session and persistence modules own this policy; views submit edits and render the resulting state.
