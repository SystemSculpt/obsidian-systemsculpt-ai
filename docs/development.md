# Plugin development

Work from ~/gits/systemsculpt/plugin with Node 22.18 or newer. Node 22 is the
local and CI baseline; version managers can select it from .nvmrc.

## Setup

~~~bash
npm install
npm run check
~~~

## Fast loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

check runs the canonical Obsidian source and metadata lint, production bundle,
CSS contracts, cheap architecture policy tests, focused mobile interactions,
the ChatView critical-risk coverage gate, and an exact built-bundle mobile-host
smoke. It is the normal edit loop, not a native-device or provider test.

Useful focused gates:

~~~bash
npm run check:ui
npm run check:mobile
npm run test:chatview:critical
npm run test:chatview:mutants
npm run test:integration
npm run test:release-script
~~~

check:mobile runs static mobile safety, rebuilds the production artifact, and
runs the focused mobile interaction suite before opening settings, Chat,
Similar Notes, and portable Studio from the artifact with desktop-only
adapters unavailable. It does not launch Android or iOS.

## Checkpoints

~~~bash
npm run check:plugin
npm run check:ci
npm run check:compat
npm run check:full
~~~

check:plugin adds TypeScript, mobile compatibility, sync, artifact, and release
guards. test:chatview:critical runs the thin Bridge, session transport,
transcript persistence, approvals, queue and recovery controls, and
restored-history UI with strict console, randomized order, open-handle
detection, adversarial race cases, and per-file coverage budgets. check:ci is
the exact exhaustive PR contract and adds strict
mobile interaction, curated mutation, unit, embeddings, already-built
integration, and release-script suites. The mutation gate creates an isolated
temporary source mirror and requires every high-risk native reconciliation,
approval, continuation, mutation-receipt, and conversation-scope mutant to be
killed.
The unit CI remainder excludes focused mobile and ChatView paths already proven
by earlier gates, keeping the exhaustive workflow broad without rerunning the
same suites a third time.
check:compat is the smaller Node and operating-system compatibility contract.
It runs the same critical ChatView suites without repeating coverage collection
already enforced by check:ci.
check:full is the local alias for check:ci.

CI runs check:ci on Ubuntu/Node 22, then runs check:compat on Node 22.18,
Node 24, macOS/Node 22, and Windows/Node 22. The merge queue runs the same
workflow. A final `required` job fails unless every exhaustive and compatibility
lane succeeds. All jobs are credential-free. The installed pre-push hook runs
check:ci locally, while hosted CI and the repository rule requiring `required`
remain authoritative.

Each top-level hosted Jest gate records its replay seed and normalized child
Jest argv in `.cache/ci-evidence/jest-seeds`. A failed lane uploads those
records, the ChatView coverage summary, artifact inspection, build provenance,
and the exact plugin artifact bytes for 14 days. The mutation gate records its
baseline, every killed, surviving, or infrastructure-failed mutant, and its
exact child Jest commands in
`.cache/ci-evidence/chatview-critical-mutants.json`. CI validates the
structured provenance and artifact-inspection sidecars before uploading a
failed gate. Successful release validation writes SHA-256, size, Git revision,
dirty state, Node, platform, and architecture to
`.cache/ci-evidence/release-provenance-<version>.json`. The version-qualified
release record is separate from the rolling CI build provenance, so the
required pre-push gate cannot overwrite it while publishing the tag.

Saved chat parsing fails closed. A malformed or truncated history is never
reduced to a surviving prefix and sent as a new request. Direct loads show a
corruption banner, reset to a fresh unsaved chat, and leave the original note
bytes unchanged.

## Mobile QA pyramid

1. Every PR statically rejects desktop-only imports and private Obsidian mobile
   DOM coupling outside the owned host seams.
2. Focused source tests cover mobile host state, PluginSurface container
   behavior, narrow chat and settings contracts, touch gestures, keyboard and
   accessibility behavior, and portable versus blocked Studio nodes.
3. The production main.js is loaded with Node desktop adapters unavailable.
   Its manifest, compiled styles.css, settings, Chat, Similar Notes, and Studio
   surfaces are checked as the exact three-file plugin artifact.
4. Full unit, managed API fixture, embeddings, integration, artifact, and
   release tests run through npm run check:ci on every PR.
5. When explicitly requested, the exact artifact may also be explored on real
   Obsidian Mobile hardware. Record hashes, host OS and Obsidian versions, phone
   and tablet coverage, orientation, software keyboard, themes, enlarged
   interface text, and the exercised surfaces.

The first four layers are the deterministic compatibility and interaction
release gate. They deliberately avoid Android emulators, iOS Simulator,
self-hosted device runners, and browser mobile emulation. This repository does
not own an iOS app target for Simulator or an APK or IPA for a device farm.
Android emulation adds a nonphysical host, boot, storage-sync, and WebView
debugging lane that has not been reproducible in hosted CI. Browser emulation
reproduces viewport and touch inputs, not the installed Obsidian host. These
manual alternatives are supplemental evidence, not release requirements.

