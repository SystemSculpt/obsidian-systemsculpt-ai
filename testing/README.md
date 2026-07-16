# Testing architecture

The plugin has three local test layers:

1. src/**/__tests__ proves module behavior with Jest.
2. testing/integration imports the production bundle and proves managed
   contracts plus Obsidian host composition.
3. scripts/*.test.mjs proves build, release, workflow, mobile-import, sync, and
   repository policy.

Managed fixtures live in testing/fixtures/managed; versioned settings inputs
live in testing/fixtures/settings. Default tests need no provider key, hosted
service, installed app, physical device, or remote host.

## Normal loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

Use a focused Jest path when it names the behavior more clearly.

## Broader gates

~~~bash
npm run check:ui
npm run check:mobile
npm run test:embeddings
npm run test:integration
npm run check:plugin
npm run check:full
~~~

- check verifies Obsidian lint, metadata, the production bundle, CSS, cheap
  architecture policy, and the built bundle in a mobile host.
- check:mobile runs static mobile policy, rebuilds the artifact, and opens
  settings, Chat, Similar Notes, and Studio without desktop-only globals.
- test:integration imports the production artifact in the Obsidian host mock.
- check:plugin adds types, mobile, sync, artifact, and release guards.
- check:full adds the complete unit, embeddings, integration, and release
  suites.

CI contains one secret-free Ubuntu/Node job and runs npm run check. There is no
native-device, operating-system, or provider matrix.

## Real-app verification

systemsculpt-sync.config.json is ignored and lists local Obsidian plugin
targets. ./run.sh copies successful artifacts while watching. Use the official
Obsidian CLI or Computer Use for live reload, runtime errors, DOM inspection,
and visual behavior.
