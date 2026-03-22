# Studio persistence completion plan

Last updated: 2026-03-22.

## Why this document exists

The first native persistence pass is now in place:

- `src/studio/StudioProjectSession.ts` exists
- save timing and live-sync bookkeeping moved out of view-local timers
- `StudioService` now opens a session-backed current project
- Studio close/switch/run paths flush through the session
- node drag and group drag now autosave through the session path

That foundation is real progress, but it is **not the end-state yet**.

If we want Studio persistence to be something we can stop thinking about, we still need to finish the architectural conversion so future features cannot bypass it.

## Final goal

Build a Studio persistence system where all project mutations are committed through one core session/document layer, so that:

- if Studio shows a change, that change is already committed to the active project session
- autosave timing is a session concern, not a UI concern
- reload restores the latest state
- run uses the latest state
- vault rename/modify/delete events reconcile against the same session
- multiple Studio leaves cannot drift or race each other
- future UI work cannot accidentally reintroduce "mutate raw object, then maybe save later"

The success bar is not "better than before."
The success bar is: **persistence becomes a boring invariant.**

---

## Current state after the first native pass

### Already done

- Core session exists in `src/studio/StudioProjectSession.ts`
- Core live-sync helper exists in `src/studio/StudioProjectLiveSync.ts`
- `SystemSculptStudioView.ts` no longer owns the old save timer implementation
- `StudioService.ts` now opens and flushes the active session
- close/switch/run flows delegate to the session
- drag interactions now call session-backed autosave in continuous/discrete modes
- targeted regression coverage exists for session persistence, live sync, and drag flows

### What the audit still shows

In non-test Studio source today there are still:

- **41** `scheduleProjectSave(...)` references
- **27** `onNodeConfigMutated(...)` references in the Studio view layer
- **57** direct node/project mutation references matching patterns like:
  - `node.config.* = ...`
  - `node.position.* = ...`
  - `project.graph.* = ...`
  - `project.graph.*.push(...)`
  - `writeStudioCaptionBoardState(...)`

The biggest remaining hotspots are:

- `src/views/studio/SystemSculptStudioView.ts`
- `src/views/studio/StudioGraphGroupController.ts`
- `src/views/studio/StudioGraphSelectionController.ts`
- `src/views/studio/connections-v2/StudioGraphConnectionEngineV2.ts`
- `src/views/studio/graph-v3/StudioGraphInlineConfigPanel.ts`
- `src/views/studio/graph-v3/StudioGraphJsonInlineEditor.ts`
- `src/views/studio/graph-v3/StudioGraphTextInlineEditor.ts`
- `src/views/studio/graph-v3/StudioGraphLabelNodeCard.ts`
- `src/views/studio/graph-v3/StudioGraphImageEditorModal.ts`
- `src/views/studio/graph-v3/StudioGraphNodeResizeHandle.ts`
- `src/views/studio/StudioManagedOutputNodes.ts`
- `src/views/studio/systemsculpt-studio-view/StudioRunOutputProjectors.ts`
- `src/views/studio/graph-v3/StudioGraphGroupModel.ts`

### The remaining architectural gaps

1. **UI still mutates raw project objects directly.**
   The session owns save timing, but many surfaces still mutate `node` / `project` objects first and then call a wrapper that schedules persistence.

2. **The mutation API is still implicit.**
   The current seam is still effectively:
   - mutate raw object
   - call `scheduleProjectSave()` or `onNodeConfigMutated(...)`

3. **`StudioService` is still single-session, not path-keyed session-manager based.**
   It currently tracks `currentProjectSession` and `currentProjectPath`, which is not the final shape for robust multi-view coordination.

4. **Runtime still loads the project from disk.**
   `StudioRuntime.ts` still uses `projectStore.loadProject(...)` for run execution.
   That means flush-before-run protects correctness today, but runtime still treats disk as authoritative instead of the session snapshot.

5. **Load-time repair and some sync logic still live in the view.**
   `SystemSculptStudioView.ts` still mutates loaded projects for repair/cleanup/normalization and then saves them.

6. **There are no hard guardrails preventing regression.**
   Even after this work, a future feature could still add a new direct mutation in a renderer and accidentally bypass the intended persistence architecture.

---

## End-state architecture

The final system should have the following non-negotiable ownership model.

### 1) `StudioProjectSessionManager` owns session lifecycle

Add a path-keyed manager in `src/studio`, for example:

