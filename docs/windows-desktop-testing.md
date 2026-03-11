# Windows Desktop Testing

Last verified against the desktop parity harness and cross-platform E2E code paths: **2026-03-11**.

## Current Direction

The Windows desktop lane should mirror the serious Mac desktop lane for all
non-Studio features:

- real Obsidian desktop app
- real vault settings and live license
- remote debugging on port `9222` for the shared runtime smoke runner
- live WDIO E2E for deeper desktop UX coverage
- `ffmpeg` plus a speech fixture path for the audio/transcription lane

This is the professional Windows path for parity work. It is not a mocked or
theoretical lane.

## Required Host Tooling

- Node.js `20+`
- npm
- Obsidian desktop
- `ffmpeg` on `PATH`
- one speech fixture source for the live transcription spec:
  - recommended: `espeak-ng` on `PATH`
  - fallback: set `SYSTEMSCULPT_E2E_SHORT_AUDIO_FIXTURE` to a prerecorded short speech clip

Recommended package installs:

```powershell
winget install OpenJS.NodeJS
winget install Obsidian.Obsidian
winget install Gyan.FFmpeg
winget install eSpeakNG.eSpeakNG
```

## Obsidian Launch For Runtime Smoke

Start Obsidian with the Chromium DevTools port exposed:

```powershell
& "$env:LOCALAPPDATA\Obsidian\Obsidian.exe" --remote-debugging-port=9222
```

If Obsidian is installed elsewhere, point the command at the real executable.

## Shared Runtime Smoke Commands

Core parity sweep:

```powershell
npm run runtime:smoke:desktop
```

Extended hosted-service sweep:

```powershell
npm run runtime:smoke:desktop:extended
```

Three-pass regression loop:

```powershell
npm run runtime:smoke:desktop:stress
```

The extended lane covers:

- chat
- hosted filesystem tool loop with approval
- embeddings / similar notes
- audio transcription
- hosted web fetch corpus write
- YouTube transcript

## Live WDIO Desktop Specs

Run one live spec at a time while iterating:

```powershell
node testing/e2e/run.mjs live --spec testing/e2e/specs-live/chat.core.live.e2e.ts
node testing/e2e/run.mjs live --spec testing/e2e/specs-live/embeddings.systemsculpt.core.live.e2e.ts
node testing/e2e/run.mjs live --spec testing/e2e/specs-live/transcription.youtube-audio.live.e2e.ts
```

Run the full live desktop suite:

```powershell
node testing/e2e/run.mjs live
```

## Audio / Transcription Notes

The live transcription spec is now cross-platform, but Windows still needs one
of these:

- `espeak-ng` or `espeak` on `PATH`
- `SYSTEMSCULPT_E2E_SHORT_AUDIO_FIXTURE` pointing at a short prerecorded speech file

Optional overrides:

```powershell
$env:SYSTEMSCULPT_E2E_FFMPEG_BIN = "C:\ffmpeg\bin\ffmpeg.exe"
$env:SYSTEMSCULPT_E2E_TTS_BIN = "C:\Program Files\eSpeak NG\espeak-ng.exe"
$env:SYSTEMSCULPT_E2E_SHORT_AUDIO_FIXTURE = "C:\fixtures\systemsculpt-short.wav"
```

The large-audio path still needs a real meeting-style source file. Override it
with:

```powershell
$env:SYSTEMSCULPT_E2E_SOURCE_AUDIO_PATH = "C:\fixtures\test_meeting.mp3"
```

## Live Env Sourcing

The live runner can still hydrate settings from the real vault plugin data file:

```powershell
$env:SYSTEMSCULPT_E2E_VAULT = "C:\path\to\your\vault"
node testing/e2e/run.mjs live
```

Or point directly at the plugin settings JSON:

```powershell
$env:SYSTEMSCULPT_E2E_SETTINGS_JSON = "C:\path\to\vault\.obsidian\plugins\systemsculpt-ai\data.json"
node testing/e2e/run.mjs live
```

Do not print that file. It contains real secrets.

## Recommended Windows Debug Loop

1. Launch Obsidian with `--remote-debugging-port=9222`.
2. Open the real QA vault.
3. Run `npm run runtime:smoke:desktop:extended`.
4. If a case fails, rerun just that case:

```powershell
node scripts/run-runtime-smoke.mjs --mode desktop --case youtube-transcript
```

5. Reproduce the same area with the matching live WDIO spec if the problem looks desktop-UI-specific.
6. Finish with `npm run runtime:smoke:desktop:stress` before calling the desktop lane green.

## Notes

- This document is the formal Windows parity lane for non-Studio features.
- Studio remains desktop-only, but it is intentionally out of scope for the cross-device parity matrix.
- The shared runtime smoke runner is the fastest truth source because it hits the live hosted contract through the real Obsidian runtime.
