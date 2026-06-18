# Testing Architecture

Last updated: **2026-03-29**

This repo now has two native integration surfaces.

The canonical test story is:

1. Real Obsidian runtime
2. Real vaults
3. Real hosted SystemSculpt flows
4. Desktop and mobile use the native surface that matches the platform instead of forcing one harness to do both jobs

The old separate-instance WDIO harness has been removed.
Dev builds now sync through the shared config-driven pipeline: keep a local-only `systemsculpt-sync.config.json` in the repo root and the watcher will push every successful rebuild into its `pluginTargets` plus any `mirrorTargets`.
Use a `"type": "windows-ssh"` mirror target when the Windows host should stay on the latest bundle without turning that remote path into a local desktop-automation selector on the Mac.

## Layers

### 1. Unit and service tests

Use these for fast logic coverage:

```bash
npm test
npm run test:strict
npm run test:embeddings
npm run check:plugin:fast
```

### 2. Built bundle and mobile contract tests

Use these for artifact-level coverage before any native app or device is involved:

```bash
npm run build
npm run test:integration:ci
```

This suite loads the shipped `main.js` bundle. The mobile contract starts that
bundle under an iPad-like Obsidian runtime and verifies that mobile startup does
not activate desktop-only services such as the desktop automation bridge,
desktop status bar, recorder service, or file context menu service. It is not a
replacement for the real iOS canary. It is the fast gate that catches mobile
startup regressions before anyone reaches for a device.

### 3. Desktop no-focus automation

This is the canonical desktop lane.

- Real Obsidian desktop app
- Real synced vault
- Real chat view and model switching
- No renderer driving or app focus takeover
- Already-running Obsidian only; the harness never launches the app
- Localhost bridge owned by the plugin itself
- Windows is the canonical clean-install desktop host: use a real Windows host to prove brand-new install, enable/load, and “no local Pi installed” behavior instead of inferring that from the already-open macOS dev vault
- Settings-file bootstrap and recovery: patch or touch the target `data.json`, let the running plugin's external-settings sync path reassert the bridge, and on unchanged-file touches expect the bridge to restart in place so wedged listeners can heal without focus takeover
- The external desktop client now tracks discovery changes and can reconnect to a newer bridge record mid-run instead of treating that as a hard failure

