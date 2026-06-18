# iOS And iPad Native Testing

The iOS lane has two jobs:

1. keep fast mobile regressions out of release candidates with the built-bundle
   mobile contract in normal CI
2. prove the actual App Store Obsidian iOS runtime on a managed real device

The simulator is useful for apps we can build for Simulator. It is not a
truthful replacement for this plugin's final iOS check because Apple's Simulator
does not install App Store apps:
<https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html#//apple_ref/doc/uid/TP40012848-CH3-SW1>

For this repo, "canonical" means layered automation, not a local release laptop
that happens to have an iPad attached.

Canonical tools live here:

- `testing/native/device/ios/open-debug-tools.mjs`
- `testing/native/device/ios/inspect-plugin-state.mjs`
- `testing/native/device/ios/start-appium.mjs`

## What "connected and automated" means here

For this repo, the real iPad/iPhone truth path is:

1. macOS can see the cable-connected device through Xcode/CoreDevice
2. the latest plugin bundle is synced into the mobile test vault
3. Obsidian is relaunched on the iPad from the Mac side
4. the live Obsidian runtime is inspected through the iOS WebKit adapter
5. the shared native smoke harness runs against that real runtime

This is not a simulator-only story. The goal is a real iPad, real vault, real
plugin, and real hosted runtime.

## Canonical release lanes

### Fast mobile contract

```bash
npm run build
npm run test:integration:ci
```

The integration suite loads the shipped `main.js` bundle under an iPad-like
Obsidian runtime and verifies that mobile startup does not activate desktop-only
services. This is the fast CI check. It catches mobile startup breakage before
the real-device lane runs.

### Managed iOS canary

The repo-owned canary workflow is:

```text
.github/workflows/ios-canary.yml
```

It runs on a self-hosted macOS runner labeled:

```text
self-hosted, macOS, ios-canary
```

The canary runner should be a dedicated Mac with one enrolled iPhone or iPad.
Keep the device unlocked, trusted, Developer Mode enabled, and available to
CoreDevice. Store the ignored iOS sync config as the repository secret
`SYSTEMSCULPT_IOS_SYNC_CONFIG_B64`; do not commit `systemsculpt-sync.ios.json`.
Store the hosted smoke license as `SYSTEMSCULPT_E2E_LICENSE_KEY`. The workflow
publishes `ios-canary-release` for push-to-main release gating and
`ios-canary-ad-hoc` for manual or scheduled canary runs. It decodes the sync
config only inside the step that needs it, removes that file with a shell trap,
uploads sanitized JSON diagnostics, and scrubs the canary temp directory at the
end of the job.

The canary runs:

```bash
npm run test:native:ios:canary:preflight
npm run test:native:ios:debug:open -- --sync --skip-open-apps
npm run test:native:ios:inspect:plugin -- --strict
npm run test:native:ios -- --case all --require-hosted-auth --json-output <artifact path>
```

Use the preflight locally on a candidate canary Mac before dispatching the
workflow:

```bash
npm run test:native:ios:canary:preflight
npm --silent run test:native:ios:canary:preflight -- --device "Release iPad" --json
```

After the canary workflow exists on the release commit, check it with:

```bash
npm run check:release:ios-canary
npm run check:release:native -- --only-hosted --github-ref <release-sha>
npm run check:release:native
```

Until the canary runner is provisioned, a release exception must be explicit:

```bash
npm run check:release:native -- --allow-missing-ios-canary "runner not provisioned yet"
```

Do not use that exception as the steady state.

## Main commands

```bash
npm run test:native:ios:debug:open -- --sync --open-xcode
npm run test:native:ios:inspect:plugin -- --strict
npm run test:native:ios:inspect:toggle
npm run test:native:ios
```

## Canonical workflow

1. Sync the plugin into the iCloud-backed or synced test vault.
2. Relaunch Obsidian on the connected device.
3. Confirm the plugin is enabled and failure-free.
4. Run the shared native smoke harness once the Obsidian target is inspectable.

More explicitly, the normal cable-connected loop is:

