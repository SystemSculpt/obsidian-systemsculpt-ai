# Studio architecture

Studio is the portable visual-workflow surface inside the SystemSculpt
Obsidian plugin. Projects are file-native .systemsculpt documents with sibling
assets, run history, and policy state.

## Host boundary

Studio opens on desktop and mobile. Node definitions declare a desktop
requiredHostCapabilities only when they need local machine capabilities:

- Typed process
- CLI command
- Terminal
- Dataset adapter
- FFmpeg audio extraction

Portable note, text, JSON, media, transcription, image-generation, and managed
text-generation nodes remain available on mobile. The insert menu omits
unavailable nodes, and run preflight names any desktop-only nodes already
present in an imported project.

StudioHostCapabilities.ts is the single host-policy seam. Do not scatter
Platform checks through node renderers or runtime implementations.

## Deep modules

- types.ts and schema.ts own project contracts and strict parsing.
- paths.ts, StudioProjectStore.ts, and document/ own the single project file,
  migrations, merged edits, per-device merge clocks, and atomic publication;
  persistence/ reconciles independent support files.
- StudioAssetStore.ts owns content-addressed project assets.
- StudioPermissionManager.ts and StudioHostCapabilities.ts own execution gates.
- StudioGraphCompiler.ts owns typed DAG validation, scoped run plans, and
  connected input resolution.
- StudioBuiltInNodes.ts and nodes/ own node definitions and implementations.
- StudioRuntime.ts owns immutable run snapshots, queueing, events, cache, and
  retention.
- StudioProjectSessionManager.ts owns shared session lifetime and serializes
  creation, reload, release, rename, and disposal.
- StudioService.ts is the plugin-facing orchestration interface.
- SystemSculptStudioView.ts coordinates the Obsidian leaf and delegates graph,
  clipboard, session, and presentation ownership to focused modules.

## Project file dialect

A .systemsculpt file is one JSON document in the studio.project.v2 dialect,
designed so people and AI agents can read, edit, and reorganize a project
directly from the file:

~~~json
{
  "schema": "studio.project.v2",
  "id": "proj_8c1f...",
  "name": "My Project",
  "docs": "SystemSculpt/Studio/AGENTS.md",
  "canvas": {
    "nodes": [
      { "id": "prompt", "kind": "text", "x": 20, "y": 20, "width": 280,
        "config": { "value": "Portrait of a fox" } },
      { "id": "image", "kind": "image_generation", "x": 400, "y": 20 }
    ],
    "edges": ["prompt.text -> image.prompt"],
    "groups": [],
    "shapes": [],
    "arrows": []
  }
}
~~~

- The file carries only user-authored canvas content plus identity. Engine
  settings, the permissions reference, timestamps, entry points, and migration
  history are derived at load time or live in the assets directory.
- Node kinds omit the studio. prefix. Edges and shape arrows are "from -> to"
  strings; an edge port may be omitted when its node has exactly one matching
  port. A labeled arrow is written as the object
  {"from": "a", "to": "b", "label": "text"} instead of the string.
- docs points at the generated agent reference (node kinds, ports, config
  fields, editing rules) that Studio keeps current in the vault.
- Studio still reads v1 and legacy documents and rewrites them as v2 on the
  next save. The schema never moves backward, and agent file tools validate
  every proposed edit before bytes reach the vault.
- Migration converts retired node kinds (Label, HTTP Request, Prompt Template,
  Resend Audience Sync); retired request nodes lose their configuration.
  Before the first v2 rewrite, Studio copies the original file byte for byte
  to legacy/<timestamp>-v1-original.json in the assets directory, once per
  distinct original, and names that copy in a notice.
- Files written by 6.10 also embed merge state in a document field. Studio
  reads their readable canvas and drops that state on the next edit, after
  copying the first such original once to
  legacy/<timestamp>-document-state-original.json.

## Persistence

For My Project.systemsculpt, Studio stores durable state in:

~~~text
My Project.systemsculpt-assets/
  project.manifest.json
  policy/grants.json
  assets/sha256/
  runs/
  cache/node-results.json
  legacy/
  clock/<device>.json
~~~

Project creation never overwrites an existing project or asset directory.
Names remain human-readable and collisions receive numeric suffixes.

The canvas is a living document. Each session keeps the last accepted document
and rebases its edits onto the current file before saving. Independent node and
field edits merge, including changes arriving while a save or asynchronous
producer is running. Separate changes to the same text merge; overlapping ones
keep the file's value, and the session offers its own version as an Undo step.
A whole-file copy from another device merges field by field by hybrid-clock
stamps: the newer change wins, entities the other device never saw are kept,
and deleted cards stay deleted until an explicit Undo or restore. Each device
writes its stamps, deletion keys and file watermarks for 30 days to its own
clock file (see ADR-0004); without one, the copy's modification time dates
its values. Removing generated outputs also removes their pins and parent
references; concurrent deletion removes references added by another writer.
Every publication validates the project before atomically replacing its single
visible file. Invalid documents remain untouched until corrected.

