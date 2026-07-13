# SystemSculpt AI docs

Last verified against code: **2026-07-12**.

This folder includes both user docs and engineering docs for the Obsidian plugin.

## User docs (`docs/user`)

- [Getting started](user/getting-started.md)
- [Settings](user/settings.md)
- [Commands](user/commands.md)
- [Tool use in Chat](user/agent-mode.md)
- [Ribbon icons](user/ribbon-icons.md)
- [Similar Notes (embeddings)](user/similar-notes.md)
- [Audio & transcription](user/audio-transcription.md)
- [Automations](user/automations.md)
- [Troubleshooting](user/troubleshooting.md)

## Engineering docs (repo root `docs/`)

- [Development, testing, and release](development.md)
- [Chat request flow](chat-request-flow.md)
- [Studio foundation](studio-foundation.md)
- [Testing coverage map](testing-coverage-map.md)

Historical product drafts and research snapshots are non-operational. Current
behavior is documented by the user and engineering references above.

## Canonical code references

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- First-party tool service: `src/tools/FirstPartyToolService.ts`
- Vault tools: `src/tools/vault/toolDefinitions.ts`
- YouTube transcript tool: `src/tools/youtube/YouTubeToolModule.ts`
