# SystemSculpt AI (Obsidian Plugin)

AI chat, semantic search, meeting transcription, image generation, and agent workflows — inside your Obsidian vault, on your terms.

Bring your own API keys (no license wall) or use managed models with SystemSculpt Pro. Every AI file change can be reviewed before it touches your notes.

## Why SystemSculpt AI

- **Chat with your vault.** Conversational AI that reads, searches, and reasons over your notes, with custom system prompts loaded from vault markdown files and favorite-filtered model selection.
- **Agents you stay in control of.** Toggle agent mode for tool-assisted workflows — read, search, edit, move, and organize notes — with review-before-change so AI never silently rewrites your vault.
- **Semantic search that survives sync (Pro).** Find notes by meaning with embeddings, backed by a portable index that survives Obsidian Sync and vault restore.
- **Voice to notes.** Record audio and transcribe meetings or voice memos straight into markdown, including self-hosted Whisper and a separate post-processing model.
- **Image generation in Studio.** Generate images from a Studio canvas node: pick the model, aspect ratio, image size, seed, and batch count.
- **Automations.** Capture-folder workflows that process new files automatically.
- **Your keys, your models.** Native Anthropic (Claude), Google (Gemini), OpenAI, xAI, and OpenRouter support, plus local Pi providers with clear Ollama guidance. BYOK chat never hits a SystemSculpt license wall.

Works on desktop and mobile.

## Free vs Pro

- **Bring your own keys:** BYOK-powered chat and features run entirely on your own provider keys.
- **SystemSculpt Pro:** managed models with no key setup, semantic search / Similar Notes, hosted transcription and image credits, and priority support — $19/month or $149 lifetime. Details at [systemsculpt.com/pricing](https://systemsculpt.com/pricing).

## Quick start

1. Install **SystemSculpt AI** from Obsidian Community Plugins.
2. Open `Settings -> SystemSculpt AI`.
3. Add a provider key under `Providers`, or activate a Pro license under `Account`.
4. Run the command `Open SystemSculpt Chat`.
5. Optional (Pro license required): enable embeddings in `Knowledge` for Similar Notes.

## Privacy and safety

- BYOK requests go to your chosen provider with your keys.
- Agent edits support review-before-change, and agent tool policies (including command approval) are enforced and synced.
- License keys are redacted from logs.

## Docs

- Docs hub: [docs/README.md](docs/README.md)
- Getting started: [docs/user/getting-started.md](docs/user/getting-started.md)
- Settings reference: [docs/user/settings.md](docs/user/settings.md)
- Commands: [docs/user/commands.md](docs/user/commands.md)
- Ribbon icons: [docs/user/ribbon-icons.md](docs/user/ribbon-icons.md)
- Similar Notes: [docs/user/similar-notes.md](docs/user/similar-notes.md)
- Audio & transcription: [docs/user/audio-transcription.md](docs/user/audio-transcription.md)
- Automations: [docs/user/automations.md](docs/user/automations.md)
- Troubleshooting: [docs/user/troubleshooting.md](docs/user/troubleshooting.md)

## Installation

### Community Plugins (recommended)

1. Open Obsidian `Settings -> Community plugins`.
2. Search for `SystemSculpt AI`.
3. Click `Install`, then `Enable`.

### Manual install

```bash
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/systemsculpt/obsidian-systemsculpt-ai systemsculpt-ai
cd systemsculpt-ai
npm install
npm run build
```

## Current release facts

- Plugin version: `5.11.0`
- Minimum Obsidian version: `1.4.0`
- Platforms: desktop and mobile (`manifest.json` sets `isDesktopOnly: false`)
- License: MIT

## Development

Build, test, sync, and release documentation lives in [docs/development.md](docs/development.md), with contributor gates in [CONTRIBUTING.md](CONTRIBUTING.md). Common entry points:

```bash
npm run dev               # watch build
npm run build             # production build
npm run check:plugin      # typecheck + bundle resolution
npm run check:all         # plugin check + Jest suite
npm test                  # full unit suite
```

## Support

- Website: `https://systemsculpt.com`
- Repo: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai`
- Issues: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues`
- Email: `support@systemsculpt.com`

## License

MIT. See `LICENSE`.
