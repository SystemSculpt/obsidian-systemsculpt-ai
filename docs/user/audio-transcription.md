# Audio and transcription

SystemSculpt handles in-app recording and transcription workflows inside Obsidian.

To turn existing audio or a YouTube video into the detailed note, meeting brief, or clean transcript you select, plus a full timestamped companion transcript, use the [Audio Processor](audio-processor.md).

## Configure

Open `Settings > SystemSculpt AI > Workflow`.

Audio and transcription settings now live inside the `Workflow` tab.

### Capture

- **Microphone** chooses the input used for new recordings on this device. Desktop and mobile choices are remembered separately. **Default microphone** follows the device selected by your operating system.
- The settings page reads the available device list when it opens without prompting. It requests access to reveal device names only when you select **Refresh microphone list**; starting a recording still requests the microphone normally.

### After recording

- **Transcribe automatically** starts transcription when a recording ends.
- **Keep source audio** keeps the recording in your vault after transcription succeeds.

### Transcript output

- **Insert transcript at origin** adds the finished transcript only while the same note, editor, and cursor or selection—or the same chat conversation—is still active.
- **Default file format** sets audio-file transcriptions to a Markdown note or SRT subtitles.
- **Clean transcript output** saves only the transcript text, without source details or metadata.
- **Clean up transcript** fixes punctuation, removes filler words, and formats the result. Cleanup instructions appear only while this option is on and save when you leave the field.

### Chat dictation

- **Send after dictation** sends the dictated chat message after the transcript is inserted.

## Recording on a phone or tablet

- The recorder is a compact, non-modal card. You can move between notes, chat, search, and settings while it records.
- Once audio is saved, its transcription can continue while you start another recording.
- SystemSculpt remembers where recording started. It inserts the finished transcript only while that exact note editor and cursor or selection, or chat conversation, is still available. If the origin changed, the transcript stays safely saved as a file and SystemSculpt warns instead of inserting it somewhere else.
- Leaving Obsidian, locking the screen, or another app hiding Obsidian asks the recorder to stop and save the audio captured so far. SystemSculpt does not support background recording because mobile operating systems can suspend Obsidian without warning—and may suspend it before that save finishes.
- A newly saved background capture is not intentionally sent for transcription while Obsidian reports itself hidden. A managed job that already started may continue on the SystemSculpt service; Obsidian resumes or reconciles the local workflow when it returns.
- Keep Obsidian in the foreground for uninterrupted recording. SystemSculpt requests a screen wake lock when the host supports it, but the operating system remains in control.
- For important audio, press **Stop recording** and wait for **Recording saved** before leaving or closing Obsidian. An app switch, screen lock, or force-quit is not a guaranteed save boundary.
- On Obsidian 1.12.3 or later, the recorder writes audio every few seconds to a hidden in-progress file in `.systemsculpt/recordings-in-progress`. Obsidian Sync skips that folder, so it does not upload the growing file while you record. When you stop, the finished recording moves to your recordings folder, with a numbered name if that name is taken.
- If Obsidian quits, reloads, or crashes before you stop, the audio up to the last few seconds stays in the in-progress folder. The next launch moves it to your recordings folder, reports it as an interrupted recording, and transcribes it when **Transcribe automatically** is on.
- On Obsidian 1.12.3 or later, one recording can reach 512 MiB, about 12 hours at the requested speech bitrate. Earlier versions keep the whole recording in memory until you stop, so one recording is capped at 64 MiB on desktop and 24 MiB on mobile, roughly 90 and 35 minutes. The actual duration varies by device encoder.
- Transcription has its own size limit: 128 MiB on desktop and 32 MiB on mobile for one source. A longer recording is still saved, but it must be split or processed elsewhere before it can be transcribed.

## Commands

- `Toggle Audio Recorder`
- `Transcribe an audio file`
- `Open audio processor`
- `Process YouTube video`
- `Save audio summary` (with a saved detailed or meeting brief SystemSculpt audio note active)
- `Save audio transcript` (with a saved SystemSculpt audio note active)

## Supported recording/transcription extensions

- `wav`, `m4a`, `mp4`, `webm`, `ogg`, `mp3`, `flac`

Raw `.aac` and `.opus` files are not accepted by the managed transcription runtime. Use an M4A/MP4 or Ogg/WebM container instead.

## Pipeline behavior notes

- Every transcription is admitted through the SystemSculpt account and runs as a managed job.
- The plugin fingerprints and uploads the source file, reports job progress, and commits local output only after the managed result is ready.
- Post-processing, output persistence, optional insertion, and recording retention happen after the managed result is ready.

## If transcription fails

1. Re-run license validation and retry the request.
2. Confirm credits or quota are still available for your SystemSculpt account.
3. Keep the source recording in the vault until the retry completes.
