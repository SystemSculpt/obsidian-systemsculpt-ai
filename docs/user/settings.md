# Settings overview

Open Obsidian **Settings** → **SystemSculpt AI**. The settings UI is organized into tabs.

This page is meant to match the plugin’s current settings tabs (see `src/settings/SettingsTabRegistry.ts`).

## Tabs

### Overview & Setup

Provider setup and connectivity:

- Add/choose providers (SystemSculpt, OpenAI-compatible endpoints, OpenRouter, Anthropic adapter, local servers like Ollama/LM Studio)
- Enter API keys / endpoints
- License activation (if applicable)

### Models & Prompts

Model and prompt defaults:

- Default chat model (for new chats)
- Title generation and any post-processing model selection (where supported)
- System prompt presets / custom prompts

### Chat & Templates

Chat experience defaults:

- Chat UI preferences and defaults (where available)
- Default chat tag applied to new chat history notes (frontmatter `tags`)
- Agent Mode behavior and indicators
- Favorite models and quick picks
- Template selection and insertion behavior

### Daily Vault

Daily note workflow:

- Daily note naming/template/directory
- Reminders and review flows
- Streak tracking and status indicators (if enabled)

See: [Daily Vault](daily-vault.md).

### Automations

Workflow automations:

- Enable/disable built-in automations
- Configure destinations (e.g., capture inbox routing)

See: [Automations](automations.md).

### Audio & Transcription

Audio recording and transcription pipeline:

- Microphone preferences
- Transcription provider/model settings
- Post-processing options (where available)

See: [Audio & transcription](audio-transcription.md).

### Image Generation

CanvasFlow (experimental) + Replicate settings:

- Enable/disable **CanvasFlow** enhancements (adds a Run button to the Canvas selection toolbar; also injects prompt controls into CanvasFlow prompt nodes)
- Replicate API key
- Browse/search Replicate models and pick a default model
- Resolve/pin the latest Replicate version id for the default model
- Output folder + optional JSON sidecar metadata
- CanvasFlow prompt node controls (when enabled): curated model-name badge (slug in tooltip), model + version selectors, images count (1-4, writes `ss_image_count`), aspect ratio presets + width/height (writes `ss_image_width` / `ss_image_height`), and generated images are saved using the model name in the filename (instead of the prompt note name)

### Files & Backup

Filesystem paths and data safety:

- Directories for chats/history, recordings, attachments, extractions, etc.
- Backup/restore tools (where available)

### Embeddings & Search

Vector search / Similar Notes configuration:

- Enable embeddings
- Choose provider/model for embeddings
- Exclusions (folders/files) and Obsidian exclusion behavior

See: [Similar Notes](similar-notes.md).

### Data

External data integrations and imports:

- Readwise integration (highlights/books/articles/tweets)
  - Runs scheduled sync in the background when enabled (no need to open Settings)
  - Default sync interval: 60 minutes (configurable)
  - Scheduled sync failures are recorded in Readwise “Sync status” (manual sync shows popups)

### Advanced

Power-user and diagnostics:

- Debugging and maintenance actions
- Update notifications
- Reset/diagnostics/troubleshooting helpers
- Change log panel

## Next steps

- [Commands & hotkeys](commands.md)
- [Agent Mode](agent-mode.md)
- [Troubleshooting](troubleshooting.md)
