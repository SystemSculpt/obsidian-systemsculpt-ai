# Native Testing

This folder is the canonical integration-testing system for `obsidian-systemsculpt-ai`.

It is built around one idea: **test the plugin inside the actual Obsidian runtime against real vaults and live SystemSculpt behavior whenever possible**.

## What belongs here

- desktop automation through the plugin-owned localhost bridge
- mobile runtime smoke cases that execute inside a live Obsidian runtime
- device/emulator helpers for Android and iOS
- cross-platform parity workflows for desktop and mobile

## Primary command matrix

### Desktop

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
```

Desktop docs:

- [Desktop Automation](./desktop-automation/README.md)

### Android

```bash
npm run test:native:android
npm run test:native:android:extended
npm run test:native:android:stress
npm run test:native:android:sync -- --config ./systemsculpt-sync.android.json
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --sync
npm run test:native:android:logcat -- --serial emulator-5554
```

### iOS / iPad

```bash
npm run test:native:ios
npm run test:native:ios:debug:open -- --sync --open-xcode
npm run test:native:ios:inspect:plugin -- --strict
npm run test:native:ios:inspect:toggle
```

## Runtime smoke cases

The desktop bridge runner currently covers:

- `model-switch`
- `chat-exact`
- `file-read`
- `file-write`
- `web-fetch`
- `youtube-transcript` in `extended`
- `reload-stress` in `stress`, which repeats no-focus reloads and asserts that the status bar stays singular before and after model/chat work
- `chatview-stress`, which churns real chatview state on one automation leaf: model switches, repeated sends, reset/resume, approval-mode overrides, and web-search toggles
- `soak`, which runs `reload-stress` and `chatview-stress` back to back for longer unattended desktop validation

When the bridge is already live, prefer attach-only `--no-reload` runs.
If discovery disappears while the vault stays open, touching the target plugin `data.json` should republish the bridge on runtimes whose external-settings sync path is alive, whether that change is observed by `fs.watch` or by the polling fallback.

The shared mobile smoke harness currently covers:

- `chat-exact`
- `file-read`
- `file-write`
- `embeddings`
- `transcribe`
- `web-fetch`
- `youtube-transcript`

Use `--case <name>` on any native smoke command when iterating on a specific failure.

## Device docs

- [Desktop Automation](./desktop-automation/README.md)
- [Runtime Smoke](./runtime-smoke/README.md)
- [Android](./device/android/README.md)
- [iOS and iPad](./device/ios/README.md)
- [Windows Desktop](./device/windows/README.md)

## Operating principle

When desktop and mobile parity matters, use the native surface that matches the platform:

- desktop: bridge-based no-focus automation
- mobile: inspectable runtime smoke

Desktop means attach-only to an already-running Obsidian vault. The harness does not launch or foreground the app.
Keep the synced bundle current in the background with `./run.sh --headless` when you want continuous live validation without terminal noise.
Repeated `run.sh --headless` launches now deduplicate to one active watcher, and the desktop client refreshes itself if the live bridge republishes with a new token or port.
When you do not pass a selector, the desktop runner now prefers the latest live bridge target automatically.
