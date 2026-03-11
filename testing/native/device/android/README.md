# Android Native Testing

Android is a first-class parity lane now.

Canonical tools live here:

- `testing/native/device/android/utils.mjs`
- `testing/native/device/android/sync-plugin.mjs`
- `testing/native/device/android/open-debug-tools.mjs`
- `testing/native/device/android/logcat.mjs`

## Host setup

Expected stack on this Mac:

- Android Studio
- Android SDK at `~/Library/Android/sdk`
- `adb`
- emulator tooling
- `openjdk@21`

## Main commands

```bash
npm run test:native:android:sync -- --config ./systemsculpt-sync.android.json
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --sync
npm run test:native:android:logcat -- --serial emulator-5554
npm run test:native:android
npm run test:native:android:extended
npm run test:native:android:stress
```

## Canonical workflow

1. Build the plugin.
2. Sync the plugin into the Android vault.
3. Relaunch Obsidian on the emulator or device.
4. Inspect the WebView through Chrome DevTools if needed.
5. Run the native smoke matrix.

Example:

```bash
npm run build
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --sync
npm run test:native:android:extended
```

## Vault contract

Use a dedicated shared-storage vault and keep its sync config local in:

```text
./systemsculpt-sync.android.json
```

That file stays ignored and machine-specific.
