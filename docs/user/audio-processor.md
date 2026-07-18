# Audio Processor

Audio Processor turns existing audio or a YouTube video into two linked Markdown notes in your vault: a structured audio note and its complete timestamped transcript. The format is automatic, so there are no prompts or audio-summary settings to configure.

## Start processing

- Run `Open audio processor` to choose the **Audio** or **YouTube** input.
- Run `Process YouTube video` to open the YouTube input directly.

For audio, choose a supported file from your vault when that option is available, or upload one from your device. MP3, WAV, M4A, MP4, OGG, WEBM, and FLAC files are accepted. One upload can be up to 1 GB, which is 1,000,000,000 bytes.

For YouTube, paste the full video URL. SystemSculpt retrieves the source and prepares the transcript on the server.

## Server processing

Audio uploads in small parts. Once the upload finishes, or a YouTube job is queued, transcription and summarization continue on the SystemSculpt service. You can close Obsidian and resume later.

**Stop watching** closes the local progress view. It does not stop the server job. Reopen Audio Processor to check work that is still running.

Completed server results are retained for 7 days. Open Obsidian within that window so SystemSculpt can save the finished notes to your vault.

## Automatic output

The audio note is saved under `SystemSculpt/Audio Notes` and includes:

- Source details and attribution
- A concise summary and key points
- Decisions and action items when the source contains them
- Discussion topics, risks or blockers, and open questions when present
- A link to the companion full transcript with timestamps

YouTube citations link to the matching source timestamp. Empty decision or action sections are omitted instead of being invented.

The audio note and transcript are saved together by default and linked to each other. The audio note opens automatically when delivery finishes.

If either local note is moved or missing, open the surviving SystemSculpt audio note and run **Save audio summary** or **Save audio transcript** from the command palette to open or restore that artifact while the completed server result is still available.
