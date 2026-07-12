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

- Optional automatic audio format conversion
- Default output format (`Markdown` or `SRT`)
- Output format chooser toggle

## Commands and ribbon

- `Toggle Audio Recorder` (`Mod+R`)
- `Transcribe an audio file`
- Ribbon: `Process Meeting Audio`

## Supported recording/transcription extensions

- `wav`, `m4a`, `webm`, `ogg`, `mp3`

## Pipeline behavior notes

- Every transcription is admitted through the SystemSculpt account and runs as a managed job.
- The plugin fingerprints and uploads the source file, reports job progress, and can recover acknowledged work before committing the local output.
- Post-processing, output persistence, optional insertion, and recording retention happen after the managed result is ready.

## If transcription fails

1. Re-run license validation and retry the request.
2. Confirm credits or quota are still available for your SystemSculpt account.
3. Keep the source recording in the vault until the retry completes.
