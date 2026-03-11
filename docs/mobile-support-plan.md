# Mobile Support Plan

Last verified against code and local dev environment: **2026-03-11**.

## Goal

Bring `obsidian-systemsculpt-ai` to a clearly supported mobile state on Android and iOS without diluting the new desktop Pi/Studio architecture.

This plan recommends a hard product split:

- Desktop remains the canonical **Pi + Studio** lane.
- Mobile gets a canonical **network-native plugin** lane.
- We do **not** try to port local Pi runtime, terminal sidecars, or Studio execution to phones/tablets.

## Executive Summary

The repo already contains real mobile-aware infrastructure:

- `PlatformContext` forces `requestUrl` and disables streaming on mobile in `src/services/PlatformContext.ts`.
- Mobile detection is centralized in `src/utils/MobileDetection.ts`.
- There is existing native mobile verification through the Android emulator and the shared runtime smoke harness.
- Several user flows already degrade intentionally on mobile instead of crashing.
- Chat now defaults to the hosted `systemsculpt` backend on both desktop and mobile in `src/views/chatview/ChatView.ts`.
- The repo now has a native runtime smoke runner for live desktop and Android verification:
  - `testing/native/runtime-smoke/run.mjs`
  - `npm run test:native:desktop`
  - `npm run test:native:android`

The main risk is no longer a desktop/mobile backend split. The current risk is
cross-device QA drift:

- Desktop and mobile now share the hosted SystemSculpt chat path: `src/views/chatview/ChatView.ts`.
- Android has a proven emulator + WebView smoke lane.
- iPad still depends on the physical device being foregrounded and inspectable from the Mac.
- A large amount of desktop-only Node/Electron code is still imported from mobile-shipped source files.

The right move is to keep mobile on the same hosted contract while continuing to
trim desktop-only runtime surfaces out of the mobile-shipped path.

## Current Codebase Facts

### Already mobile-aware

- Transport abstraction exists and already prefers `requestUrl` on mobile:
  - `src/services/PlatformContext.ts`
  - `src/services/PlatformRequestClient.ts`
- Chat UI already has some mobile-specific behavior:
  - `src/views/chatview/ui/MessageToolbar.ts`
  - `src/components/FloatingWidget.ts`
  - `src/components/QuickEditWidget.ts`
  - `src/modals/QuickFileEditModal.ts`
- Some heavy workflows already branch on mobile:
  - `src/services/DocumentProcessingService.ts`
  - `src/services/TranscriptionService.ts`
- Mobile verification already exists in the app and tests:
  - `src/main.ts`
  - `testing/native/runtime-smoke/run.mjs`
  - `testing/native/device/android/README.md`

### Explicitly desktop-only today

- Pi runtime, local Pi auth, and local Pi execution:
  - `src/services/pi/PiCli.ts`
  - `src/services/pi/PiProcessRuntime.ts`
  - `src/services/pi-native/PiTextAuth.ts`
  - `src/services/pi-native/PiTextRuntime.ts`
- Studio and terminal sidecars:
  - `src/views/studio/SystemSculptStudioView.ts`
  - `src/studio/StudioRuntime.ts`
  - `src/studio/StudioSandboxRunner.ts`
  - `src/studio/StudioTerminalSessionManager.ts`
  - `src/studio/terminal/StudioTerminalSidecarClient.ts`
- Desktop shell / absolute-path utilities:
  - `src/main.ts`
  - `src/core/plugin/commands.ts`

### Structural problems blocking clean mobile support

- Chat backend selection is unified at the root:
  - desktop => `"systemsculpt"`
  - non-desktop => `"systemsculpt"`
  - file: `src/views/chatview/ChatView.ts`
- The remaining problem is stale assumptions in docs/tests that still talk about a
  mobile `"legacy"` lane.
- Many mobile-shipped source files still import Node builtins or desktop runtime modules at top level, including:
  - `src/views/chatview/ChatView.ts`
  - `src/services/pi/PiRuntimeBootstrap.ts`
  - `src/services/pi/PiSdk.ts`
  - `src/services/pi/PiCli.ts`
  - `src/services/pi/PiProcessRuntime.ts`
  - `src/studio/StudioRuntime.ts`
  - `src/studio/StudioSandboxRunner.ts`
  - `src/studio/terminal/StudioTerminalSidecarClient.ts`

