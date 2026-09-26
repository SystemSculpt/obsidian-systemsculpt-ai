# SystemSculpt AI for Obsidian

SystemSculpt brings an agent workspace, semantic vault search, transcription, and visual workflows into Obsidian. Hosted features use your SystemSculpt account. Desktop chat and Studio text generation can also use your installed, signed-in Codex.

## What it does

- Chat with notes, documents, images, and built-in vault tools.
- Use on-machine Codex for desktop chats and Studio tasks with its native permissions and history.
- Stream reasoning, content, citations, tool activity, and approvals.
- Attach or paste multiple mixed files into a conversation.
- Find related notes with a portable semantic index.
- Record or import audio and transcribe it to Markdown or SRT.
- Process long audio and YouTube videos into transcripts and structured summaries.
- Build text, image, video, document, media, and vault workflows in Studio.

SystemSculpt runs on desktop and mobile. Studio exposes portable nodes on both; local CLI, dataset-adapter, media-ingest, and FFmpeg nodes require Obsidian Desktop.

## Account, payment, and credits

The plugin is free to install, but full access to hosted AI features requires a SystemSculpt account and paid license. Hosted work consumes included or purchased account credits.

Account, license, billing, and add-credit controls open first-party pages on [systemsculpt.com](https://systemsculpt.com); payments are handled there by Stripe and never occur inside the plugin. The plugin may show first-party license or credit purchase prompts when access or funds are insufficient, but it never purchases anything automatically.

## Install

1. Install and enable SystemSculpt AI from Obsidian Community Plugins.
2. Open Settings → SystemSculpt AI → Account.
3. Sign in or activate a SystemSculpt license key.
4. Run Open SystemSculpt Chat or open Studio.

SystemSculpt checks its first-party release endpoint and shows one update prompt per new version. Obsidian Community Plugins exclusively owns download, installation, updates, and activation.

## Privacy, network, and local access

- The plugin connects only to the first-party SystemSculpt API at `https://systemsculpt.com/api/plugin` for account and license validation, credits, release checks, and hosted AI, embeddings, transcription, document, audio, image, and video work.
- Hosted requests send the prompts, selected notes, files, images, audio, YouTube URLs, conversation context, and local tool results needed for the feature the user invokes. SystemSculpt may process that data server-side through OpenRouter, AssemblyAI, Supadata, and Cloudflare R2 as described in the [privacy policy](https://systemsculpt.com/privacy); the plugin does not connect to those providers directly.
- The plugin contains no client-side telemetry or third-party advertising. The SystemSculpt service records limited account, usage, billing, and diagnostic metadata for hosted requests as described in the privacy policy.
- Obsidian stores the license key, settings, caches, and small device-local preferences locally. The plugin can create chats, recordings, attachments, embedding indexes, Studio projects and assets, diagnostics, and redacted settings backups inside the vault in configured directories.
- Semantic search, file pickers, and vault tools enumerate or read vault files when needed. User-invoked copy, paste, and attachment features access the system clipboard.
- On Obsidian Desktop, Studio's CLI, dataset-adapter, media-ingest, and FFmpeg nodes can read or write user-selected paths outside the vault and execute user-configured commands. These capabilities run only when the user configures and executes the relevant node and are unavailable on mobile.
- On Obsidian Desktop, on-machine Codex runs only after you select it for chat or Studio text generation, or use a Studio Codex task card, run board, or command center. The plugin then launches your installed `codex app-server` command as a local child process and exchanges messages with it over standard input and output to list models and run turns. Codex keeps its own login, configuration, and thread history. On-machine Codex is unavailable on mobile.
- To start Codex, the plugin reads the optional launch settings file `~/.config/systemsculpt/codex.json`, which can set the `binary` to run and the Codex `home` directory. It checks that the Codex home (`~/.codex` by default) exists and passes it to Codex as `CODEX_HOME`. The plugin does not read, copy, or upload files inside the Codex home, including Codex credentials.
- Managed chat offers Ask Approval and Full Access for agent-requested vault mutations. On-machine Codex inherits its native approval, sandbox, and reviewer configuration; the plugin does not copy Codex credentials or override those controls. License keys are removed from exported diagnostics and settings backups.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Agent tools and approvals](docs/user/agent-mode.md)
- [Settings](docs/user/settings.md)
- [Commands](docs/user/commands.md)
- [Studio workspaces and on-machine Codex](docs/studio-workspaces.md)
- [Similar Notes](docs/user/similar-notes.md)
- [Audio and transcription](docs/user/audio-transcription.md)
- [Audio Processor](docs/user/audio-processor.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Development

~~~bash
cd ~/gits/systemsculpt/plugin
npm install
npm run check
~~~

Use `npm run test:related -- <changed source files>` for focused verification, `npm run check:plugin` for a larger checkpoint, and `npm run check:ci` for the exhaustive gate. `npm run lint:community` runs the official Obsidian community-directory source checker locally.

Select each non-production API through its named development command:

~~~bash
npm run build:local-agent
npm run build:staging
~~~

The local-agent route is fixed at `http://127.0.0.1:8787/api/plugin`. Production builds reject endpoint overrides and use `https://systemsculpt.com/api/plugin`.

| Directory | Responsibility |
| --- | --- |
| `~/gits/systemsculpt/plugin` | This Obsidian client |
| `~/gits/systemsculpt/systemsculpt-website` | Website and first-party plugin API |
| `~/gits/systemsculpt/systemsculpt-os` | Growth and operator automation |

See [development.md](docs/development.md), [community-review.md](docs/community-review.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md).

## Release

- Version: see the [latest release](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/latest); `manifest.json` is authoritative
- Minimum Obsidian version: 1.7.2
- Platforms: desktop and mobile
- License: MIT

Support: [systemsculpt.com](https://systemsculpt.com) · [GitHub issues](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues) · support@systemsculpt.com