Assets and run files arrive independently of the canvas. A canvas save never
requires the support tree to match an older snapshot and never prunes files
created by another writer. Cache and run indexes combine independent results.
Missing local media displays a waiting state and refreshes on vault events;
available archived assets can be restored without rerunning a paid operation.

Plugin reload preserves Studio leaves, project paths, viewport state, and
pending editing snapshots in a process-local handoff. The next plugin instance
waits for teardown, restores those tabs, and reconciles pending edits with the
current file. This handoff neither starts runs nor transfers another device's
window layout.

## Runtime contracts

- One active run per project; later runs queue.
- Graph edges are typed and do not coerce implicitly.
- Every run receives an immutable project snapshot.
- Every node records its latest outputs in `cache/node-results.json`. Nodes
  that cache by inputs reuse that record when their resolved inputs and
  configuration are unchanged; nodes that never cache (text, image and video
  generation, transcription, Codex, processes, commands, notes, datasets)
  execute every time they are run.
- **Run** on a card runs that card. Upstream nodes are walked only through
  cacheable nodes; a never-cached upstream node is a boundary that is never
  re-executed on the user's behalf. Its latest recorded output (from the node
  cache, or from retained run history for older projects) feeds the run, and
  nothing beyond it is touched. If that node has never produced an output
  the run stops with "Run <node> first". Running a video card therefore uses
  the image already on the canvas instead of regenerating it.
- Native Codex run preparation uses that same queued run plan to resolve
  connected context without executing the target card. Multiple connections
  to one input preserve each producer's value, including array-valued outputs.
- Disabling a node skips it, and the skip propagates: any node whose required
  input port loses every producer is skipped too, instead of running with that
  input missing. A node keeps running when only optional inputs are lost, or
  when a required port still has one live producer.
- Fatal node errors stop the run unless continueOnError is explicit. A run that
  ends with nodes that never ran is reported as failed, naming them, rather
  than as a success.
- File, CLI, and host capabilities pass their central policy gates before
  implementation code runs.
- Managed generation uses the first-party SystemSculpt API; its contract exposes no
  alternate provider runtime.

## Local process protocol

On Obsidian Desktop, `process` nodes run an executable without a shell. Add
input/output ports in the node's configuration as JSON arrays, for example
`[{"id":"snapshot","type":"json","required":true}]`. Ports are typed by the
same compiler used for the rest of the canvas. Up to 32 custom ports per
direction are supported; `stdout`, `stderr`, `exit_code`, and `timed_out` are
reserved outputs. Process nodes run each time and do not reuse cached results.

Before an unapproved process runs from the canvas, Studio shows its executable,
arguments, and working directory. Approval adds an exact executable grant for
that project; existing CLI wildcard grants do not approve process nodes.
A grant permits that executable with the project's configured arguments.
The program runs with the desktop user's OS permissions; Studio's permission
manager is an execution gate, not an operating-system sandbox. Inspect scripts
and arguments before approving an imported project.

The process receives these environment variables:

- `STUDIO_INPUTS`: a UTF-8 JSON file with `schema: "studio.process.inputs.v1"`,
  `runId`, `nodeId`, `inputs`, and `rawInputs`.
- `STUDIO_OUTPUTS`: write a UTF-8 JSON object with
  `schema: "studio.process.outputs.v1"` and an `outputs` object.
- `STUDIO_RUN_DIR`, `STUDIO_RUN_ID`, and `STUDIO_NODE_ID`: temporary run directory
  and identities. Temporary files are removed when the run finishes.

The optional stdin mode sends the same input manifest. Argument templates
`{{inputs}}`, `{{outputs}}`, `{{run_dir}}`, and `{{input.name}}` substitute values
without shell interpretation; an exact array input expands into separate
arguments. Custom environment values cannot override `STUDIO_*` variables.

Both manifests are limited to 1 MiB. Each captured output stream is limited to
1 MiB or the node's smaller setting. File-reference outputs are staged as Studio
assets within a total 64 MiB maximum per node. Lines of the form
`::studio-progress 50 Rendering` update the canvas progress. Timeout and nonzero
exit fail the node by default. Cancellation stops the child; on macOS and Linux,
it also stops the child's process group. Windows currently stops the direct
child only. These nodes remain visible in imported mobile projects, with local
execution disabled and a Desktop explanation; portable nodes still work.

## Interaction contracts

- A .systemsculpt file opens in the Studio view like any other Obsidian file.
- Node actions and configuration remain visible without hover so touch and
  screenshots expose the same functionality.
- Graph grouping, viewport state, selection, clipboard, undo/redo, and live
  file sync persist through their dedicated modules.
- Browser dialog APIs are forbidden by repository policy.
- The canvas has no corner. Positions are unbounded world coordinates; the
  viewport scrolls an elastic box that grows ahead of the view in every
  direction, so users move as they please without a fixed edge. Saved views
  store the world coordinate under the viewport's top-left corner.