## Official Platform Constraints

### Obsidian plugin guidance

Official Obsidian docs for non-desktop-only plugins say:

- Avoid top-level imports from Node.js modules or Electron in plugins that ship on mobile.
- Use `requestUrl` rather than `fetch` when targeting mobile.
- Avoid regex lookbehind if supporting iOS versions earlier than 16.4.

Relevant docs:

- Plugin self-critique checklist:
  - https://docs.obsidian.md/Plugins/Releasing/Plugin+self-critique+checklist
- Plugin guidelines:
  - https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Avoid+top-level+imports+from+Node.js+modules
  - https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Use+requestUrl+rather+than+fetch
  - https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Avoid+lookbehind+in+regular+expressions

Repo implication:

- Our current mobile story is directionally correct on transport, but not yet clean on loadability or syntax safety.

### Android tooling

Official Android docs confirm we can support both emulator and USB-debug device flows locally:

- Emulator workflow:
  - https://developer.android.com/studio/run/emulator
- Run on a hardware device:
  - https://developer.android.com/studio/run/device
- Debug WebViews with Chrome DevTools:
  - https://developer.android.com/guide/webapps/debugging

Repo implication:

- Android is the easiest path for a true local device loop from this Mac once `adb` / Android Studio are installed.

### Apple tooling

Official Apple / WebKit docs confirm:

- Web Inspector can inspect web content on iOS devices and simulators:
  - https://webkit.org/web-inspector/enabling-web-inspector/
- TestFlight can run iPhone/iPad apps on Apple silicon Macs when the app publisher allows it:
  - https://developer.apple.com/testflight/

Repo implication:

- We already have Xcode and iOS simulators installed, but that does not by itself guarantee a runnable Obsidian iOS test lane.
- Treat a real iPhone/iPad as the canonical iOS validation path unless we confirm a usable simulator or Apple-silicon-distributed Obsidian build.
- In this repo's real-device lane, adapter-backed inspection on the connected iPad is now strong enough to verify both plugin-manager state and the rendered `Community plugins` toggle state from the Mac. One nuance we verified live: the mobile UI's reliable toggle signal is the `.checkbox-container.is-enabled` class, not the raw checkbox input value.

## Recommended Product Scope

### Mobile v1: explicitly supported

Support these as the canonical mobile surface:

- Chat through SystemSculpt.
- Account setup and validation flows.
- Context attachment and vault-aware operations that only rely on Obsidian APIs plus HTTP.
- Embeddings and Similar Notes, subject to performance validation on real devices.
- Recorder / transcription flows that already use mobile-safe transport and degraded behavior.
- Document upload and processing flows that already avoid desktop-only job uploads on mobile.
- Quick Edit via modal-style UX instead of floating desktop widgets.

### Mobile v1: explicitly unsupported

Keep these desktop-only with clear UX copy:

- Local Pi runtime install, auth, and execution.
- SystemSculpt Studio.
- Terminal sidecars and node-pty surfaces.
- Desktop-only filesystem affordances:
  - reveal in Finder
  - copy absolute vault path
  - shell launches
  - local runtime bootstraps

### Important policy

Do not market mobile as “full parity.” Market it as:

- supported for network-native SystemSculpt workflows
- intentionally desktop-only for Pi + Studio workflows

## Recommended Architecture

### 1. Keep hosted chat as the single cross-device contract

Current state:

- `ChatView` now defaults to `"systemsculpt"` across platforms.

Recommended change:

- Keep chat storage, message rendering, approvals, and UI shared.
- Keep mobile on the hosted SystemSculpt path instead of introducing a second execution lane.
- Remove or rewrite stale docs/tests that still refer to a mobile legacy backend.

Why:

- This preserves the thin-client contract we just proved live on desktop and Android.
- It avoids reintroducing compatibility drift through outdated copy or old test assumptions.

### 2. Add a single `PlatformCapabilities` contract

Create one capability registry that answers questions like:

