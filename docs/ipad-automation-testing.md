# iPad Automation Testing

This is the practical path for automated testing against a cable-connected iPad
in this repo. The key point is that we do not fake native plugin QA with a
simulator-only setup. The real workflow is:

1. macOS sees the physical iPad through Xcode/CoreDevice
2. the latest plugin build is synced into the mobile test vault
3. Obsidian is relaunched on the device from the Mac side
4. the live runtime is inspected through the iOS WebKit adapter
5. the shared native smoke harness runs against that real runtime

## Required tools

- Xcode with `xcrun` and `devicectl`
- `remotedebug_ios_webkit_adapter`
- the repo's iOS helper scripts under `testing/native/device/ios`
- a local `systemsculpt-sync.ios.json` that points at the real iPad vault target

## One clean end-to-end loop

Use this sequence:

```bash
# 1) Confirm the Mac can actually see the cable-connected iPad.
xcrun devicectl list devices

# 2) Sync the latest plugin files and relaunch Obsidian on the device.
npm run test:native:ios:debug:open -- --sync

# 3) Verify the plugin is really loaded in the live iPad runtime.
npm run test:native:ios:inspect:plugin -- --strict

# 4) Run the shared real-device smoke lane.
npm run test:native:ios
```

Useful variations:

```bash
# Also open Xcode while doing the sync/relaunch step.
npm run test:native:ios:debug:open -- --sync --open-xcode

# Inspect the Community Plugins toggle specifically.
npm run test:native:ios:inspect:toggle

# Start the Appium/WebDriverAgent helper lane if you specifically need it.
npm run test:native:ios:appium
```

## What each step proves

- `xcrun devicectl list devices`
  proves the Mac and iPad trust/pairing path is healthy enough for automation
- `test:native:ios:debug:open -- --sync`
  proves the latest local plugin bundle can be pushed into the configured iOS
  vault target and that Obsidian can be relaunched on the real device
- `test:native:ios:inspect:plugin -- --strict`
  proves the live runtime is inspectable and the plugin is actually present,
  enabled, and not obviously broken at load time
- `test:native:ios`
  proves the shared smoke harness can execute against the real iPad runtime

## Failure pattern to recognize quickly

If the very first command, `xcrun devicectl list devices`, hangs instead of
returning promptly, stop there and fix the host/device path first. That usually
means one of these is wrong:

- the iPad is locked
- the cable connection is bad
- the trust prompt was not accepted
- Developer Mode is not enabled
- Xcode has not fully established the device session yet

That is not a Claude-specific problem and not usually a repo-script problem.

## Recovery path when device discovery is unhealthy

1. Disconnect and reconnect the iPad by cable.
2. Unlock it and accept any trust or Developer Mode prompt.
3. Open Xcode and check `Devices and Simulators`.
4. Re-run `xcrun devicectl list devices`.
5. When that works, retry the repo commands in order.

## Notes for the writeup / future Claude use

- Treat simulator-only coverage as insufficient for real Obsidian mobile plugin QA.
- Do not skip the `devicectl` check. It is the fastest truth source for whether
  the cable-connected path is even ready.
- Use the repo's own scripts instead of inventing a second automation path.
- On this iPad/WebKit stack, the inspectable target can appear before the
  Runtime domain is actually ready. The repo now waits for that settle window
  automatically before sending Runtime commands.
- For Community Plugins state, trust the rendered `.checkbox-container.is-enabled`
  class instead of the raw checkbox input value.

## Current wireless status

Wireless is only partially unlocked on this setup.

- Working over Wi-Fi:
  - `xcrun devicectl list devices` shows the iPad with `transportType: localNetwork`
  - the repo can relaunch Obsidian on the iPad over that wireless CoreDevice link
- Not working over Wi-Fi:
  - `remotedebug_ios_webkit_adapter` returns no inspectable targets
  - `ios_webkit_debug_proxy` returns no inspectable targets
  - Safari's `Develop > Inspect Apps and Devices` window opens, but does not enumerate the iPad/app for live runtime inspection

So today the truthful boundary is:

- wireless device control: yes
- wireless app relaunch: yes
- wireless live runtime inspection/smoke: not yet, because the Apple inspection layer is not exposing the app
