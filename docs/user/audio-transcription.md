# Audio and transcription

SystemSculpt supports in-app recording plus transcription workflows.

## Configure

Open `Settings -> SystemSculpt AI -> Audio & Transcription`.

Recording controls include:

- Preferred microphone
- Auto-transcribe recordings
- Auto-paste transcription
- Keep recordings after transcription
- Clean output only
- Auto-submit after transcription
- Post-processing toggle

Transcription controls include:

- Provider selection (`SystemSculpt API` or `Custom`)
- Optional auto audio format conversion (advanced/desktop path)
- Custom endpoint/API key/model fields (advanced mode)
- Provider presets for custom mode (`Groq`, `OpenAI`, `Local`)

## Commands and ribbon

- `Toggle Audio Recorder` (`Mod+R`)
- `Open Meeting Processor`
- Ribbon: `Process Meeting Audio`

## Supported recording/transcription extensions

- `wav`, `m4a`, `webm`, `ogg`, `mp3`

## Pipeline behavior notes

- Desktop + SystemSculpt provider uses a server-side jobs pipeline (large-file capable).
- Mobile/provider-specific direct uploads have stricter request-size constraints.
- Custom-provider path uses direct upload and chunks audio when required.

## If transcription fails

1. Verify provider credentials and endpoint.
2. Verify selected model supports transcription on that provider.
3. For custom local servers, verify local reachability from Obsidian.