- `canUseLocalPi`
- `canUseStudio`
- `canUseTerminal`
- `canUseAbsolutePaths`
- `canUseDesktopShell`
- `canStreamResponses`
- `shouldUseRequestUrl`

Then route commands, settings sections, notices, and feature visibility through that contract instead of scattering `Platform.isDesktopApp` checks across the repo.

Why:

- Prevents compatibility sludge.
- Makes docs and tests align with one source of truth.

### 3. Make the mobile bundle load-safe

Before feature work, fix loadability:

- Move desktop-only Node/Electron imports behind dynamic imports or desktop-only modules that are never loaded on mobile.
- Split Pi and Studio entrypoints so mobile never resolves them during plugin startup.
- Add a repo check that fails if mobile-shipped modules use top-level Node/Electron imports.

Why:

- This is the most likely “it installs but is brittle/broken on mobile” class of failure.

### 4. Promote transport discipline to a hard rule

Current repo has good patterns but not total consistency.

Recommended rule:

- All mobile-reachable network code must go through `PlatformContext` or `PlatformRequestClient`.
- Raw `fetch` is only allowed in code proven desktop-only.

Also add a static check for mobile-reachable `fetch(` usage.

### 5. Treat mobile diagnostics as a product feature

Real-device debugging will be weaker than desktop.

Add a mobile diagnostics surface that captures:

- platform/device info
- capability flags
- selected transport
- last request endpoint and status
- last error stack/message
- plugin version
- Obsidian version

Expose it through a command and a copy/export action.

Why:

- This reduces dependence on fragile remote-inspection assumptions.

## Testing Strategy

Use a native three-lane stack.

### Lane A: fast local emulation on desktop

Use this for every PR:

- `npm run check:plugin:fast`
- `npm run test:native:android:extended`
- targeted unit tests around:
  - `PlatformContext`
  - `MobileDetection`
  - transport selection
  - mobile-specific UI branches

This lane is already available and should expand to include:

- setup / login happy path
- chat send / receive
- context attachment
- quick edit modal
- transcription happy path
- account setup

### Lane B: Android true-device / emulator loop

Recommended local setup:

1. Install Android Studio and Platform Tools.
2. Create a dedicated Android mobile test vault in shared device storage.
3. Add a repo script to push plugin assets into:
   - `<vault>/.obsidian/plugins/systemsculpt-ai`
4. Add a log collection helper:
   - `adb logcat`
5. Attempt Chrome DevTools WebView inspection when available.

Recommended repo additions:

- `testing/native/device/android/sync-plugin.mjs`
- `testing/native/device/android/logcat.mjs`
- `testing/native/device/android/open-debug-tools.mjs`
- `systemsculpt-sync.android.example.json`
- `testing/native/device/android/README.md`

Suggested command shape:

```bash
npm run build
npm run test:native:android:sync -- --serial <device> --vault-path <shared-vault-path>
```

This should be deterministic and fast enough for repeated QA.

### Lane C: iOS true-device loop

Recommended canonical path:

1. Use a dedicated iPhone/iPad test vault backed by iCloud Drive or Obsidian Sync.
2. Sync plugin artifacts from this Mac into the same vault folder on macOS.
3. Reopen or reload the plugin on the iOS device.
4. Use Safari Web Inspector if Obsidian’s web content is inspectable on that device/build.

Validated local additions from this repo's current iPad lane:

- direct sync into `<your-ios-test-vault>/.obsidian/plugins/systemsculpt-ai` is working
- `xcrun devicectl` can launch Obsidian on the device and confirm process state
- `idevicecrashreport` can pull real Obsidian crash logs after launch failures
- `remotedebug_ios_webkit_adapter` can now bridge the live Obsidian webview well enough for `Runtime.evaluate` plugin-state proof from the Mac

Current limitations in this environment:

- raw `ios_webkit_debug_proxy` alone is still not enough for clean runtime proof
- `devicectl` app-container file listing is not yet dependable for Obsidian
- `idevicescreenshot` still fails on this iOS `26.3` setup

Important:

- Do not depend on iOS Simulator as the main validation lane unless we confirm a workable Obsidian build path there.
- Treat simulator availability in this environment as helpful infrastructure, not proof of a runnable Obsidian mobile loop.

