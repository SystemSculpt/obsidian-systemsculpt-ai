# Audio and transcription

SystemSculpt handles in-app recording and transcription workflows inside Obsidian.

## Configure

Open `Settings -> SystemSculpt AI -> Workflow`.

Audio and transcription settings now live inside the `Workflow` tab.

Recording controls include:

- Preferred microphone
- Auto-transcribe recordings
- Auto-paste transcription
- Keep recordings after transcription
- Clean output only
- Auto-submit after transcription
- Post-processing toggle

Transcription controls include:

- SystemSculpt transcription
- Optional auto audio format conversion (advanced/desktop path)
- Default output format (`Markdown` or `SRT`)
- Output format chooser toggle

## Commands and ribbon

- `Toggle Audio Recorder` (`Mod+R`)
- `Open Meeting Processor`
- Ribbon: `Process Meeting Audio`

## Supported recording/transcription extensions

- `wav`, `m4a`, `webm`, `ogg`, `mp3`

## Pipeline behavior notes

- Desktop uses the SystemSculpt jobs pipeline for larger files.
- Mobile/direct upload paths have stricter request-size constraints.

## If transcription fails

1. Re-run license validation and retry the request.
2. Confirm credits or quota are still available for your SystemSculpt account.
3. If you are on desktop, retry once with automatic audio conversion enabled for incompatible source files.
