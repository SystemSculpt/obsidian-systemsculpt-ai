# Settings

Open `Settings -> SystemSculpt AI`.

Source of truth: `src/settings/SettingsTabRegistry.ts`.

## Tab list

| Tab label | What it covers |
| --- | --- |
| `Account` | License activation, credits and usage access, billing details, and SystemSculpt docs/support links |
| `Chat` | Execution backend and modes, native Codex model/reasoning/speed and Claude Code model on desktop, display defaults, accessibility behavior, and history tags |
| `Workflow` | Recording preferences, Audio Processor output, transcription output, and post-processing controls |
| `Knowledge` | Embeddings, Similar Notes, exclusions, and processing status |
| `Workspace` | Directory paths, iOS captures (once shown), workspace diagnostics, automatic backups, and restore workflow |
| `Studio` | Studio project storage, run retention, and generated-artifact retention |
| `Advanced` | Quick actions, reset defaults, diagnostics recording (off by default), and diagnostics tools |

## Chat execution and automatic detection

On desktop, choose **SystemSculpt**, **Claude Code** or **Codex**. An explicit choice wins over automatic detection, and existing paid hosted
users stay on SystemSculpt when their settings migrate. Saved chats retain their
backend.

For a new desktop chat without an explicit choice or a preserved paid hosted
selection, SystemSculpt checks which agents are installed and signed in:

1. If only one is ready, use it.
2. If both are ready, use the one with more primary session files modified in the
   last 30 days, then the newest session-file modification time. Claude Code wins
   an exact tie.
3. If neither is ready, use hosted SystemSculpt.

Detection is cached for the current Obsidian session, not polled in the background.
Use **Detect again** beside the chat's compact execution summary after installing
or signing in to an agent. A native run that fails because the agent is missing or
signed out also refreshes detection. Refreshing does not replace your explicit
choice or switch an existing chat; it can update the default for the next new chat.
Use **Change** to reveal controls and select a backend yourself.

To rank recent use, detection only lists names and checks timestamps of primary
session files in the native stores (normally `~/.claude/projects` and
`~/.codex/sessions`). It never reads file contents under `~/.claude` or `~/.codex`.
Sign-in checks go through the installed CLI; the plugin does not read or copy
credentials from those directories.

Your own desktop agents need no SystemSculpt account or license. Mobile uses hosted
SystemSculpt, does not run local-agent detection, and keeps saved native chats
readable. Hosted media features and Similar Notes still use SystemSculpt.

## Chat modes

- **Claude Code:** **Auto** is the default. Other choices are **Ask before edits**,
  **Accept edits**, **Plan only**, and **Claude Code settings**. Auto uses Claude
  Code's native safety check; if unavailable, the chat uses **Accept edits** with
  an **Auto unavailable** notice, never a bypass mode.
- **Codex:** **Auto** is the default, using the vault workspace sandbox and Codex's
  automatic reviewer. **Ask** uses a user reviewer, **Read only** prevents changes,
  and **Codex settings** inherits native configuration, including on resumed chats.
- **SystemSculpt:** New hosted chats start in **Auto**, allowing routine reads,
  creation, writes and edits while asking before move/rename or trash. **Ask** and
  **Full access** remain available. Saved modes are preserved; a missing or unknown
  saved mode uses Ask.

Native mode and model changes apply to the next message. Switching execution
backend from a chat opens a new chat and preserves the original conversation and
draft. See [Tool use and modes in Chat](agent-mode.md) for each mode's behavior.

An explicitly selected backend also applies to Studio text generation, but chat
automatic detection does not change Studio's backend default. **Codex chat modes do
not apply to Studio**: Studio continues to inherit Codex's native permission
configuration. See [Studio workspaces](../studio-workspaces.md).

## Notes

- The top-level settings tabs are `Account`, `Chat`, `Workflow`, `Knowledge`, `Workspace`, `Studio`, and `Advanced`.
- `Default output` under Workflow selects the Audio Processor preset used when the modal opens. You can still choose a different preset for one new job.
- **iOS captures** appears under Workspace only after your SystemSculpt account has signed in to the SystemSculpt iOS app; until then the plugin shows no iOS settings and makes no capture requests. Once it appears, a one-time notice says where captures go, and it saves notes and voice memos from the app into the vault while you are signed in. It checks when Obsidian opens, when it regains focus and every five minutes, on desktop and mobile. Each capture becomes a new note in `SystemSculpt/Inbox` (configurable) with `source`, `captured`, `tags` and `capture_id` frontmatter; existing notes are never overwritten. Turn on **Ask before saving iOS captures** to confirm each batch, or turn the inbox off. The command **Save iOS captures now** checks immediately.
- Some sections are conditionally visible based on current settings.
