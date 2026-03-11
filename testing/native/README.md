# Native Testing

This folder is the canonical integration-testing system for `obsidian-systemsculpt-ai`.

It is built around one idea: **test the plugin inside the actual Obsidian runtime against real vaults and live SystemSculpt behavior whenever possible**.

## What belongs here

- runtime smoke cases that execute inside a live Obsidian runtime
- device/emulator helpers for Android and iOS
- cross-platform parity workflows for desktop and mobile

## Primary command matrix

### Desktop

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
```

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

The shared smoke harness currently covers:

- `chat-exact`
- `file-read`
- `file-write`
- `embeddings`
- `transcribe`
- `web-fetch`
- `youtube-transcript`

Use `--case <name>` on any native smoke command when iterating on a specific failure.

## Device docs

- [Runtime Smoke](./runtime-smoke/README.md)
- [Android](./device/android/README.md)
- [iOS and iPad](./device/ios/README.md)
- [Windows Desktop](./device/windows/README.md)

## Operating principle

When desktop and mobile parity matters, native smoke is the source of truth.