Core entrypoints:

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:provider-connected
npm run test:native:desktop:chatview-stress
npm run test:native:desktop:stress
npm run test:native:desktop:soak
SYSTEMSCULPT_DESKTOP_PROVIDER_ID=openai SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY=... npm run test:native:desktop:provider-connected
SYSTEMSCULPT_DESKTOP_PROVIDER_ID=xai XAI_API_KEY=... npm run test:native:desktop:provider-connected
node testing/native/desktop-automation/run.mjs --case extended --no-reload
SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS='{"openai":"..."}' node testing/native/desktop-automation/run.mjs --case provider-connected-baseline --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case chatview-stress --repeat 5 --pause-ms 750 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case stress --repeat 5 --pause-ms 1500 --no-reload
node testing/native/desktop-automation/run.mjs --vault-name <vault-name> --case soak --repeat 25 --pause-ms 1500 --no-reload
node scripts/reload-local-obsidian-plugin.mjs
```

`node scripts/reload-local-obsidian-plugin.mjs` is for an explicit in-place plugin reload after code sync.
Routine attach-only validation should prefer `--no-reload` when the bridge is already live.
`./run.sh --headless` is safe to invoke repeatedly; duplicate launches now reuse the existing watcher instead of stacking background sync loops.
That wrapper now relies on the build-integrated sync path rather than a second polling loop, so local vault sync and Windows host mirroring move in lockstep with each successful rebuild.
`test:native:desktop:provider-connected` is the canonical settings-auth round-trip lane: it injects a provider API key through the bridge, waits for the model catalog to refresh, proves a provider-backed turn, clears auth again, and verifies the same path drops back to Providers guidance.
`test:native:desktop:stress` now specifically churns repeated in-place plugin reloads and fails if the live desktop bridge comes back with duplicate plugin or embeddings status-bar items.
`test:native:desktop:chatview-stress` now churns real chatview state on the same automation leaf, and `test:native:desktop:soak` combines both stress lanes for a longer unattended release candidate run.
When you do not pass a selector, the runner now prefers the latest live bridge target and falls back to the first synced desktop target only if no live bridge can be matched.
Release-candidate desktop proof should include one Windows pass where local Pi is absent, the plugin enables cleanly on a fresh install, hosted SystemSculpt chat still works, and any local-Pi-only path degrades cleanly instead of crashing.
When that release candidate also needs Pi-provider parity, add one provider-connected Windows pass with runner-side env vars (`SYSTEMSCULPT_DESKTOP_PROVIDER_ID`, `SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY`, `SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS`, or the provider-specific env var exposed by the Providers snapshot). The canonical Windows release provider pass is xAI/Grok and requires `XAI_API_KEY` as the GitHub repository secret for `windows-e2e`, or as a runner/local environment variable for local provider-connected checks. Those env vars belong on the runner host, not on the already-running Obsidian process.

Docs:

- [Desktop Automation](./native/desktop-automation/README.md)

### Release matrix

Before ship, the required native matrix is:

- macOS: `npm run test:native:desktop:baselines`
- Windows: GitHub check `windows-e2e` on the exact release commit. The job installs Obsidian on `windows-2025-vs2026`, launches the fresh Windows QA vault, then runs `npm run test:native:windows:clean-install` and `npm run test:native:windows:baselines`.
- Mobile contract: `npm run test:integration:ci` after `npm run build`
- Android: `npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --headless --sync --reset-vault` then `npm run test:native:android:extended`
- iOS canary: GitHub check `ios-canary-release` on the exact release commit. Manual and scheduled runs publish `ios-canary-ad-hoc` so they cannot satisfy the release gate.
- Local iOS fallback: `npm run test:native:ios:debug:open -- --sync --skip-open-apps`, then `npm run test:native:ios:inspect:plugin -- --strict`, then `npm run test:native:ios` when a paired physical device is available

For the Windows-only release gate, run `npm run check:release:windows` after the commit has been pushed and the GitHub check has completed. For the iOS canary release gate, run `npm run check:release:ios-canary` after the `ios-canary` workflow has completed on the exact commit. For local development on a maintained Windows host, use `npm run check:release:windows:local`.

`npm run release:plugin` runs the full plugin check before the native matrix, so the mobile contract is part of the release path. After the final local release commit exists, it runs `npm run check:release:native -- --only-local` before pushing anything. Only after that local phase passes does it push the release commit, wait for `npm run check:release:native -- --only-hosted --github-ref <release-sha>`, and tag the release. `npm run check:release:native` remains the canonical one-command wrapper for the whole native release matrix when no phase flag is passed. It fails the release path if macOS, Windows, Android, or the iOS canary are not green. It only skips local iOS when the host genuinely does not have a paired device plus WebKit adapter available. Use `--require-ios` to force local real-device iOS and `--allow-missing-ios-canary "<reason>"` only for an explicit release exception.

### CI workflows

Automated E2E testing runs in GitHub Actions on every PR and push to main:

| Workflow | Runner | What it proves |
|----------|--------|----------------|
| `ci.yml` | ubuntu-latest | Unit tests, embeddings tests, production build, built-bundle integration suite, mobile startup contract |
| `macos-e2e.yml` | macos-latest | Obsidian .dmg install, vault bootstrap, bridge, managed baseline, release smoke against local provider fixtures (provider listing, chat round-trip, recorder, embeddings) |
| `windows-e2e.yml` | windows-2025-vs2026 | Obsidian `.exe` install, fresh Windows vault bootstrap, local bridge, clean-install parity, xAI/Grok provider pass, and Windows desktop baselines |
| `ios-canary.yml` | self-hosted macOS runner labeled `ios-canary` | Real App Store Obsidian on a paired physical iPhone/iPad, plugin sync, strict plugin inspection, and mobile runtime smoke |

Android E2E still runs locally via the `test:native:android*` scripts against a connected device/emulator.

iOS real-runtime QA requires a physical iPhone or iPad because the App Store Obsidian app cannot run in the iOS Simulator. The canonical path is not an ad hoc release laptop. It is the layered setup above: fast mobile contract tests in CI, Android emulator/device smoke, and the self-hosted `ios-canary` runner for real Obsidian iOS. See `testing/native/device/ios/README.md`.

### 4. Mobile runtime smoke

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

### 5. Native device workflows

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
