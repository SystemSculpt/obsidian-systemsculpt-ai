# Settings

Open `Settings -> SystemSculpt AI`.

Source of truth: `src/settings/SettingsTabRegistry.ts`.

## Tab list

| Tab label | What it covers |
| --- | --- |
| `Account` | License activation, credits and usage access, billing details, and SystemSculpt docs/support links |
| `Chat` | Chat preferences, display defaults, accessibility behavior, and history tags while SystemSculpt handles chat behavior automatically |
| `Workflow` | Recording preferences, transcription output, and post-processing controls |
| `Knowledge` | Embeddings, Similar Notes, exclusions, and processing status |
| `Readwise` | Readwise connection, imports, sync options, and manual sync actions |
| `Workspace` | Directory paths, workspace diagnostics, automatic backups, and restore workflow |
| `Studio` | Desktop-only Studio workspace, project storage, and SystemSculpt image generation options |
| `Advanced` | Quick actions, update notifications, reset defaults, and diagnostics tools |

## Notes

- The top-level settings tabs are `Account`, `Chat`, `Workflow`, `Knowledge`, `Readwise`, `Workspace`, `Studio`, and `Advanced`.
- SystemSculpt handles chat setup and processing automatically, so the settings UI stays focused on your preferences and workspace controls.
- Some sections are conditionally visible based on current settings.
