# iOS And iPad Native Testing

The iOS lane uses a real device plus WebKit inspection rather than a fake standalone test app.
There is not a better truthful simulator path for real Obsidian plugin QA than this
physical-device lane; the right improvement is more automation around the real device,
not pretending the simulator covers native vault/plugin behavior.

Canonical tools live here:

- `testing/native/device/ios/open-debug-tools.mjs`
- `testing/native/device/ios/inspect-plugin-state.mjs`
- `testing/native/device/ios/start-appium.mjs`

## What "connected and automated" means here

For this repo, the truthful iPad path is:

1. macOS can see the cable-connected device through Xcode/CoreDevice
2. the latest plugin bundle is synced into the mobile test vault
3. Obsidian is relaunched on the iPad from the Mac side
4. the live Obsidian runtime is inspected through the iOS WebKit adapter
5. the shared native smoke harness runs against that real runtime

This is not a simulator-only story. The goal is a real iPad, real vault, real
plugin, and real hosted runtime.

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