- `src/studio/StudioProjectSessionManager.ts`

Responsibilities:

- hold open sessions by normalized project path
- return existing sessions for repeated opens of the same project
- track view/service retainers and release counts
- centralize close/dispose behavior
- centralize project-file live-sync routing
- centralize vault rename/delete remapping that affects open sessions
- expose `getSession(path)`, `openSession(path)`, `flushSession(path)`, `closeSession(path)`, `closeAllSessions()`

Why this is necessary:

- `StudioService` being single-session is not a robust end-state
- multi-view correctness belongs above any one view
- file sync should not be duplicated per leaf

### 2) `StudioProjectSession` owns mutation semantics, not just autosave timing

The session should mature from “save queue + signatures” into the authoritative document contract.

Recommended API shape:

```ts
session.getProjectSnapshot()
session.subscribe(listener)
session.mutate(reason, mutator, options?)
session.replaceProjectSnapshot(snapshot, options?)
session.flush(options?)
session.close()
session.getDebugState()
```

Recommended mutation options:

- `mode: "discrete" | "continuous"`
- `notify?: boolean`
- `flushAfter?: boolean`
- `origin?: "ui" | "runtime" | "vault" | "history" | "repair"`

Recommended mutation reasons:

- `node.config`
- `node.title`
- `node.geometry`
- `node.position`
- `graph.connection`
- `graph.group`
- `graph.node.create`
- `graph.node.remove`
- `media.editor`
- `runtime.projector`
- `vault.sync`
- `history.apply`
- `project.load`
- `project.reload`
- `project.repair`

Important: the session should be the **only** place that turns mutations into dirty revisions and persistence behavior.

### 3) The view layer must stop receiving mutable project state as a thing it is allowed to edit

This is the real finish line.

The renderer/editor/controller layer should receive:

- readonly project/node snapshots for rendering
- typed command callbacks for mutation

It should **not** receive “here is a mutable node, edit it and then tell me later.”

That means we should eliminate generic callback patterns like:

- `onNodeConfigMutated(node)`
- `onNodeGeometryMutated(node)`
- `scheduleProjectSave()` as the mutation seam

And replace them with command-first APIs like:

- `updateNodeTitle(nodeId, title)`
- `updateNodeField(nodeId, key, value, { mode })`
- `updateNodeText(nodeId, value, { mode })`
- `resizeNode(nodeId, size, { mode })`
- `moveNodes(nodeIds, positions, { mode })`
- `updateBoardState(nodeId, boardState, { mode })`
- `createConnection(request)`
- `removeConnection(edgeId)`
- `createGroup(nodeIds)`
- `renameGroup(groupId, name)`
- `setGroupColor(groupId, color)`
- `assignNodesToGroup(groupId, nodeIds)`
- `disconnectNodeFromGroup(nodeId)`

This is what actually makes the system future-proof.

### 4) Runtime must run from the session snapshot, not from disk

Add a runtime path such as:

```ts
studioRuntime.runProjectSnapshot({ projectPath, project, options })
```

And update service entrypoints to use:

- `await session.flush({ force: true })`
- `const snapshot = session.getProjectSnapshot()`
- `runtime.runProjectSnapshot(...)`

Disk should still be updated for survivability and for external tools.
But the active in-memory session must become the authoritative run input.

This removes the final “UI shows X, run used Y” race.

### 5) Live sync and project-file reconciliation belong to the session layer, not the view

The session should remain responsible for:

- expected self-write signatures
- accepted/rejected signatures
- deferred external sync state
- resolution of modify events against dirty local state

But the **routing** of actual vault/file events should move to the session manager or service-level controller so it happens once per open project path, not once per view.

The view can still display warnings.
It should not own the policy.

### 6) Load-time project repair should move into core

Repairs and normalization that mutate the project on open should stop living in `SystemSculptStudioView.ts`.

Move them into a core repair pipeline in `src/studio`, for example:

- `src/studio/StudioProjectRepairs.ts`

This should cover things like:

- graph group sanitization
- legacy media title normalization
- stale managed output cleanup
- legacy managed text cleanup
- any persisted config normalization that should happen on open/reload

The view should open a session and render it.
It should not silently rewrite the project as part of its own orchestration logic.

### 7) Derived data must stay derived

This matters for long-term correctness.

Canonical persisted graph state:

- nodes
- edges
- groups
- node titles/config/geometry
- image-editor board state
- intentional runtime projections that truly belong in the graph

