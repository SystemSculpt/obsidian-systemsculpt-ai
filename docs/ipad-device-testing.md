# iPad Device Testing

Last verified against a local iOS device-testing environment: **2026-03-10**.

## Current Status

The host Mac can see the plugged-in device through Xcode tooling:

- device name: `<paired iPad name>`
- state: `available (paired)`
- lock state: unlocked since boot
- Developer Mode: enabled
- Obsidian app: installed as `md.obsidian` (`1.12.4`)

That means the physical-device lane is viable from the current machine.

The local iCloud-backed test vault can live at:

```text
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<your-ios-test-vault>
```

The repo-side sync config is now:

```text
./systemsculpt-sync.ios.json
```

The direct-vault dev loop looks like this:

- repo build output syncs into `<your-ios-test-vault>/.obsidian/plugins/systemsculpt-ai`
- the synced `main.js` can be verified byte-for-byte against the repo build
- the mobile target stays trimmed to about `5.6M` because desktop runtime payloads are excluded
- the adapter-backed WebKit lane can now prove live plugin state from the Mac with `npm run ios:inspect:plugin -- --strict`
- the same lane can now also prove the rendered Community Plugins toggle state with `npm run ios:inspect:toggle`

## Apple ID Decision

### Easiest option

Use the **same Apple account** as the Mac if we want the simplest iPad testing loop.

Why:

- we can use an iCloud-backed Obsidian vault
- the repo already has a local sync script that can copy plugin builds into any vault path on macOS
- iCloud will carry those plugin file changes to the iPad automatically

### Different Apple account

Using a different Apple account is still possible, but it is more complicated.

It does **not** block:

- plugging the iPad into the host Mac
- Safari Web Inspector
- trusting the device on the host Mac

It **does** complicate the easiest sync path:

- you cannot rely on the same iCloud Drive vault path as the Mac
- you will want either:
  - Obsidian Sync
  - a separately shared vault workflow
  - manual file transfer/update steps

## Recommended Setup

### Path A: same Apple account on the iPad

This is the recommended first setup.

1. Open the dedicated iCloud-backed vault `<your-ios-test-vault>` on the iPad.
2. Use the live repo sync config:

```text
./systemsculpt-sync.ios.json
```

3. Run the existing watcher/sync loop from the repo.
4. Use Safari Web Inspector against the connected iPad when needed.

This gives the cleanest dev loop:

- edit on Mac
- build on Mac
- sync plugin files into the iCloud vault on Mac
- let iCloud propagate to iPad
- reopen/reload plugin on iPad

### Path B: different Apple account on the iPad

Use this only if needed.

Recommended fallback:

1. Keep the iPad on that Apple account.
2. Use Obsidian Sync for the test vault.
3. Let the Mac update the vault/plugin files locally.
4. Let Obsidian Sync move those changes to the iPad.

This can work well, but it adds one more moving piece than the same-account iCloud route.

## Web Inspector Checklist

On the iPad:

1. Enable Web Inspector in Safari advanced settings if it is not already enabled.
2. Trust the Mac if prompted.
3. Keep Obsidian open on the test vault while connected.

Developer Mode should stay enabled on the paired device for deeper device tooling.

On the Mac:

1. Open Safari.
2. Use the Develop menu to find the connected iPad and inspect the Obsidian web content if it appears.

## Repo Workflow

### Existing commands

Fast local build/watch:

```bash
bash run.sh
```

One-off sync:

```bash
npm run sync:local -- --strict --config ./systemsculpt-sync.ios.json
```

### Notes

- `systemsculpt-sync.ios.json` should point at the live iCloud test vault `<your-ios-test-vault>`.
- `systemsculpt-sync.ios.example.json` remains the template if we want to spin up another iOS vault later.
- The current default sync config in the repo does **not** point at any iCloud Obsidian vault yet.

## Verified Automation Lanes

### Works well from the host Mac

- Build and sync latest plugin files directly into the live iCloud vault:

```bash
npm run build
npm run sync:local -- --strict --config ./systemsculpt-sync.ios.json
```

- Relaunch Obsidian on the connected iPad:

```bash
xcrun devicectl device process launch \
  --device <device-udid> \
  --terminate-existing \
  --payload-url 'obsidian://open?vault=<your-ios-test-vault>' \
  md.obsidian
```

- Verify the device is connected, unlocked, and paired:

```bash
xcrun devicectl list devices
xcrun devicectl device info lockState --device <device-udid>
```

- Verify Obsidian is installed and running:

```bash
xcrun devicectl device info apps --device <device-udid> --bundle-id md.obsidian --include-all-apps --json-output /tmp/obsidian-apps.json --quiet
xcrun devicectl device info processes --device <device-udid> --json-output /tmp/obsidian-processes.json --quiet
```

- Pull crash reports from the device after a failed launch:

```bash
mkdir -p /tmp/idevice-crashreports
idevicecrashreport -u <device-udid> -k -e -f App /tmp/idevice-crashreports
```

- Open the reliable Mac-side tools and relaunch Obsidian in one step:

```bash
npm run ios:debug:open -- --sync --open-xcode
```

- Start Appium with the Homebrew module-resolution fix:

```bash
npm run ios:appium -- --port 4723
```

- Inspect the live Obsidian runtime and confirm the plugin is enabled, loaded, and failure-free:

```bash
npm run ios:inspect:plugin -- --strict
```

- Inspect the Community Plugins settings row and confirm the rendered toggle is enabled:

```bash
npm run ios:inspect:toggle
```

