# SystemSculpt AI for Obsidian

SystemSculpt brings AI chat, transcription, semantic search, and visual workflows into your Obsidian vault. Activate a SystemSculpt license once; there are no provider keys or model catalogs to configure.

## What it does

- Chat with notes, documents, images, and built-in vault tools.
- Record meetings or voice notes and transcribe them to Markdown.
- Find related notes with a portable semantic index.
- Build text, image, document, and media workflows in Studio.
- Run capture-folder automations for repeatable vault work.
- Review file-changing tool activity before it is applied.

SystemSculpt 6 is desktop-only.

## Start

1. Install and enable **SystemSculpt AI** from Obsidian Community Plugins.
2. Open `Settings -> SystemSculpt AI -> Account`.
3. Activate your SystemSculpt license.
4. Run `Open SystemSculpt Chat` or open Studio.

## Privacy and safety

- AI requests use the SystemSculpt API.
- Provider credentials, model catalogs, and provider SDKs are not part of the plugin.
- Built-in tools operate against the current vault and use the plugin's approval policy.
- License keys are removed from exported diagnostics and settings backups.

## Documentation

- [Documentation](docs/README.md)
- [Getting started](docs/user/getting-started.md)
- [Settings](docs/user/settings.md)
- [Commands](docs/user/commands.md)
- [Audio and transcription](docs/user/audio-transcription.md)
- [Automations](docs/user/automations.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Development

```bash
npm install
npm run check
npm run test:integration
```

`npm run check` is the bounded edit-loop gate. Run `npm run check:full` for the
exhaustive Obsidian lint, artifact, unit, embeddings, integration, and release
verification path.

The compiled desktop plugin is the integration boundary. `npm run build` may use
`SYSTEMSCULPT_API_BASE_URL` and `SYSTEMSCULPT_WEBSITE_API_BASE_URL` for local QA;
one loopback API-v1 override automatically covers `/api/plugin` on the same origin.
Release validation always rebuilds against both production SystemSculpt APIs. See [development.md](docs/development.md)
and [CONTRIBUTING.md](CONTRIBUTING.md) for the supported checks.

## Current release

- Version: `6.0.0`
- Minimum Obsidian version: `1.4.0`
- Platform: desktop
- License: MIT

Support: [systemsculpt.com](https://systemsculpt.com) · [GitHub issues](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues) · `support@systemsculpt.com`
