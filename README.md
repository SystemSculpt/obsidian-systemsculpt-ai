# SystemSculpt AI for Obsidian

Use your own Claude Code or Codex on desktop, or SystemSculpt's hosted AI, to work with your Obsidian vault. Chat with your notes, search and edit files, transcribe audio into Markdown, find related notes, and build visual workflows. Hosted features run on desktop and mobile; your own desktop agents need no SystemSculpt account or plan. See the approval modes below for when changes ask for confirmation.

**Free to start.** Install the plugin and create or sign in to a free SystemSculpt account from inside Obsidian. Eligible new accounts can claim 500 one-time starter credits for hosted AI, no card needed, while available. When you want more, [Monthly is $9/month and Yearly is $90/year](https://systemsculpt.com/pricing?utm_source=obsidian&utm_medium=plugin_readme&utm_campaign=readme_free_start_nov2026); both include a monthly credit allowance.

![An example of SystemSculpt asking before a note edit in Ask mode and showing the exact change](https://raw.githubusercontent.com/SystemSculpt/obsidian-systemsculpt-ai/main/docs/images/readme-chat-approval.png)

![The finished action items next to the chat summary](https://raw.githubusercontent.com/SystemSculpt/obsidian-systemsculpt-ai/main/docs/images/readme-chat-result.png)

## Start in two minutes

1. Install and enable SystemSculpt AI from Obsidian Community Plugins.
2. For hosted AI, open **Settings → SystemSculpt AI → Account** and choose **Sign up** or **Sign in**. Complete the account connection in your browser; eligible new accounts can claim 500 one-time starter credits, no card needed, while available. For your own desktop Claude Code or Codex, skip the SystemSculpt account step and use your installed, signed-in agent.
3. Run **Open SystemSculpt Chat** from the command palette, choose your backend from the run line below the message box, and ask about your vault.

Already have a plan? Sign in from the same Account settings, or paste and activate your license key there.

## Coming from 5.x

SystemSculpt 6's managed backend no longer supports your own API keys, custom endpoints, or local models; updating removes previously saved plugin provider keys and routing settings. Native Claude Code and Codex keep their own configuration. Your SystemSculpt license and credits carry over. On desktop, you can use your own installed, signed-in Claude Code or Codex without a SystemSculpt account or plan, or use the free one-time hosted starter credits if eligible and available.

## What it does

- Chat with notes, documents, images, and built-in vault tools.
- Use on-machine Codex for desktop chats and Studio tasks with its native permissions and history.
- Use on-machine Claude Code for desktop chats and Studio text generation with its own login, permissions, and session history.
- Stream reasoning, content, citations, tool activity, and approvals.
- Attach or paste multiple mixed files into a conversation.
- Find related notes with a portable semantic index.
- Record or import audio and transcribe it to Markdown or SRT.
- Process long audio and YouTube videos into transcripts and structured summaries.
- Build text, video, document, media, and vault workflows in Studio.

SystemSculpt runs on desktop and mobile. Studio exposes portable nodes on both; local CLI, dataset-adapter, media-ingest, and FFmpeg nodes require Obsidian Desktop. Studio image generation was retired in 6.17; your saved images and projects stay, and video generation still works.

## Account, payment, and credits

The plugin is free to install. Hosted AI features use a SystemSculpt account and credits. Eligible new accounts can claim 500 one-time starter credits for hosted AI, no card needed, while available. Monthly ($9/month) and Yearly ($90/year) plans include a monthly credit allowance, and credit packs add more. Existing Lifetime licenses continue to be honored. See the [plan terms](https://systemsculpt.com/pricing?utm_source=obsidian&utm_medium=plugin_readme&utm_campaign=readme_free_start_nov2026) and your account for included usage.

Account, license, billing, and add-credit controls open first-party pages on [systemsculpt.com](https://systemsculpt.com); payments are handled there by Stripe and never occur inside the plugin. The plugin may show first-party license or credit purchase prompts when access or funds are insufficient, but it never purchases anything automatically.

## Updates

SystemSculpt checks its first-party release endpoint in the background. On desktop, a newer release shows a quiet **Update SystemSculpt** status-bar item; the **Check for updates** command reports the result on any device. Neither opens a prompt. Obsidian Community Plugins exclusively owns download, installation, updates, and activation.

## Privacy, network, and local access

- Built-in hosted features connect to the first-party SystemSculpt API at `https://systemsculpt.com/api/plugin` for account and license validation, credits, release checks, and hosted AI, embeddings, transcription, document, audio, and video work, including image attachments. Production builds reject hosted endpoint overrides. Update checks, account checks, and enabled iPhone capture or handoff sync can make network requests without sending a chat message. Native agents and user-configured Studio commands use their own network access.
- Hosted requests send the prompts, selected notes, files, images, audio, YouTube URLs, conversation context, and local tool results needed for the feature. SystemSculpt processes that data on its servers and through service and model providers, including OpenRouter, AssemblyAI, Supadata, and Cloudflare R2 as described in the [privacy policy](https://systemsculpt.com/privacy); the plugin does not connect to those providers directly. Hosted chat keeps server-side conversation state as well as the transcript saved in your vault.
- Enabling Similar Notes sends the Markdown text of included notes to SystemSculpt for hosted indexing; semantic searches also send their query text. Exclusions control background indexing and search discovery, not a blanket restriction on explicitly attached or requested file reads. The returned index is stored locally.
- The plugin contains no client-side telemetry or third-party advertising. The SystemSculpt service records limited account, usage, billing, and diagnostic metadata for hosted requests as described in the privacy policy.
- Obsidian stores the license key, settings, caches, and small device-local preferences locally. The plugin can create chats, recordings, attachments, embedding indexes, Studio projects and assets, diagnostics, and redacted settings backups inside the vault in configured directories.
- Semantic search, file pickers, and vault tools enumerate or read vault files when needed. User-invoked copy, paste, and attachment features access the system clipboard.
- On Obsidian Desktop, Studio's CLI, dataset-adapter, media-ingest, and FFmpeg nodes can read or write user-selected paths outside the vault and execute user-configured commands. These capabilities run only when the user configures and executes the relevant node and are unavailable on mobile.
- On Obsidian Desktop, Codex can be chosen automatically for new chats or selected by you for chat, Studio text generation, Codex task cards, run boards, or command centers. Detection can launch a sign-in-status probe before you send a message. For models and turns, the plugin launches your installed `codex app-server` command as a local child process and exchanges messages over standard input and output. Codex keeps its own login, configuration, and thread history. On-machine Codex is unavailable on mobile.
- To start Codex, the plugin reads the optional launch settings file `~/.config/systemsculpt/codex.json`, which can set the `binary` to run and the Codex `home` directory. It checks that the Codex home (`~/.codex` by default) exists and passes it to Codex as `CODEX_HOME`. The plugin does not read, copy, or upload file contents inside the Codex home, including Codex credentials.
- On Obsidian Desktop, Claude Code can be chosen automatically for new chats or selected by you for chat or Studio text generation. Detection can launch a sign-in-status probe before you send a message. For turns, the plugin launches your installed `claude` command (`claude -p` with JSON input and output) as a local child process in the vault folder and exchanges messages over standard input and output. Claude Code keeps its own login, settings, permissions, and session history. On-machine Claude Code is unavailable on mobile.
- To start Claude Code, the plugin reads the optional launch settings file `~/.config/systemsculpt/claude.json`, which can set the `binary` to run. The plugin does not read, copy, or upload file contents under `~/.claude`, including Claude Code credentials.
- Desktop agent detection checks installed agents' sign-in status through their CLI and lists native session filenames and modification times to choose an available backend; it does not read session-file contents or credentials. Claude Code and Codex send prompts, attached context, and tool results to their configured services under your own account and those services' policies. Their usage is separate from SystemSculpt credits; running their process on your machine does not mean offline AI.
- Enabled iPhone capture sync downloads captures from SystemSculpt and reports verified delivery and vault paths back to the service. iPhone handoffs also report available agents, progress, and the completed agent result and vault path to SystemSculpt so the iPhone can show them, including when Claude Code or Codex produced the result.
- New hosted chats start in **Auto**: reading, searching, creating files or folders, and editing run without asking; moving, renaming, and deleting require approval. **Ask** requests approval for every vault change; **Full access** allows vault actions without asking. Saved chats keep their selected mode.
- On-machine Codex uses its native approval and sandbox controls. Desktop chat offers **Auto**, **Ask**, **Read only**, and **Codex settings**. Codex settings and Studio inherit your native approval, sandbox, and reviewer configuration; the plugin does not copy Codex credentials. Plugin-defined modes do not request an unrestricted sandbox or bypass native permissions.
- New on-machine Claude Code chats default to **Auto**, using Claude Code's native safety checks. You can choose **Ask before edits**, **Accept edits**, **Plan only**, or your own **Claude Code settings**. If Auto is unavailable, the plugin uses Accept edits and shows a notice. Claude Code's permission requests appear inline in chat (and as request dialogs in Studio), and the plugin never turns on Claude Code's permission bypass.
- License keys are removed from exported diagnostics and settings backups.

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
- License: MIT (Obsidian plugin; the hosted service and iPhone app are not covered by this license)

Support: [systemsculpt.com](https://systemsculpt.com) · [GitHub issues](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues) · support@systemsculpt.com
