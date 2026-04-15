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
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --headless --sync --reset-vault
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

`android:sync` now builds a production bundle by default and rejects `main.js`
files that still contain inline `sourceMappingURL=data:` output. That keeps the
mobile lane from accidentally syncing the dev watcher bundle.

Example:

```bash
npm run build
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --sync --reset-vault
npm run test:native:android:extended
```

No-focus background lane:

```bash
npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --headless --sync --reset-vault
npm run test:native:android:extended
```

If you intentionally want to reuse the current artifact set, pass `--skip-build`
through to `android:sync` or `android:debug:open --sync`.

Hosted smoke auth is bootstrapped automatically when either
`SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY` or `SYSTEMSCULPT_E2E_LICENSE_KEY` is
available in the repo environment, including `.env.local`.

## Vault contract

Use a dedicated app-data vault and keep its sync config local in:

```text
./systemsculpt-sync.android.json
```

That file stays ignored and machine-specific.

The local config can set `avdName` so the helper boots the emulator automatically
when no Android device is already attached. Keep the vault under
`/sdcard/Android/data/md.obsidian/files/...`; the broader `/sdcard/Documents`
path is convenient for manual browsing but has proved less reliable for
repeatable headless cleanup on emulators.