Derived or cache-like state:

- rendered image-editor asset (`lastRenderedAsset`)
- note preview runtime outputs
- run presentation state
- viewport state
- context menu / inspector state

Important consequence:

- board-state edits should be the canonical image-editor truth
- rendered image assets should be treated as rebuildable derived output
- if the rendered asset is stale or missing, Studio should be able to regenerate it from persisted board state

This keeps the editor robust even if rendering fails or the user closes mid-flow.

### 8) Persistence cadence and history cadence must be separate concerns

Persistence is about not losing state.
History is about user undo/redo semantics.
They are not the same thing.

Final rule:

- continuous interactions can persist every ~100ms without creating a history checkpoint every ~100ms
- history checkpoints should happen at meaningful user boundaries

Recommended history policy:

- drag/resize: capture once at interaction start, persist continuously during interaction, flush on interaction end
- typing: capture at focus/start or first edit in a burst, persist continuously, finalize on blur/enter
- discrete commands: capture once per command
- undo/redo: apply a full session snapshot replacement with reason `history.apply`

This prevents good persistence from destroying undo quality.

### 9) Add hard guardrails so regressions fail fast

This is required if we want this to be the last major persistence refactor.

Add architecture-lint tests that fail if:

- `scheduleProjectSave(` exists in non-test Studio source after migration
- `onNodeConfigMutated(` exists in non-test Studio source after migration
- direct `node.config.* =`, `node.position.* =`, or `project.graph.*` writes appear in disallowed view files
- mutation helpers are imported from view-only modules instead of core modules

Also add readonly types for renderer-facing state so direct mutation becomes a compile-time error in UI code.

Suggested contract:

- view/render/controller code sees readonly project/node types
- only core session/mutation modules work with mutable drafts

This is the main protection against future accidental bypasses.

---

## Required implementation work

## Phase 0 — foundation already landed

This phase is effectively complete:

- core session exists
- core live-sync helper exists
- view/service rewiring exists
- flush-before-run and flush-before-close/switch exist
- drag flows already use session autosave modes

The remaining phases below are what turns that foundation into the final system.

## Phase 1 — introduce the final mutation contract

### Build

- mature `StudioProjectSession` with `mutate(...)` and `replaceProjectSnapshot(...)`
- add a command/facade layer in `src/studio`, for example:
  - `StudioProjectCommands.ts`
  - or `src/studio/project-mutations/*`
- add readonly project/node types for UI consumers

### Convert first

- `SystemSculptStudioView.ts` internal helpers should stop mutating `this.currentProject` directly
- create a thin view-local wrapper that does:
  - history checkpointing where appropriate
  - then calls session command helpers

### Finish criteria

- no new code should need `scheduleProjectSave()` as a mutation primitive
- new code should be able to commit any graph change through a session-backed mutation API

## Phase 2 — convert graph interaction controllers

### Files

- `src/views/studio/StudioGraphSelectionController.ts`
- `src/views/studio/StudioGraphGroupController.ts`
- `src/views/studio/connections-v2/StudioGraphConnectionEngineV2.ts`
- `src/views/studio/StudioGraphInteractionTypes.ts`
- `src/views/studio/StudioGraphInteractionEngine.ts`

### Replace

- `getCurrentProject() + mutate raw object + scheduleProjectSave()`

with

- readonly reads for geometry/lookup
- typed host commands for:
  - move nodes
  - assign/drop-to-group
  - rename group
  - recolor group
  - align group
  - create/remove connection

### Finish criteria

- graph interaction controllers never directly mutate session-backed project objects
- continuous drag/resize/group movement commits through session commands with continuous mode
- pointer-up paths finalize with discrete flush behavior

## Phase 3 — convert renderer/editor mutation surfaces

### Files

- `src/views/studio/graph-v3/StudioGraphNodeResizeHandle.ts`
- `src/views/studio/graph-v3/StudioGraphInlineConfigPanel.ts`
- `src/views/studio/graph-v3/StudioGraphTextInlineEditor.ts`
- `src/views/studio/graph-v3/StudioGraphJsonInlineEditor.ts`
- `src/views/studio/graph-v3/StudioGraphLabelNodeCard.ts`
- `src/views/studio/graph-v3/StudioGraphImageEditorModal.ts`
- `src/views/studio/graph-v3/StudioGraphNodeCardSections.ts`
- `src/views/studio/graph-v3/StudioGraphNodeCardTypes.ts`
- `src/views/studio/graph-v3/StudioGraphWorkspaceRenderer.ts`
- terminal renderer entrypoints that currently receive mutation callbacks

