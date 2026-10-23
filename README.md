# SystemSculpt AI for Obsidian

An AI agent that works inside your vault. Ask about your notes, let the agent search, read, and edit files with your approval, transcribe audio into Markdown, find related notes, and build visual AI workflows. Runs on desktop and mobile.

**Free to start.** Install the plugin, create a free SystemSculpt account from inside Obsidian, and get 500 one-time starter credits for hosted AI. No card needed (while available). When you want more, [Monthly is $9/month and Lifetime is $149 once](https://systemsculpt.com/pricing?utm_source=obsidian&utm_medium=plugin_readme&utm_campaign=readme_free_start_nov2026); both include a monthly credit allowance. On desktop, chat and Studio text generation can also run on your own installed Codex or Claude Code without a SystemSculpt plan.

![SystemSculpt asks before it edits a note and shows the exact change](https://raw.githubusercontent.com/SystemSculpt/obsidian-systemsculpt-ai/main/docs/images/readme-chat-approval.png)

![The finished action items next to the chat summary](https://raw.githubusercontent.com/SystemSculpt/obsidian-systemsculpt-ai/main/docs/images/readme-chat-result.png)

## Start in two minutes

1. Install and enable SystemSculpt AI from Obsidian Community Plugins.
2. In the welcome window (or Settings → SystemSculpt AI → Account), create your free account. Approve the connection in your browser and choose the 500 starter credits.
3. Run **Open SystemSculpt Chat** from the command palette and ask about your vault.

Already have a plan? Sign in from the same window, or paste your license key in Settings → SystemSculpt AI → Account.

## What it does

- Chat with notes, documents, images, and built-in vault tools.
- Use on-machine Codex for desktop chats and Studio tasks with its native permissions and history.
- Use on-machine Claude Code for desktop chats and Studio text generation with its own login, permissions, and session history.
- Stream reasoning, content, citations, tool activity, and approvals.
- Attach or paste multiple mixed files into a conversation.
- Find related notes with a portable semantic index.
- Record or import audio and transcribe it to Markdown or SRT.
- Process long audio and YouTube videos into transcripts and structured summaries.
- Build text, image, video, document, media, and vault workflows in Studio.

SystemSculpt runs on desktop and mobile. Studio exposes portable nodes on both; local CLI, dataset-adapter, media-ingest, and FFmpeg nodes require Obsidian Desktop.

## Account, payment, and credits

The plugin is free to install. Hosted AI features use a SystemSculpt account and credits. A free account can claim 500 one-time starter credits, no card needed, while available. Monthly ($9/month) and Lifetime ($149 once) plans include a monthly credit allowance, and credit packs add more. See the [plan terms](https://systemsculpt.com/pricing) and your account for included usage.

Account, license, billing, and add-credit controls open first-party pages on [systemsculpt.com](https://systemsculpt.com); payments are handled there by Stripe and never occur inside the plugin. The plugin may show first-party license or credit purchase prompts when access or funds are insufficient, but it never purchases anything automatically.

## Updates

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
- On Obsidian Desktop, on-machine Claude Code runs only after you select it for chat or Studio text generation. The plugin then launches your installed `claude` command (`claude -p` with JSON input and output) as a local child process in the vault folder and exchanges messages with it over standard input and output. Claude Code keeps its own login, settings, permissions, and session history. On-machine Claude Code is unavailable on mobile.
- To start Claude Code, the plugin reads the optional launch settings file `~/.config/systemsculpt/claude.json`, which can set the `binary` to run. The plugin does not read, copy, or upload anything under `~/.claude`, including Claude Code credentials.
- Managed chat offers Ask Approval and Full Access for agent-requested vault mutations. On-machine Codex inherits its native approval, sandbox, and reviewer configuration; the plugin does not copy Codex credentials or override those controls. On-machine Claude Code asks before edits by default; you can choose Accept edits, Plan only, or your own Claude Code settings. Claude Code's permission requests appear as plugin dialogs, and the plugin never turns on Claude Code's permission bypass. License keys are removed from exported diagnostics and settings backups.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Agent tools and approvals](docs/user/agent-mode.md)
- [Settings](docs/user/settings.md)
- [Commands](docs/user/commands.md)
- [Studio workspaces, on-machine Codex and Claude Code](docs/studio-workspaces.md)
- [Similar Notes](docs/user/similar-notes.md)
- [Audio and transcription](docs/user/audio-transcription.md)
- [Audio Processor](docs/user/audio-processor.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Development

Building or contributing to the plugin: see [development.md](docs/development.md), [community-review.md](docs/community-review.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md).

## Release

- Version: see the [latest release](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/latest); `manifest.json` is authoritative
- Minimum Obsidian version: 1.7.2
- Platforms: desktop and mobile
- License: MIT

Support: [systemsculpt.com](https://systemsculpt.com) · [GitHub issues](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues) · support@systemsculpt.com