- Run activity is one presentation grammar. Node cards, cables, port pins,
  Codex run cards, and workflow steps all carry `data-activity`, derived by
  src/views/studio/activity from run events, native Codex runs, and workflow
  plans. A working node shows a spinner, progress bar, and breathing halo;
  its outgoing cables surge with travelling energy until the result lands;
  settled phases keep their color. Activity-only events patch the canvas in
  place; only outputs and placeholders rebuild it.

See src/views/studio/DESIGN.md for presentation principles and the README files
beside canvas, systemsculpt-studio-view, and activity for current module maps.


## Manual canvas placement

Ordinary cards and drawings keep their authored positions. Editing content, resizing,
changing focus, and opening a project never arrange or sort existing items.
Dragging a card, shape, or group displays edge and center alignment guides and
nearest-neighbor distances in canvas pixels. Movement gently snaps within 5 screen
pixels of a matching edge or center, using the same radius at every zoom. Dragging
beyond that radius releases the snap. Exact alignment uses a solid line; nearby targets use a dashed line
and show the remaining pixel offset. Node resize guides likewise leave the
dragged edge under your control.

Image and video generators are a scoped exception: each producer gets an
Outputs container to its right. New runs append distinct cards in generation
order, arranged in three columns with 48 px gaps and measured row heights.
Pending cards become completed media in place. The container can be dragged as
a unit, preserving its offset from the producer. It follows the producer when
that node moves or changes width, and its contents reflow when media loads or
changes size. Only generated
members of an output container participate. The source and ordinary canvas
items never move as part of output arrangement.

Every saved node includes its coordinates, and undo snapshots preserve them.
Older managed documents that omitted coordinates recover missing positions once
on import. Explicit coordinates are preserved; the next save writes a manual
canvas. Organizational parents and execution connections do not control placement.

Text execution can instead use the installed Codex app-server on desktop. `services/codex/` contains the thin transport, native approval UI, local thread locator and ChatView presentation adapter. `studio.codex` runs explicit task prompts; the text-generation adapter honors the selected backend without creating managed operation receipts for local runs. Codex owns native sessions and all agent continuation.


### Media model catalog, favorites, and per-model inputs

Image Generation and Video Generation cards open a **model catalog** from their
model field instead of a dropdown. The catalog lists every currently available
model with its service price, provider, release month, typical generation time,
and what it accepts as input: reference-image capacity or text-only for image
models; first-frame and last-frame support, resolutions, clip lengths, and audio
for video models. Search matches names, providers, ids, and capabilities; sort
chips order by release date, recommendation, price, or speed. A star pins a
model to the top of its picker. Favorites persist per media kind in plugin
settings as opaque service model ids.

The selected model shapes the card. Input ports the model cannot take are
removed (the reference `images` port for a text-only image model, a frame port
the video model does not support), and fields with no choice for that model
(sizes, quality, audio, single-value durations) are hidden. A port that is still
wired when the model changes stays visible, dimmed, with the reason in its
tooltip, so the edge is never silently orphaned. Reference image limits reflect
both the selected model and the plugin's maximum of four images per job. Runs
validate these limits before any credits are held: too many reference images,
references for a text-only model, or a frame role the model rejects stop the run
with an explanation. Blank model means the service default, whose limits apply.

The service supplies models, credit estimates, batch limits, sizes, ratios, and
quality levels. Picking a different model resets output options to defaults.
Model availability and pricing can change without a plugin release; the plugin
caches a catalog for five minutes so cards render synchronously.

Estimates include the SystemSculpt service fee. Actual usage determines the final
charge under the billing terms accepted at submission. Reference images and
prompt processing can add cost, and the temporary credit hold can exceed the
estimate. A result with unverifiable billing remains withheld for reconciliation.
Reconnect to the existing job after a connection failure; starting a new node run
creates a separate billable operation.

Model choices use the negotiated image job v2 contract. Input uploads, durable
operation identity, and verified output downloads stay on the existing first-party
transport. Model IDs, output size, and quality participate in local replay identity.

### Video generation

Video Generation cards generate one clip per run from a prompt, with optional
**first frame** and **last frame** still-image inputs. The **Video model**
selector is required: the service publishes each model's supported durations,
resolutions, aspect ratios, audio support, and credit estimate per clip, and the
dependent pickers follow the selected model. Leaving a dependent option on
**Model default** lets the service apply the model's own default; a saved
selection the model no longer supports snaps to the nearest allowed value. When
the node starts, Studio adds a connected placeholder card that shows
**Generating video…** and becomes the video card once the clip is saved.

Video jobs run on the negotiated media job v2 contract with the same durable
operation identity, recovery records, and verified downloads as images. The
plugin reads `hosted_videos` from the service configuration before starting a
job and reports delivery timing back to the service after the clip is written
to the vault. Deployments that do not advertise video generation reject the node
before any credits are held.
The plugin neither calculates the bill nor owns provider credentials or pricing.
