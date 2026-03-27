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
npm run test:native:desktop:stress
node testing/native/desktop-automation/run.mjs --vault-name private-vault --case extended --no-reload
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

When the bridge is already live, prefer attach-only `--no-reload` runs.
If discovery disappears while the vault stays open, touching the target plugin `data.json` should republish the bridge on watcher-enabled runtimes without any manual UI interaction.

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
