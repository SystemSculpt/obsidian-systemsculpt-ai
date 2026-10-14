# Settings

Open `Settings -> SystemSculpt AI`.

Source of truth: `src/settings/SettingsTabRegistry.ts`.

## Tab list

| Tab label | What it covers |
| --- | --- |
| `Account` | License activation, credits and usage access, billing details, and SystemSculpt docs/support links |
| `Chat` | Execution backend, native Codex model/reasoning/speed and Claude Code model/permissions on desktop, display defaults, accessibility behavior, and history tags |
| `Workflow` | Recording preferences, Audio Processor output, transcription output, and post-processing controls |
| `Knowledge` | Embeddings, Similar Notes, exclusions, and processing status |
| `Workspace` | Directory paths, iOS captures (once shown), workspace diagnostics, automatic backups, and restore workflow |
| `Studio` | Studio project storage, run retention, and generated-artifact retention |
| `Advanced` | Quick actions, reset defaults, diagnostics recording (off by default), and diagnostics tools |

## Notes

- The top-level settings tabs are `Account`, `Chat`, `Workflow`, `Knowledge`, `Workspace`, `Studio`, and `Advanced`.
- `Default output` under Workflow selects the Audio Processor preset used when the modal opens. You can still choose a different preset for one new job.
- Choose **SystemSculpt API**, **On-machine Codex** or **On-machine Claude Code** for new desktop chats and Studio text generation. Saved chats retain their backend. Codex permission settings remain native to Codex. Claude Code asks before edits unless you choose another of its permission modes. Hosted media features continue to use SystemSculpt.
- **iOS captures** appears under Workspace only after your SystemSculpt account has signed in to the SystemSculpt iOS app; until then the plugin shows no iOS settings and makes no capture requests. Once it appears, a one-time notice says where captures go, and it saves notes and voice memos from the app into the vault while you are signed in. It checks when Obsidian opens, when it regains focus and every five minutes, on desktop and mobile. Each capture becomes a new note in `SystemSculpt/Inbox` (configurable) with `source`, `captured`, `tags` and `capture_id` frontmatter; existing notes are never overwritten. Turn on **Ask before saving iOS captures** to confirm each batch, or turn the inbox off. The command **Save iOS captures now** checks immediately.
- Some sections are conditionally visible based on current settings.