### Replace

- `onNodeConfigMutated(node)`
- `onNodeGeometryMutated(node)`
- mutable `node` editing inside components

with typed callbacks such as:

- `onNodeTitleChange(nodeId, title)`
- `onNodeFieldChange(nodeId, key, value, { mode })`
- `onNodeTextChange(nodeId, text, { mode })`
- `onNodeResize(nodeId, size, { mode })`
- `onNodePresentationChange(nodeId, patch, { mode })`
- `onBoardStateChange(nodeId, state, { mode })`

### Special handling: image editor

The image editor must explicitly support realtime persistence semantics.

That means:

- board-state changes persist as they happen
- rendered asset generation is a derived follow-up, not the only save moment
- if the modal closes unexpectedly, edits should already be in the session
- if we want discard behavior, it must become an explicit `Cancel/Revert` action that restores the pre-open snapshot

### Finish criteria

- no renderer/editor mutates a passed-in `node` object directly
- typing and drag-heavy editors use continuous mode during interaction
- blur/enter/pointer-up/Done finalize with discrete save or flush behavior as appropriate

## Phase 4 — convert all remaining view-owned project mutations

### Files / flows

- `src/views/studio/SystemSculptStudioView.ts`

### Migrate these flows onto session commands

- output lock toggle
- create node
- paste graph payload
- paste text/image
- insert dropped note nodes
- auto-create connection target node
- rename node title
- disconnect node from group
- create group from selection
- remove node(s)
- apply history snapshot
- normalize or repair project-on-open paths
- image-editor rendered asset commit path
- note-path remap / rename / delete handlers

### Finish criteria

- `SystemSculptStudioView.ts` becomes orchestration-only again
- view methods call core mutation helpers instead of editing `this.currentProject` directly
- project repair logic is no longer view-owned

## Phase 5 — move mutation helpers out of the view layer and into core

### Move or re-home

These are deterministic graph mutation helpers and should live in `src/studio`, not under a view tree:

- `src/views/studio/StudioManagedOutputNodes.ts`
- `src/views/studio/systemsculpt-studio-view/StudioRunOutputProjectors.ts`
- `src/views/studio/graph-v3/StudioGraphGroupModel.ts`
- `src/views/studio/graph-v3/StudioGraphGroupAutoLayout.ts` (or split into pure layout + core mutation applier)

### Why

Even if they are already deterministic and testable, their current placement makes it look like the view layer is allowed to own graph mutation logic.

The final architecture should make allowed mutation zones obvious.

### Finish criteria

- project mutation helpers live under `src/studio`
- view code imports core mutation utilities, not the other way around

## Phase 6 — add the session manager and centralize file-sync coordination

### Build

- `StudioProjectSessionManager`
- central vault/file event routing for open project sessions
- attach/detach logic for views
- path-based multi-session coordination

### Update

- `StudioService.ts` to delegate to the manager instead of storing one `currentProjectSession`
- view open/close flow to retain/release sessions cleanly
- external modify/rename/delete reconciliation to go through manager + session

### Finish criteria

- same project opened in multiple leaves resolves to one authoritative session
- same-project live sync is coordinated once
- close/dispose behavior does not orphan timers or state

## Phase 7 — make runtime snapshot-native

### Update

- `src/studio/StudioRuntime.ts`
- `src/studio/StudioService.ts`

### Build

- `runProjectSnapshot(...)` or equivalent runtime entrypoint
- snapshot-based scoped run support
- run artifacts still write the snapshot used for execution

### Finish criteria

- active-session runs do not depend on disk reread for correctness
- service passes session snapshot to runtime
- flush-before-run remains for survivability, not as the only correctness mechanism

## Phase 8 — add guardrails and final cleanup

### Remove legacy surfaces

- remove `scheduleProjectSave()` as a mutation seam
- remove `onNodeConfigMutated(...)` from production Studio source
- remove any stale compatibility wrappers once the migration is complete

### Add tests / enforcement

- architecture-lint tests for forbidden patterns
- readonly type coverage in renderer/controller inputs
- optionally a dev-only freeze/assert mode for session snapshots in tests

### Finish criteria

- future direct-mutation regressions fail fast in CI
- allowed mutation boundaries are enforced by both code structure and tests

