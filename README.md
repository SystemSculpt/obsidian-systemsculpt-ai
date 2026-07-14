# SystemSculpt AI for Obsidian

SystemSculpt brings an agent workspace, semantic vault search, transcription,
and visual workflows into Obsidian. Activate a SystemSculpt license once;
there are no provider keys, model catalogs, or local AI runtimes to configure.

## What it does

- Chat with notes, documents, images, and built-in vault tools.
- Stream reasoning, content, citations, tool activity, and approvals.
- Attach or paste multiple mixed files into a conversation.
- Find related notes with a portable semantic index.
- Record or import audio and transcribe it to Markdown or SRT.
- Build text, image, document, media, and vault workflows in Studio.
- Run capture-folder automations and review file-changing actions.

SystemSculpt runs on desktop and mobile. Studio exposes portable nodes on both;
local CLI, terminal, dataset-adapter, and FFmpeg nodes require Obsidian Desktop.

## Install

1. Install and enable SystemSculpt AI from Obsidian Community Plugins.
2. Open Settings → SystemSculpt AI → Account.
3. Activate your SystemSculpt license.
4. Run Open SystemSculpt Chat or open Studio.

Obsidian Community Plugins owns installation and updates. SystemSculpt does not
run a separate update checker.

## Privacy and safety

- The plugin sends AI work only to the first-party SystemSculpt API.
- Provider credentials and model selection stay on the server.
- Built-in tools operate against the current vault.
- Ask Approval pauses before vault mutations. Full Access runs them without
  pausing.
- License keys are removed from exported diagnostics and settings backups.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Agent tools and approvals](docs/user/agent-mode.md)
- [Settings](docs/user/settings.md)
- [Commands](docs/user/commands.md)
- [Similar Notes](docs/user/similar-notes.md)
- [Audio and transcription](docs/user/audio-transcription.md)
- [Automations](docs/user/automations.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Development

~~~bash
cd ~/gits/systemsculpt/plugin
npm install
npm run check
~~~

Use npm run test:related with the source files being changed. Run
npm run check:plugin for a larger local checkpoint and npm run check:full for
the exhaustive local gate.

To build against the sibling website API:

~~~bash
SYSTEMSCULPT_API_BASE_URL=http://127.0.0.1:3002/api/plugin npm run build
~~~

The override is compiled into the local artifact. Release validation always
rebuilds against https://systemsculpt.com/api/plugin.

The local SystemSculpt workspace is:

| Directory | Responsibility |
| --- | --- |
| ~/gits/systemsculpt/plugin | This Obsidian client |
| ~/gits/systemsculpt/website | Website and first-party plugin API |
| ~/gits/systemsculpt/systemsculpt-os | Growth and operator automation |

See [development.md](docs/development.md), [CONTRIBUTING.md](CONTRIBUTING.md),
and [AGENTS.md](AGENTS.md).

## Release

- Version: 6.0.0
- Minimum Obsidian version: 1.7.2
- Platforms: desktop and mobile
- License: MIT

Support: [systemsculpt.com](https://systemsculpt.com) ·
[GitHub issues](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues) ·
support@systemsculpt.com