Recommended repo additions:

- `docs/dev/mobile-testing.md` with the exact iCloud/Sync vault path workflow
- optional packaging helper for manual import / zip handoff

## Current Local Dev Environment

Verified on this Mac:

- `Obsidian.app` is installed.
- `Xcode 26.2` is installed.
- iOS simulators are available through `xcrun simctl`.
- Android Studio is installed in `~/Applications/Android Studio.app`.
- Android SDK tooling is installed and available through:
  - `adb`
  - `sdkmanager`
  - `avdmanager`
  - `emulator`
- The canonical Android SDK root is `~/Library/Android/sdk`.
- A proven Android emulator now exists on this Mac:
  - `SystemSculpt_Pixel_9_API_36_1`
- The Android repo helper lane now exists:
  - `npm run android:sync`
  - `npm run android:debug:open`
  - `npm run android:logcat`
- The dedicated Android QA vault path proved in the emulator is:
  - `/sdcard/Documents/SystemSculpt Android QA`
- Obsidian remote debugging on `127.0.0.1:9222` was not active during this audit.

Practical conclusion:

- We can start improving mobile support immediately with emulation and unit coverage.
- We can stand up a true iOS device loop now if we use a real device plus shared vault sync.
- We can automate build, sync, relaunch, running-process verification, and crash harvesting on iOS today.
- We still need Safari Develop for the highest-quality live JS inspection on iOS.
- We now have a first-class Android emulator loop from this machine, including plugin sync, app relaunch, log capture, and WebView inspection.

## Proposed Delivery Phases

### Phase 0: lock the contract

- Decide and publish the mobile support matrix.
- Rename the conceptual mobile backend from `"legacy"` to `"remote"` in the planning language, even if code rename happens in Phase 2.
- Write down which commands/settings are desktop-only vs mobile-supported.

Exit criteria:

- No ambiguity about supported mobile scope.

### Phase 1: loadability and capability cleanup

- Add `PlatformCapabilities`.
- Split desktop-only modules behind dynamic imports.
- Add a mobile compatibility check for:
  - top-level Node/Electron imports
  - mobile-reachable `fetch`
  - regex lookbehind if we still claim pre-iOS-16.4 support

Exit criteria:

- Plugin can load on mobile without resolving desktop runtime modules.

### Phase 2: first-class mobile execution backend

- Introduce shared chat execution contracts.
- Move mobile off the `"legacy"` concept and onto a supported `remote` backend.
- Keep desktop Pi lane intact.

Exit criteria:

- Mobile is no longer architecturally described as legacy.

### Phase 3: UX and settings pass

- Hide or relabel desktop-only settings on mobile.
- Tighten notices and empty states.
- Make unsupported commands fail clearly and intentionally.

Exit criteria:

- Mobile UI feels intentionally supported rather than partially broken.

### Phase 4: testing infrastructure

- Expand emulation suite.
- Add Android sync/log helpers.
- Document iOS real-device loop.
- Add a release-gate smoke matrix for:
  - desktop
  - emulated mobile
  - Android device/emulator
  - iPhone/iPad device

Exit criteria:

- Mobile support can be validated repeatedly from the dev environment.

## Recommended Immediate Next Actions

1. Implement `PlatformCapabilities` and use it to centralize the mobile/desktop product contract.
2. Add a mobile compatibility checker that fails on top-level Node/Electron imports in mobile-shipped modules.
3. Replace the mobile `"legacy"` framing with a planned `remote` backend cutover.
4. Expand WDIO emulation from recorder-only to chat/setup/quick-edit/transcription.
5. Stand up one real-device loop first:
   - iOS first if we have an available iPhone/iPad and can use iCloud-based vault sync
   - Android first if we prefer emulator determinism and are willing to install Android Studio now

## Recommendation

The best implementation path is:

- keep Pi + Studio hard-desktop
- make mobile explicitly network-native
- fix bundle/loadability before feature parity work
- promote mobile from “legacy” to “first-class remote backend”
- use desktop emulation for fast iteration and real devices for final proof

That gives us a clean architecture, a shippable scope, and a realistic local testing loop from this Mac.