```bash
# 1) Confirm Xcode/CoreDevice can see the iPad.
xcrun devicectl list devices

# 2) Sync the latest plugin into the configured iOS vault target and relaunch Obsidian.
npm run test:native:ios:debug:open -- --sync

# 3) Inspect the live Obsidian runtime on the iPad.
npm run test:native:ios:inspect:plugin -- --strict

# 4) Run the shared real-device smoke lane.
npm run test:native:ios
```

If you want the Community Plugins toggle state specifically:

```bash
npm run test:native:ios:inspect:toggle
```

If you need the Apple-side debugging surfaces open as part of setup:

```bash
npm run test:native:ios:debug:open -- --sync --open-xcode
```

What the shared smoke now does for you:

- auto-starts the WebKit adapter when `npm run test:native:ios` runs
- waits for the iOS WebKit target to settle before sending Runtime commands
- reloads `systemsculpt-ai` before smoke so the live instance matches the synced files
- seeds the canonical runtime fixtures directly into the device vault before the cases run
- verifies the shared mobile hosted chat, Pi tool loop, embeddings, transcription, web fetch, and YouTube transcript cases

## Important inspection rule

For the mobile Community Plugins toggle, trust the rendered container state such as:

```text
.checkbox-container.is-enabled
```

not the raw checkbox input value.

## Host prerequisites

Before blaming the repo automation, verify the Mac and iPad are in a good state:

- Xcode is installed and selected: `xcode-select -p`
- the iPad is connected by cable and unlocked
- the "Trust This Computer" prompt has been accepted on the iPad
- Developer Mode is enabled on the iPad
- Obsidian is already installed on the device
- `remotedebug_ios_webkit_adapter` exists on the Mac

## Fast troubleshooting

If `xcrun devicectl list devices` hangs instead of returning quickly, treat that
as a host/device problem first, not a repo-script problem. In practice, the fix
path is usually:

1. Unplug and reconnect the iPad by cable.
2. Unlock the iPad and dismiss any trust or Developer Mode prompts.
3. Open Xcode once, then check `Window > Devices and Simulators`.
4. Re-run `xcrun devicectl list devices`.
5. Only after that succeeds, retry `npm run test:native:ios:debug:open -- --sync`.

If inspection cannot find an Obsidian target, make sure Obsidian is open on the
iPad and the app has finished loading the target vault before retrying.

## Wireless reality check

This setup can currently reach the iPad over `localNetwork` and relaunch
Obsidian wirelessly through `devicectl`, but full wireless runtime inspection is
still blocked unless Apple's inspection surfaces actually expose the app.

If all of these are true:

- `devicectl list devices` shows `transportType: localNetwork`
- Obsidian can be relaunched wirelessly
- `remotedebug_ios_webkit_adapter` and `ios_webkit_debug_proxy` both show no targets
- Safari's `Develop > Inspect Apps and Devices` window still does not list the iPad/app

then the remaining blocker is outside this repo. In that state, cable-connected
inspection is still the truthful path for full plugin runtime smoke.

## Cloud device provider feasibility

Cloud device farms are normal for owned mobile apps, but they are not an
automatic fit for this plugin because the app under test is Obsidian from the
App Store plus an injected vault/plugin state.

- Firebase Test Lab for iOS runs XCTest/XCUITest and game-loop tests against an
  app/test package you prepare:
  <https://firebase.google.com/docs/test-lab/ios/get-started>
- BrowserStack App Automate runs Appium tests on real devices and commonly
  selects an uploaded app with the `app` capability:
  <https://www.browserstack.com/docs/app-automate/appium>
- Sauce Labs real-device Appium testing expects a mobile app file such as an
  `.ipa` for native app testing:
  <https://docs.saucelabs.com/mobile-apps/automated-testing/appium/real-devices/>
- AWS Device Farm supports iOS Appium, XCTest, and XCTest UI, and can also
  expose an Appium endpoint for remote-access sessions:
  <https://docs.aws.amazon.com/devicefarm/latest/developerguide/test-types-ios-tests.html>

Use a cloud provider only after a spike proves it can install or access Obsidian,
inject the test vault/plugin, expose the WebKit/Appium inspection surface we
need, and run the same smoke cases without manual setup. Until then, the
self-hosted canary is the lower-risk canonical lane.
