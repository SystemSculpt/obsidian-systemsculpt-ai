# Audio & transcription

SystemSculpt AI includes audio recording and transcription tooling (depending on your configuration and license/features).

## Configure

Obsidian Settings → **SystemSculpt AI** → **Audio & Transcription**:

- Microphone selection (where applicable)
- Transcription provider/model selection
- Post-processing options (where applicable)

## Commands and ribbon actions

See: [Commands & hotkeys](commands.md) and [Ribbon icons](ribbon-icons.md).

- **Toggle Audio Recorder** (`Mod`+`R`) — start/stop recording
- **Open Meeting Processor** — open the meeting processing modal
- Ribbon: **Process Meeting Audio** — opens the same meeting processor entrypoint

## Meeting Processor

- The vault picker shows whether each audio file is **Processed**, **Unprocessed**, or **Out of date**.
- Use the **All / Unprocessed / Processed** toggle to quickly narrow the list.
- **Out of date** means the output note exists but is older than the audio file.

## Tips

- Supported audio file types: `mp3`, `wav`, `m4a`, `webm`, `ogg`.
- If transcription fails, first confirm your provider key/endpoint and that the selected model supports audio/transcription on your provider.
- If you’re using a local transcription server, confirm it’s reachable from Obsidian and not blocked by OS/network restrictions.
- Large recordings are automatically chunked during transcription to stay under request size limits (for example, the SystemSculpt API upload limit is ~4MB per request; some custom providers allow ~25MB per request). Chunked transcriptions may take longer to complete.
