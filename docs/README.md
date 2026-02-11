# SystemSculpt AI docs

Last verified against code: **2026-02-11**.

This folder includes both user docs and engineering docs for the Obsidian plugin.

## User docs (`docs/user`)

- [Getting started](user/getting-started.md)
- [Settings](user/settings.md)
- [Commands](user/commands.md)
- [Ribbon icons](user/ribbon-icons.md)
- [Agent Mode tools](user/agent-mode.md)
- [Similar Notes (embeddings)](user/similar-notes.md)
- [Daily Vault](user/daily-vault.md)
- [Audio & transcription](user/audio-transcription.md)
- [Automations](user/automations.md)
- [Troubleshooting](user/troubleshooting.md)

## Engineering docs (repo root `docs/`)

- [Chat request flow](chat-request-flow.md)
- [Benchmark](benchmark.md)
- [Testing coverage map](testing-coverage-map.md)
- [On-device embeddings PRD (archival draft)](prd-on-device-embeddings.md)
- [Design notes (snapshot docs)](design/)
- [Research notes (time-bound snapshots)](research/)

## Canonical code references

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- Filesystem MCP tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP tool: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`
