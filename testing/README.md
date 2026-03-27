# Testing Architecture

Last updated: **2026-03-27**

This repo now has two native integration surfaces.

The canonical test story is:

1. Real Obsidian runtime
2. Real vaults
3. Real hosted SystemSculpt flows
4. Desktop and mobile use the native surface that matches the platform instead of forcing one harness to do both jobs

The old separate-instance WDIO harness has been removed.
Dev builds no longer auto-sync into any retired fixture vault path; use `SYSTEMSCULPT_AUTO_SYNC_PATH` or the native sync scripts when you want a live vault copy.

## Layers

### 1. Unit and service tests

Use these for fast logic coverage:

```bash
npm test
npm run test:strict
npm run test:embeddings
npm run check:plugin:fast
```

### 2. Desktop no-focus automation

This is the canonical desktop lane.

- Real Obsidian desktop app
- Real synced vault
- Real chat view and model switching
- No renderer driving or app focus takeover
- Already-running Obsidian only; the harness never launches the app
- Localhost bridge owned by the plugin itself
- Settings-file bootstrap and recovery: patch or touch the target `data.json`, let the running plugin's external-settings sync path reassert the bridge, and on unchanged-file touches expect the bridge to restart in place so wedged listeners can heal without focus takeover
- The external desktop client now tracks discovery changes and can reconnect to a newer bridge record mid-run instead of treating that as a hard failure

Core entrypoints:

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:chatview-stress
npm run test:native:desktop:stress
npm run test:native:desktop:soak
node testing/native/desktop-automation/run.mjs --case extended --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case chatview-stress --repeat 5 --pause-ms 750 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case stress --repeat 5 --pause-ms 1500 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case soak --repeat 25 --pause-ms 1500 --no-reload
node scripts/reload-local-obsidian-plugin.mjs
```

`node scripts/reload-local-obsidian-plugin.mjs` is for an explicit in-place plugin reload after code sync.
Routine attach-only validation should prefer `--no-reload` when the bridge is already live.
`./run.sh --headless` is safe to invoke repeatedly; duplicate launches now reuse the existing watcher instead of stacking background sync loops.
`test:native:desktop:stress` now specifically churns repeated in-place plugin reloads and fails if the live desktop bridge comes back with duplicate plugin or embeddings status-bar items.
`test:native:desktop:chatview-stress` now churns real chatview state on the same automation leaf, and `test:native:desktop:soak` combines both stress lanes for a longer unattended release candidate run.
When you do not pass a selector, the runner now prefers the latest live bridge target and falls back to the first synced desktop target only if no live bridge can be matched.

Docs:

- [Desktop Automation](./native/desktop-automation/README.md)

### 3. Mobile runtime smoke

This is the shared Android and iOS real-runtime harness.

- Real Obsidian mobile runtime
- Real vault fixtures and writes
- Real hosted SystemSculpt chat/tool/embeddings/transcription/web flows
- Shared smoke engine across Android WebView and iOS WebKit adapter sessions

Core entrypoints:

```bash
npm run test:native:android
npm run test:native:android:extended
npm run test:native:android:stress
npm run test:native:ios
```

Docs:

- [Native Testing](./native/README.md)
- [Runtime Smoke](./native/runtime-smoke/README.md)

### 4. Native device workflows

These are the real-device and real-emulator setup/debug loops around the native smoke harness.

- Android: [Native Android](./native/device/android/README.md)
- iOS/iPad: [Native iOS and iPad](./native/device/ios/README.md)
- Windows desktop: [Native Windows Desktop](./native/device/windows/README.md)

## Naming Rules

- `test:native:*` is the canonical integration-testing surface.
- `runtime:smoke:desktop*` points at the desktop bridge runner.
- `runtime:smoke/run.mjs` is mobile-only now.
- `android:*` and `ios:*` remain aliases for the mobile runtime harness.

## Current Directory Shape

- `testing/native/`
  - desktop automation, mobile runtime smoke, and real-device workflows

The important rule is that **all integration-test architecture now lives under `testing/native`**.
