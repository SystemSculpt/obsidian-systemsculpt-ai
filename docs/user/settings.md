# Settings

Open `Settings -> SystemSculpt AI`.

Source of truth: `src/settings/SettingsTabRegistry.ts`.

## Tab list

| Tab label | What it covers |
| --- | --- |
| `Overview & Setup` | Account/license, credits and usage access, provider setup, API keys, provider connection helpers |
| `Models & Prompts` | Chat/title/post-processing model defaults, prompt selection, prompt files |
| `Chat & Templates` | Chat defaults, default prompt/tag/font preferences, favorites, template insertion |
| `Daily Vault` | Daily note structure, templates, reminders, streak/analytics toggles, daily actions |
| `Automations` | Workflow automation cards, capture/destination folders, enable/disable automation rules |
| `Audio & Transcription` | Recording preferences, transcription provider, auto actions, custom endpoint settings |
| `Image Generation` | CanvasFlow toggle, Replicate API key/model/version/output options |
| `Files & Backup` | Directory paths, directory diagnostics, automatic backups, restore workflow |
| `Embeddings & Search` | Embeddings enable/provider config, processing status, exclusions, clear-data action |
| `Data` | Readwise integration, token validation, import options, sync schedule and status |
| `Advanced` | Debug mode, update notifications, reset defaults, diagnostics snapshot and folder |

## Standard vs Advanced mode

Some controls appear only in Advanced mode, including:

- Custom transcription provider configuration
- Extra model-list preference controls
- Additional power-user behavior toggles

## Notes

- Some sections are conditionally visible based on current settings.
- `Daily Vault` settings are managed by `DailySettingsService` and rendered through `DailyTabContent`.
