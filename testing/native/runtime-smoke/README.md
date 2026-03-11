# Runtime Smoke

`testing/native/runtime-smoke/` is the shared real-runtime smoke harness for desktop and mobile.

Entry point:

```bash
node testing/native/runtime-smoke/run.mjs
```

## Why this exists

The old separate-instance E2E lane was useful, but it was not the best truth source for real plugin behavior anymore.

This harness directly drives the live Obsidian runtime through an inspectable target and verifies real end-to-end behaviors:

- hosted chat
- approval-gated tool execution
- vault reads and writes
- embeddings / similar-notes primitives
- direct transcription
- real recorder -> save -> auto-transcribe
- hosted web fetch
- YouTube transcript retrieval

## Main modes

### Desktop

```bash
npm run test:native:desktop
npm run test:native:desktop:extended
npm run test:native:desktop:stress
```

Requires Obsidian desktop running with:

```bash
--remote-debugging-port=9222
```

### Android

```bash
npm run test:native:android
npm run test:native:android:extended
npm run test:native:android:stress
```

This forwards the Android WebView DevTools socket over `adb`.

### iOS

```bash
npm run test:native:ios
```

This uses the plugged-in iPhone/iPad plus the RemoteDebug iOS WebKit adapter.
The harness will auto-start the adapter when needed, reload the synced plugin
before the smoke pass, and then drive the real Obsidian runtime through the same
shared cases as desktop and Android.

## Case profiles

- default / `all`
  - `chat-exact`
  - `file-read`
  - `file-write`
  - `embeddings`
  - `transcribe`
  - `record-transcribe`
  - `web-fetch`
- `extended`
  - everything above plus `youtube-transcript`

## Useful flags

```bash
--case <name>
--repeat <n>
--pause-ms <n>
--json-output <path>
--fixture-dir <vault-relative-path>
--transcribe-audio-path <vault-relative-path>
--record-audio-path <vault-relative-path>
```

Examples:

```bash
npm run test:native:desktop -- --case file-write
npm run test:native:android -- --case web-fetch
node testing/native/runtime-smoke/run.mjs --mode android --case record-transcribe --record-audio-path "SystemSculpt/QA/CrossPlatform-20260311/cross-platform-audio.m4a"
node testing/native/runtime-smoke/run.mjs --mode desktop --case extended --repeat 3 --pause-ms 2000
```

## Architecture

- `cli.mjs`
  - argument parsing and help
- `runtime.mjs`
  - desktop/android/json target connection
  - iOS adapter bootstrapping and mode-aware evaluation transport
- `cases.mjs`
  - smoke-case expressions and assertions
  - desktop uses a fresh chat leaf per case
  - mobile reuses the active smoke leaf when needed so the mobile workspace does not lose its tab group
  - approval-gated chat completion keys off stable final runtime state, not only the send promise
  - embeddings waits for the manager's background timers and mutex work to go idle before asserting
  - recorder smoke feeds deterministic vault audio through the real recorder path, then waits for the saved recording and transcript artifacts
- `fixtures.mjs`
  - loads the repo-owned smoke fixture bundle
  - seeds markdown and audio fixtures directly into the live vault before each run
- `constants.mjs`
  - defaults and case lists
- `run.mjs`
  - orchestration entrypoint
  - reloads the live plugin before smoke so the inspected runtime matches the synced bundle
  - emits per-case timing so slow live steps are visible in regression output
