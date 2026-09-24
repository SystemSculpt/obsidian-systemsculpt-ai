# Settings

Open `Settings -> SystemSculpt AI`.

Source of truth: `src/settings/SettingsTabRegistry.ts`.

## Tab list

| Tab label | What it covers |
| --- | --- |
| `Account` | License activation, credits and usage access, billing details, and SystemSculpt docs/support links |
| `Chat` | Execution backend, native Codex model/reasoning/speed on desktop, display defaults, accessibility behavior, and history tags |
| `Workflow` | Recording preferences, Audio Processor output, transcription output, and post-processing controls |
| `Knowledge` | Embeddings, Similar Notes, exclusions, and processing status |
| `Workspace` | Directory paths, workspace diagnostics, automatic backups, and restore workflow |
| `Studio` | Studio project storage, run retention, and generated-artifact retention |
| `Advanced` | Quick actions, reset defaults, diagnostics recording (off by default), and diagnostics tools |

## Notes

- The top-level settings tabs are `Account`, `Chat`, `Workflow`, `Knowledge`, `Workspace`, `Studio`, and `Advanced`.
- `Default output` under Workflow selects the Audio Processor preset used when the modal opens. You can still choose a different preset for one new job.
- Choose **SystemSculpt API** or **On-machine Codex** for new desktop chats and Studio text generation. Saved chats retain their backend. Codex permission settings remain native to Codex. Hosted media features continue to use SystemSculpt.
- Some sections are conditionally visible based on current settings.
