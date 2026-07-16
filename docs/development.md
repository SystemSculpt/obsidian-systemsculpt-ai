# Plugin development

Work from ~/gits/systemsculpt/plugin with Node 20.10 or newer.

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
opens settings, Chat, Similar Notes, and portable Studio with desktop-only
adapters unavailable. It does not launch Android or iOS.

## Checkpoints

~~~bash
npm run check:plugin
npm run check:full
~~~

check:plugin adds TypeScript, mobile compatibility, sync, artifact, and release
guards. check:full adds full unit, embeddings, compiled integration, and
release-script suites.

CI is one secret-free Ubuntu/Node job running npm run check. Local focused tests
and full checkpoints provide the additional depth when a change needs it.

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
Mobile confidence comes from portable architecture, the exact built-bundle
smoke, and real Obsidian Mobile verification. For mobile-sensitive changes,
test the synced artifact in portrait and landscape, with the keyboard open and
closed, light and dark themes, enlarged interface text, and phone plus tablet
or equivalent widths. Verify the synced artifact hashes. No native-device CI
harness is part of this repository.

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
