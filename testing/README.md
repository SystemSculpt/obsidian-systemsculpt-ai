# Testing Architecture

Last updated: **2026-03-11**

This repo now has one integration-testing model.

The canonical test story is:

1. Real Obsidian runtime
2. Real vaults
3. Real hosted SystemSculpt flows
4. Shared smoke cases across desktop and mobile

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

### 2. Native runtime smoke

This is the main parity layer for desktop and mobile.

- Real Obsidian app/runtime
- Real vault fixtures and writes
- Real SystemSculpt chat/tool/embeddings/transcription/web flows
- Same smoke engine across macOS desktop, Windows desktop, Android, and iOS adapter sessions

Core entrypoints:

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
npm run test:native:android
npm run test:native:android:extended
npm run test:native:android:stress
npm run test:native:ios
```

Docs:

- [Native Testing](./native/README.md)
- [Runtime Smoke](./native/runtime-smoke/README.md)

### 3. Native device workflows

These are the real-device and real-emulator setup/debug loops around the native smoke harness.

- Android: [testing/native/device/android/README.md](/Users/systemsculpt/gits/obsidian-systemsculpt-ai/testing/native/device/android/README.md)
- iOS/iPad: [testing/native/device/ios/README.md](/Users/systemsculpt/gits/obsidian-systemsculpt-ai/testing/native/device/ios/README.md)
- Windows desktop: [testing/native/device/windows/README.md](/Users/systemsculpt/gits/obsidian-systemsculpt-ai/testing/native/device/windows/README.md)

## Naming Rules

- `test:native:*` is the canonical integration-testing surface.
- `runtime:smoke:*`, `android:*`, and `ios:*` remain as compatibility aliases for the same native harness.

## Current Directory Shape

- `testing/native/`
  - native runtime smoke and real-device workflows

The important rule is that **all integration-test architecture now lives under `testing/native`**.
