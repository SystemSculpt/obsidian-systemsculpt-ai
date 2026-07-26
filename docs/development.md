# Plugin development

Work from ~/gits/systemsculpt/plugin with Node 20.10 or newer. Node 22 is the
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
CSS contracts, cheap architecture policy tests, and an exact built-bundle
mobile-host smoke. It is the normal edit loop, not a native-device or provider
test.

Useful focused gates:

~~~bash
npm run check:ui
npm run check:mobile
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
npm run check:full
~~~

check:plugin adds TypeScript, mobile compatibility, sync, artifact, and release
guards. check:ci is the exact PR contract and adds full unit, embeddings,
already-built integration, and release-script suites. check:full is its local
alias.

CI is one secret-free Ubuntu/Node 22 job running npm run check:ci.

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

Successful builds copy main.js, manifest.json, and styles.css. Use the official
Obsidian CLI or Computer Use to reload the plugin and verify real desktop UI.
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

The release command verifies version consistency, rebuilds the production
artifact, and validates exactly manifest.json, main.js, and styles.css. It
rejects local API bases, retired client AI runtimes, provider SDKs, and inline
source maps. Publishing still requires explicit operator approval.

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
