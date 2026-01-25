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

- Data import settings (e.g., Readwise highlights if enabled)
- Sync options (where available)

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

