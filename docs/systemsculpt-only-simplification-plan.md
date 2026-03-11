# SystemSculpt-Only Simplification Plan

Last verified against code, tests, and local device workflow: **2026-03-10**.

## Principle

One word: **simplicity**.

The plugin should stop behaving like a platform and become a focused `SystemSculpt` client.

## Single Path Contract

This is the canonical contract now:

- `SystemSculpt` is the only chat experience
- desktop and mobile use the same SystemSculpt path
- there is no chat picker because there is nothing to pick
- there is no agent-mode toggle because there is no second execution path to toggle
- Pi is an internal API concern, not a plugin feature

## What The Device Work Told Us

The iPad work answered two separate questions:

1. Can the plugin load on mobile?
2. Can the product actually work on mobile?

The answer is:

- yes, the plugin can load on iPad
- chat only becomes truly mobile-ready when it stops assuming desktop-local Pi

That means the real blocker was architecture, not a small mobile UI bug.

## Canonical Troubleshooting Stack

### Shared principle

Use the real vault, the real plugin build, and the real device.

### iOS and iPadOS

Canonical loop:

- sync the built plugin directly into the real vault
- relaunch Obsidian with `devicectl`
- inspect the live runtime through `remotedebug_ios_webkit_adapter` or Safari Web Inspector
- keep one live runtime-inspection session at a time

Best supporting tools:

- `scripts/sync-local-vaults.mjs`
- `systemsculpt-sync.ios.json`
- `scripts/inspect-ios-plugin-state.mjs`
- `xcrun devicectl`
- QuickTime for screen mirroring
- Console for logs

Verified nuance:

- the reliable Community Plugins toggle state is the rendered `.checkbox-container.is-enabled` class, not the raw checkbox input value

### Android

Canonical loop:

- Android Studio emulator for fast iteration
- one real Android device for final confidence
- `adb` for relaunch and device checks
- Chrome DevTools WebView inspection for live Obsidian runtime debugging

## Target Product Split

### Plugin owns

- Obsidian UI
- vault reads and writes
- context gathering
- chat persistence
- note attachments and local interactions
- local embeddings storage and search, at least initially

### API owns

- license validation
- user auth
- provider selection
- model selection
- chat execution
- audio, document, and image processing
- embeddings generation
- quotas, credits, telemetry, and kill switches

### Admin UI owns

- which provider/model is live
- rollout switches
- safety controls
- pricing and availability decisions

### Explicitly remove from the plugin

- public Pi branding
- public provider selection
- public model selection
- public agent-mode selection
- public custom endpoint support
- public local runtime support
- public BYO API-key logic

The user should not need to know what sits behind SystemSculpt.

## TDD Contract

Every simplification step should land with tests first or tests in the same change.

### Unit and service tests must prove

- `getModels()` returns one canonical `SystemSculpt` chat identity
- stale or legacy saved model ids collapse back to that identity
- chat previews build `/chat/completions` payloads
- chat streaming uses SystemSculpt API responses, not local Pi execution
- release checks fail if Pi runtime or terminal sidecar assets are still required

### Integration and live tests must prove

- native Obsidian desktop can load the plugin and complete a SystemSculpt chat turn
- iPad can load the plugin and complete a SystemSculpt chat turn
- Android emulator or device can load the plugin and complete a SystemSculpt chat turn
- embeddings generation and Similar Notes still work through the simplified `SystemSculpt` path

## Recommended Migration Sequence

### Phase 1: Lock the public contract

- rewrite plugin language around `SystemSculpt` only
- remove Pi/provider/custom/model wording from user-facing setup
- remove the model picker
- remove the agent-mode toggle

### Phase 2: SystemSculpt chat first

- make SystemSculpt chat the only shipped chat path
- make the canonical `SystemSculpt` chat identity the only shipped chat target
- switch desktop and mobile chat to that same SystemSculpt contract

This is the highest-value cut because chat is the main mobile blocker.

### Phase 3: Remove local and custom paths

- strip public custom provider settings
- strip public local Pi setup/auth/runtime settings
- strip migration behavior that keeps unsupported public paths alive
- delete dead execution branches once the SystemSculpt path is stable

### Phase 4: Finish the processing cutover

- keep embeddings generation on the API
- keep local vector storage/search only if it still buys simplicity
- otherwise move more processing server-side once the SystemSculpt contract is stable

### Phase 5: Admin-only routing

- expose engine switches only in the website admin UI
- plugin consumes one clean `SystemSculpt` capability surface
- product changes ship from admin controls, not plugin rewrites

## Pi And Terminal Removal Map

### Release and build

- `package.json`
  - remove `build:pi-runtime`
  - remove `verify:pi-runtime`
  - remove `build:terminal-runtime`
- `scripts/release-plugin.mjs`
  - stop building or packaging Pi runtime assets
  - stop building or packaging `studio-terminal-sidecar.cjs`

### Sync and E2E harness

- `scripts/sync-local-vaults.mjs`
  - stop copying `studio-terminal-sidecar.cjs`
  - stop syncing Pi runtime payloads into vault plugin folders
- `testing/e2e/run.mjs`
  - stop building Pi runtime and terminal runtime assets for release-asset mode
- `testing/e2e/utils/obsidian.ts`
  - stop requiring `studio-terminal-sidecar.cjs` as a base plugin file

### Runtime and services

- `src/services/pi/*`
  - remove shipped Pi runtime/bootstrap/process execution once the SystemSculpt path is stable
- `src/services/pi-native/*`
  - remove shipped model-catalog and runtime assumptions after migration
- `src/services/ModelManagementService.ts`
  - one canonical chat identity only
- `src/services/SystemSculptService.ts`
  - one SystemSculpt chat path only

### Settings, setup, and UI

- remove public provider setup sections
- remove public custom endpoint sections
- remove public chat picker modal and chooser wiring
- remove public agent-mode toggle and copy
- remove Pi auth/setup copy from onboarding and setup tabs

### Studio terminal code and tests

- `src/studio/terminal/*`
- `src/studio/StudioTerminal*`
- `src/views/studio/*terminal*`
- related Studio terminal tests

The terminal is no longer part of the shipped plugin contract, so this code should move toward deletion rather than preservation.

## Canonical Near-Term Implementation Moves

1. Keep the single canonical `SystemSculpt` chat identity as the only chat target in the shipped plugin.
2. Remove chat-picker and agent-mode UI surfaces so the plugin stops pretending there are multiple execution modes.
3. Keep `SystemSculptService.streamMessage()` on the SystemSculpt chat endpoint only.
4. Remove provider/custom/local setup surface from plugin settings.
5. Re-run real-device validation on iPad first, then Android, against the SystemSculpt-only path.

## Definition Of Simpler

This simplification is successful when all of the following are true:

- the plugin works the same way on desktop and mobile for core chat
- users only configure `SystemSculpt`, not providers or models
- admin controls choose the real backend
- mobile troubleshooting is mostly network/runtime inspection, not architecture archaeology
- deleting old code is the rule, not preserving parallel compatibility paths