## Local API

The sibling API repository is ~/gits/systemsculpt/website and its development
server listens on port 3002. Compile that address into a local plugin build:

~~~bash
SYSTEMSCULPT_API_BASE_URL=http://127.0.0.1:3002/api/plugin npm run build
~~~

SYSTEMSCULPT_API_BASE_URL is an esbuild-time QA seam. It is never read from
Obsidian settings or runtime environment. Release validation forces
https://systemsculpt.com/api/plugin and rejects loopback URLs.

## Local Obsidian

Copy systemsculpt-sync.config.json.example to the ignored
systemsculpt-sync.config.json and list local plugin directories under
pluginTargets.

~~~bash
./run.sh --headless
npm run sync:local
~~~

For the normal macOS development machine, install the watcher once:

~~~bash
npm run dev:watch:install
npm run dev:watch:status
~~~

The per-user launch agent starts at login, stays running, rebuilds after source
changes, atomically replaces each local artifact, and reloads the plugin through
the official Obsidian CLI. Re-running the install command deliberately moves
the persistent watcher to the current worktree. Use `npm run
dev:watch:uninstall` to remove it.

Successful development syncs copy main.js, manifest.json, and styles.css. The
synced manifest retains the release version used by server wire contracts and
adds a local-only build identity. Settings renders that identity beside the
version, so a development artifact cannot silently impersonate a release
artifact. Production and release manifests never contain the development
identity.

`main.js` and `styles.css` are exact byte copies of the production build
outputs. The source `manifest.json` remains unchanged. Its target counterpart
is intentionally generated by adding `systemsculptDevBuild`, so the two
manifest files do not have the same bytes or SHA-256. That generated identity
records the SHA-256 of all three source artifacts. Sync validates the identity
against one source-byte snapshot, atomically replaces each target file, and
reads every target artifact back before requesting a reload. It never replaces
or removes `data.json`.

A successful command must report the configured plugin reload. A failed
Obsidian CLI reload makes `npm run sync:local` fail instead of reporting a
completed installation. At runtime the plugin hashes the installed `main.js`
through the vault adapter and, for a development install, rejects any mismatch
with the generated manifest claim. The runtime does not use that claim as the
loaded bundle identity.

Use the official Obsidian CLI or Computer Use to verify real desktop UI.
Mobile release confidence comes from portable architecture, focused
interaction tests, and the exact built-bundle smoke. If manual mobile
exploration is explicitly requested, test the synced artifact in portrait and
landscape, with the keyboard open and closed, light and dark themes, enlarged
interface text, and phone plus tablet or equivalent widths. Verify the synced
artifact hashes. No native-device CI or mandatory manual-device gate is part of
this repository.

## Release validation

~~~bash
npm run release:plugin
~~~

The release command first requires the complete check:ci contract. It then
verifies version consistency, rebuilds the production artifact, and validates
exactly manifest.json, main.js, and styles.css. It rejects local API bases,
retired client AI runtimes, provider SDKs, and inline source maps. Publishing
still requires explicit operator approval. The command only succeeds from a
clean Git worktree when the exact version tag exists and points to the same full
revision recorded in release provenance. It always rebuilds the artifacts;
there is no release CLI path that can bind stale pre-existing bytes to a newer
source revision.

~~~bash
npm run smoke:chat:live
~~~

Before releasing a change that touches managed chat, run the live smoke. It
drives the real controller, runtime adapter, capability client, and transport
against production with server-side web search enabled, then sends a
follow-up turn over the settled transcript. Unit fixtures have historically
mismodeled those two flows (6.2.4's empty continuation and 6.2.5's rejected
follow-up). It needs a license key (`SYSTEMSCULPT_LICENSE_KEY` or a local QA
vault), spends a few real chat turns, and is deliberately not part of CI.

The live smoke serializes and reloads the settled search turn, removes the
newer server-execution marker to emulate legacy saved history, and then sends
the follow-up over a new controller/runtime instance. It complements the
deterministic critical-risk replay contract, including the byte-pinned fixture
validated by the website API repository.

## Canonical source references

- API ownership: src/constants/api.ts
- Host capabilities: src/platform/hostCapabilities.ts
- Mobile host layout: src/platform/mobileLayout.ts and
  src/platform/mobileHostLayout.ts
- Settings: src/settings/SettingsTabRegistry.ts
- Commands: src/core/plugin/commands.ts and src/main.ts
- Ribbon actions: src/core/plugin/ribbons.ts
- Built-in tools: src/tools/FirstPartyToolService.ts
- CSS contract: src/css/README.md
- Managed contracts: testing/fixtures/managed
- Release artifacts: scripts/plugin-artifacts.mjs
