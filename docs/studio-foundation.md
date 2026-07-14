# Studio architecture

Studio is the portable visual-workflow surface inside the SystemSculpt
Obsidian plugin. Projects are file-native .systemsculpt documents with sibling
assets, run history, and policy state.

## Host boundary

Studio opens on desktop and mobile. Node definitions declare a desktop
hostRequirement only when they need local machine capabilities:

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
- paths.ts, StudioProjectStore.ts, and persistence/ own file-native storage,
  migrations, generation history, and recovery.
- StudioAssetStore.ts owns content-addressed project assets.
- StudioPermissionManager.ts and StudioHostCapabilities.ts own execution gates.
- StudioGraphCompiler.ts owns typed DAG validation.
- StudioBuiltInNodes.ts and nodes/ own node definitions and implementations.
- StudioRuntime.ts owns immutable run snapshots, queueing, events, cache, and
  retention.
- StudioService.ts is the plugin-facing orchestration interface.
- SystemSculptStudioView.ts coordinates the Obsidian leaf and delegates graph,
  clipboard, session, and presentation ownership to focused modules.

## Persistence

For My Project.systemsculpt, Studio stores durable state in:

~~~text
My Project.systemsculpt-assets/
  project.manifest.json
  policy/grants.json
  assets/sha256/
  runs/
  cache/node-results.json
~~~

Project creation never overwrites an existing project or asset directory.
Names remain human-readable and collisions receive numeric suffixes.

## Runtime contracts

- One active run per project; later runs queue.
- Graph edges are typed and do not coerce implicitly.
- Every run receives an immutable project snapshot.
- Node output caching keys resolved inputs and configuration.
- Fatal node errors stop the run unless continueOnError is explicit.
- File, CLI, and host capabilities pass their central policy gates before
  implementation code runs.
- Managed generation uses the first-party SystemSculpt API; Studio exposes no
  alternate provider runtime.

## Interaction contracts

- A .systemsculpt file opens in the Studio view like any other Obsidian file.
- Node actions and configuration remain visible without hover so touch and
  screenshots expose the same functionality.
- Graph grouping, viewport state, selection, clipboard, undo/redo, and live
  file sync persist through their dedicated modules.
- Browser dialog APIs are forbidden by repository policy.

See src/views/studio/DESIGN.md for presentation principles and the README files
beside graph-v3 and systemsculpt-studio-view for current module maps.