---

## Verification matrix

## Core session / manager tests

Add or expand tests for:

- discrete mutation coalescing
- continuous mutation coalescing
- explicit flush after interaction end
- session close waits for in-flight save
- project switch waits for pending save
- multiple views share one session for the same path
- session release/close semantics clean up timers/listeners
- external modify while dirty is deferred
- external modify after self-write is ignored
- rename/delete routing updates or closes active sessions correctly

## Runtime tests

Add or expand tests for:

- run uses the active session snapshot, not a stale disk reload
- scoped run from node uses the latest session graph
- run artifact snapshot matches the snapshot passed from the session

## Studio integration tests

Add or expand tests for:

- move node, reload, position persists
- drag node continuously, interrupt, reload, final position persists
- resize node, reload, size persists
- type text in inline text editor, reload, value persists
- change inline select/number/toggle/json field, reload, value persists
- rename node title, reload, title persists
- create/remove connection, reload, graph persists
- create/rename/recolor/reassign group, reload, group state persists
- create node, remove node, paste nodes, reload, graph persists
- undo/redo applies through the session and persists correctly
- create blur/crop/highlight/labels in image editor, reload, board state persists
- close image editor without Done after edits, reload, live edits still persist (unless explicit revert path is chosen)
- commit rendered image asset and verify derived asset state is refreshed
- rename note file/folder, reload, note node config persists remapped paths
- delete note file/folder, reload, note node config/preview state persists expected result
- switch project immediately after mutation, change persists
- close Studio immediately after mutation, change persists
- run immediately after mutation, latest graph state is used
- two leaves open on same project stay consistent

## Architecture-lint tests

Add a dedicated test suite that fails if:

- `scheduleProjectSave(` exists in non-test Studio source
- `onNodeConfigMutated(` exists in non-test Studio source
- direct graph mutation patterns exist in disallowed view files
- mutation helpers live outside approved core directories

## Manual QA in Obsidian

Verify in the actual app:

- drag node, reload Obsidian, position survives
- resize media node, reload, size survives
- type into text/json/config fields, reload, values survive
- apply image-editor edits, close/reopen/reload, edits survive
- rename/delete linked note files and confirm note nodes reconcile correctly
- open same `.systemsculpt` file in two leaves and verify both stay in sync
- run immediately after edits and confirm runtime uses the just-edited graph
- switch between two projects rapidly during editing and confirm no loss

---

## Definition of done

We should only call persistence “finished” when all of the following are true.

### Structural completion

- `StudioService` uses a real session manager, not a single `currentProjectSession`
- runtime executes from session snapshots
- view code no longer owns graph persistence semantics
- project repair/live-sync coordination is core-owned

### Code-shape completion

- no `scheduleProjectSave(` remains in non-test Studio source
- no `onNodeConfigMutated(` remains in non-test Studio source
- no direct graph mutation remains in renderer/controller/view orchestration files outside approved core mutation modules
- renderer/controller inputs are readonly

### Behavior completion

- node move/resize/config/group/connection/image-editor/vault-sync changes all persist in real time
- close/switch/reload/run cannot lose the latest committed in-session change
- multiple leaves cannot diverge on the same project

### Guardrail completion

- architecture-lint tests exist and pass
- regression coverage exists for all major mutation classes
- `npm run check:plugin:fast` stays green with the new architecture

Until all four sections above are true, the persistence work is improved but not complete.

---

## Recommended implementation order

1. **Add the final session mutation API and command layer**
2. **Convert `SystemSculptStudioView.ts` internal mutations onto that command layer**
3. **Convert graph interaction controllers**
4. **Convert renderer/editor mutation callbacks**
5. **Move mutation helpers from `src/views/studio` into `src/studio`**
6. **Add `StudioProjectSessionManager` and central file-sync routing**
7. **Make runtime snapshot-native**
8. **Add guardrail tests and remove legacy mutation/save APIs**

This order keeps the migration incremental, but still converges on the right final architecture instead of preserving hybrid ownership forever.

---

## Bottom line

The first native pass solved the biggest immediate problem: save ownership is no longer just a view-local debounce.

To make this the **last** major persistence refactor, we still need to finish the deeper conversion:

- path-keyed session manager
- command-first mutation API
- readonly UI inputs
- runtime-from-session snapshots
- core-owned repair/live-sync flows
- CI guardrails that block regression

That is the work required to turn persistence from “better now” into “foundationally done.”