Important iPad nuance:

- on some iPad/Obsidian mobile lanes, the raw checkbox input stays `false` even for enabled rows
- the reliable UI signal is the row's `.checkbox-container.is-enabled` state, which `npm run ios:inspect:toggle` now checks automatically

### Weak or currently unreliable

- raw `ios_webkit_debug_proxy` by itself:
  - useful for target discovery
  - not enough on its own for clean `Runtime.*` automation in this setup
- `idevicesyslog`:
  - useful for process listing with `pidlist`
  - did not yet produce reliable plugin-bootstrap JS signal in this setup
- `devicectl device info files` against Obsidian `appDataContainer`:
  - currently fails with CoreDevice `StreamingAction` errors
- `idevicescreenshot`:
  - still fails because `screenshotr` is unavailable on this iOS `26.3` setup

- Homebrew Appium without the repo wrapper:
  - `appium driver install xcuitest` succeeds
  - default `appium --port 4723` still fails to create an XCUITest session because the driver cannot resolve `appium/driver`
  - `npm run ios:appium -- --port 4723` fixes that by exporting the correct `NODE_PATH`

## Best-In-Class Mac-to-iPad Debug Loop

This is the strongest setup I found after checking Apple, WebKit, Appium, and Obsidian guidance against a real device.

1. Keep the direct-vault loop as the source of truth for latest code:
   - `bash run.sh` for build/watch/sync
   - or `npm run sync:local -- --strict --config ./systemsculpt-sync.ios.json` for one-off pushes
2. Use the helper to reopen the trusted Mac tools:

```bash
npm run ios:debug:open -- --sync --open-xcode
```

3. Use adapter-backed runtime proof when you need a yes/no answer about plugin startup:
   - `npm run ios:inspect:plugin -- --strict`
   - this now verifies the live Obsidian webview on the connected iPad and confirms whether `systemsculpt-ai` is enabled, instantiated, and failure-free
   - `npm run ios:inspect:toggle`
   - this opens `Settings > Community plugins` in the live iPad session and verifies the rendered `SystemSculpt AI` toggle via the mobile UI's `checkbox-container is-enabled` class, which is more reliable in this environment than the raw checkbox input value
4. Use the tools by role:
   - `QuickTime Player`: live mirror and record the iPad screen over USB
   - `Console`: live device logs from the connected iPad
   - `Safari Develop`: Web Inspector for Obsidian if the host app exposes inspectable web content
   - `Xcode > Devices and Simulators`: device logs, crash artifacts, and wireless pairing when we want less cable churn
5. Use Appium only when we specifically want real native UI automation:
   - start it with `npm run ios:appium -- --port 4723`
   - use it for taps, swipes, navigation, and repeatable UI assertions
   - do not treat it as a replacement for Web Inspector, because webview / DOM access still depends on inspectable web content on iOS 16.4+

## Current Appium Status On This Mac

The Appium lane is now partially prepared and accurately characterized.

- `brew install appium` succeeded
- `appium driver install xcuitest` succeeded
- the repo wrapper fixes Homebrew's broken default module resolution
- XCUITest session creation now gets as far as WebDriverAgent build/install

The remaining blocker is Xcode signing for WebDriverAgent on real devices. The exact local failure is:

```text
Signing for "WebDriverAgentRunner" requires a development team.
```

That means true end-to-end Appium control will work only after we set a Development Team for WebDriverAgent in Xcode. Until then, the best practical lane remains:

- direct vault sync
- `devicectl` relaunch / process checks
- QuickTime live mirroring
- Console and Xcode device logs
- Safari Web Inspector whenever Obsidian exposes inspectable web content

## Primary Source Notes

- WebKit says to enable Web Inspector on the device and use the Mac's Develop menu:
  - https://webkit.org/web-inspector/enabling-web-inspector/
- WebKit also documents that app web content must be explicitly marked inspectable on iOS and iPadOS 16.4 and later:
  - https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/
- Apple documents device logs in Xcode's Devices and Simulators window:
  - https://help.apple.com/xcode/mac/current/en.lproj/dev85c64ec79.html
- Apple documents wireless device connectivity in Xcode:
  - https://help.apple.com/xcode/mac/current/en.lproj/devac3261a70.html
- Apple documents QuickTime device capture for a connected iPhone or iPad:
  - https://support.apple.com/guide/quicktime-player/record-a-movie-qtp356b55534/mac
- Apple documents viewing connected-device logs in Console:
  - https://support.apple.com/my-mm/guide/console/cnsl1012/mac
- Appium documents real-device XCUITest setup and notes that hybrid-app webviews on iOS still rely on inspectable web content:
  - https://appium.github.io/appium-xcuitest-driver/9.9/preparation/real-device-config/
  - https://appium.github.io/appium-xcuitest-driver/9.9/guides/hybrid/
- Obsidian's own mobile checklist still applies to the plugin itself:
  - https://docs.obsidian.md/oo/plugin

### Current best-practice iPad QA loop

1. Build locally.
2. Sync into `<your-ios-test-vault>`.
3. Relaunch Obsidian with `devicectl`.
4. Confirm the Obsidian process is alive.
5. If something goes wrong, pull crash reports immediately.
6. Use Safari Develop Web Inspector as the canonical interactive inspection lane.

## Recommendation

If the goal is to get a high-quality iPad lane running quickly, use the **same Apple account** on the iPad for the first pass.

If you want to keep the iPad on a different Apple account, it is still workable, but I would switch the sync method to **Obsidian Sync**, not iCloud Drive.
