# Audio Processor

Audio Processor turns existing audio or a YouTube video into the output you choose, directly in your vault. Pick a detailed note, a concise meeting brief, or a clean transcript before processing.

## Start processing

- Run `Open audio processor` to choose the **Audio** or **YouTube** input.
- Run `Process YouTube video` to open the YouTube input directly.

For audio, choose a supported file from your vault when that option is available, or upload one from your device. MP3, WAV, M4A, MP4, OGG, WEBM, and FLAC files are accepted. One upload can be up to 1 GB, which is 1,000,000,000 bytes.

For YouTube, paste the full video URL. SystemSculpt retrieves the source and prepares the transcript on the server.

## Choose the output

The same output choices are available for audio and YouTube:

- **Detailed note** includes a summary, key points, decisions, action items, open questions, and a linked timestamped transcript. This is the default.
- **Meeting brief** keeps the main note concise with the outcome, summary, decisions, action items, and open questions that are present.
- **Clean transcript** makes the main note plain readable paragraphs without timestamps or speaker labels.

Every preset still delivers a primary note and a companion canonical transcript. The companion transcript remains timestamped and recoverable.

Your choice applies to the new job you are starting. To change which choice is selected when Audio Processor opens, go to **Settings -> SystemSculpt AI -> Workflow -> Audio output**.

## Server processing

Audio uploads in small parts. Once the upload finishes, or a YouTube job is queued, processing continues on the SystemSculpt service. You can close Obsidian and resume later.

**Stop watching** closes the local progress view. It does not stop the server job. Reopen Audio Processor to check work that is still running.

Completed server results are retained for 7 days. Open Obsidian within that window so SystemSculpt can save the finished notes to your vault.

## Detailed note output

Audio Processor output is saved under `SystemSculpt/Audio Notes`. The detailed note includes:

- Source details and attribution
- A concise summary and key points
- Decisions and action items when the source contains them
- Discussion topics, risks or blockers, and open questions when present
- A link to the companion full transcript with timestamps

YouTube citations link to the matching source timestamp. Empty decision or action sections are omitted instead of being invented.

The finished output opens automatically when delivery finishes.

From any saved Audio Processor note, run **Save audio transcript** to open or restore the linked transcript while the completed server result is still available. For detailed and meeting brief outputs, run **Save audio summary** to create or open a summary-only third note. Clean transcript outputs do not offer that command because they do not include a separate summary.
