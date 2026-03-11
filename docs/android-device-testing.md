# Android Device Testing

Last verified against the local Android emulator setup workflow: **2026-03-11**.

## Current Direction

The canonical Android lane for `obsidian-systemsculpt-ai` is now:

- Android Studio emulator for deterministic repros
- `adb` for install, relaunch, log collection, and file sync
- Chrome DevTools WebView inspection through `chrome://inspect/#devices`
- a dedicated Android Obsidian vault in shared device storage

This mirrors the existing iPad discipline: one repeatable device path, one sync
config, and one small set of commands we use every time.

## Required Host Tooling

On this Mac, the expected Android stack is:

- Homebrew `openjdk@21`
- Homebrew `android-commandlinetools`
- Homebrew `android-platform-tools`
- Android Studio in `~/Applications/Android Studio.app`
- Android SDK root at `~/Library/Android/sdk`

Recommended shell exports:

```bash
export PATH="/opt/homebrew/opt/openjdk@21/bin:/opt/homebrew/bin:$PATH"
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"
```

## Repo Files

The Android lane now uses these repo-native entrypoints:

- `systemsculpt-sync.android.example.json`
- `npm run android:sync`
- `npm run android:debug:open`
- `npm run android:logcat`
- `npm run android:smoke:runtime`
- `npm run android:smoke:runtime:extended`
- `npm run android:smoke:runtime:stress`

Create a local config at:

```text
./systemsculpt-sync.android.json
```

Suggested starting shape:

```json
{
  "adbSerial": "emulator-5554",
  "vaultName": "SystemSculpt Android QA",
  "vaultPath": "/sdcard/Documents/SystemSculptAndroidQA",
  "pluginId": "systemsculpt-ai",
  "packageId": "md.obsidian"
}
```

`systemsculpt-sync.android.json` is ignored locally and should stay machine-specific.

## Recommended Emulator

Use one dedicated Android phone AVD as the canonical repro lane.

Recommended profile:

- device: Pixel-class phone
- ABI: `arm64-v8a`
- image: Google Play system image
- API level: latest stable installed on this machine

This gives us:

- Play Services behavior close to real user devices
- Apple Silicon performance
- deterministic snapshots and reset flows

## Setup Flow

1. Install the host Android tooling.
2. Install the emulator and one Play Store arm64 system image into `~/Library/Android/sdk`.
3. Create a dedicated AVD in Android Studio or with `avdmanager`.
4. Create a shared-storage Obsidian test vault on the emulator or device.
5. Point `systemsculpt-sync.android.json` at that vault path.
6. Build and sync the plugin into:
   - `<vaultPath>/.obsidian/plugins/systemsculpt-ai`

## Main Commands

Build the plugin:

```bash
npm run build
```

Push the plugin into the Android vault:

```bash
npm run android:sync -- --config ./systemsculpt-sync.android.json
```

Boot the configured emulator, sync, relaunch Obsidian, and open host debug tools:

```bash
npm run android:debug:open -- --config ./systemsculpt-sync.android.json --avd <avd-name> --sync
```

Tail logs for the running Obsidian process:

```bash
npm run android:logcat -- --serial <adb-serial>
```

If Obsidian is not already running and you want the full device log stream:

```bash
npm run android:logcat -- --serial <adb-serial> --full
```

Run the live hosted runtime smoke matrix against the active Android WebView:

```bash
npm run android:smoke:runtime
```

Run the broader hosted-service parity sweep:

```bash
npm run android:smoke:runtime:extended
```

Run the three-pass regression loop:

```bash
npm run android:smoke:runtime:stress
```

Run just one case when you are iterating on a specific failure:

```bash
npm run android:smoke:runtime -- --case file-write
```

## Manual adb Checks

List connected devices and emulators:

```bash
adb devices -l
```

Confirm the device boot completed:

```bash
adb -s <adb-serial> shell getprop sys.boot_completed
```

Launch Obsidian directly:

```bash
adb -s <adb-serial> shell monkey -p md.obsidian -c android.intent.category.LAUNCHER 1
```

Open a vault by deep link:

```bash
adb -s <adb-serial> shell am start -W -a android.intent.action.VIEW -d 'obsidian://open?vault=<vault-name>' md.obsidian
```

## Chrome DevTools

With the emulator or device running and Obsidian open:

1. Open Google Chrome on the Mac.
2. Go to:

```text
chrome://inspect/#devices
```

3. Find the Obsidian WebView target.
4. Inspect the runtime, console output, and network behavior there.

This is the best host-side JS inspection path for Android plugin issues.

## Best-In-Class Android Debug Loop

1. Start the emulator.
2. Open the dedicated Android QA vault in Obsidian.
3. Run:

```bash
npm run build
npm run android:sync -- --config ./systemsculpt-sync.android.json
```

4. Relaunch Obsidian with:

```bash
npm run android:debug:open -- --config ./systemsculpt-sync.android.json
```

5. Keep one log stream open:

```bash
npm run android:logcat -- --serial <adb-serial>
```

6. Use Chrome DevTools for WebView inspection when the issue is not obvious from logs alone.
7. Re-run the live hosted smoke matrix after any fix:

```bash
npm run android:smoke:runtime
```

For release-quality confidence on Android, finish with:

```bash
npm run android:smoke:runtime:stress
```

## Notes

- Android shared-storage paths vary by vault placement; keep the config local instead of hard-coding a single path in the repo.
- If more than one device is connected, always pass `--serial`.
- This Android lane is meant to complement the real iPad lane, not replace it. Android gives us faster emulator determinism; iPad gives us the real Apple mobile surface.
- The extended Android smoke lane now covers the hosted web-fetch and YouTube transcript services in addition to chat, tool loops, embeddings, and audio transcription.
