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

A sign-in check that takes longer than three seconds reports **Sign-in status
unknown**, not signed out. An installed agent with sessions from the last 30 days
can still be selected automatically. SystemSculpt checks once more in the
background; that result updates availability without switching the open chat.

Detection is cached for the current Obsidian session, not polled in the background.
Choose **Detect again** in the chat's backend menu (the first part of the run line
under the composer), or in an empty chat's install hint, after installing or
signing in to an agent. A native run that fails because the agent is missing or
signed out also refreshes detection. Refreshing does not replace your explicit
choice or switch a chat with messages; an empty chat that detection chose for you
moves to the agent that became ready. Pick a backend from the same menu yourself.

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

Mode and model changes apply to the next message. Switching backend in a chat with
messages starts a new chat in the same view: the draft, its attachments and pinned
files come along, the original chat stays in history, and **Back to previous chat**
returns to it. A saved chat always reopens on its own backend; when that agent
isn't installed here (or on mobile), the chat opens read-only with **New chat**. See [Tool use and modes in Chat](agent-mode.md) for each mode's behavior.

An explicitly selected backend also applies to Studio text generation, but chat
automatic detection does not change Studio's backend default. **Codex chat modes do
not apply to Studio**: Studio continues to inherit Codex's native permission
configuration. See [Studio workspaces](../studio-workspaces.md).

## iPhone handoffs

Once your signed-in account has used the iOS app, Chat shows **From your iPhone**
cards with the full instruction, source capture and chosen agent. Choose **Run**
to open a fresh agent workspace without replacing your current draft. Claude Code
and Codex run on desktop only; hosted SystemSculpt can also run on mobile. The
plugin reports the agents available in this vault to your iPhone.

Under **Workspace → iOS captures**, **Run iPhone handoffs without asking** is off
by default, including for existing installations. Turning it on starts incoming
handoffs in background chat tabs. It skips only the card's Run click: the chosen
agent's own permission mode and approval requests still apply. Approve or decline
those requests in that handoff's chat, just as in an ordinary chat.

The plugin checks for handoffs when Obsidian opens, regains focus and every five
minutes. A completed result is saved as Markdown in `SystemSculpt/Handoffs/`, then
the result text and vault path are uploaded to SystemSculpt for the phone to
retrieve, including results produced by Claude Code or Codex. Closing Obsidian, losing queue
ownership or changing accounts stops local execution. An interrupted handoff is
not silently run again: its result note records that it started, and its chat
retains the conversation. Review both before sending the instruction again.

## Saving changes

Chat tags and Studio text fields save after a short typing pause, or immediately
when you leave the field or close settings. Workspace directory paths save when
you leave the field, choose a folder, or close settings, rather than saving each
partial path. Toggles and selections still apply immediately. Output folders are
created only when a feature saves a file there, not on startup or when you change
a directory setting. Existing folders and files are never removed by this cleanup.

Unchanged values do not rewrite settings or backups. Changes refresh only the
features that use them; editing a chat tag does not restart vault indexing or
refresh account credits.

## Notes

- The top-level settings tabs are `Account`, `Chat`, `Workflow`, `Knowledge`, `Workspace`, `Studio`, and `Advanced`.
- `Default output` under Workflow selects the Audio Processor preset used when the modal opens. You can still choose a different preset for one new job.
- **iOS captures** appears under Workspace only after your SystemSculpt account has signed in to the SystemSculpt iOS app; until then the plugin shows no iOS settings and makes no capture requests. Once it appears, it saves notes and voice memos from the app into the vault while you are signed in; the new notes are the receipt, with no notice unless something could not be saved or confirmed. It checks when Obsidian opens, when it regains focus and every five minutes, on desktop and mobile. Notes and transcripts become new notes in `SystemSculpt/Inbox` (**iOS captures folder**) with `source`, `captured`, `tags` and `capture_id` frontmatter. Meetings go to `SystemSculpt/Meetings` (**iOS meetings folder**, next to the inbox folder setting), with additional `type: meeting`, `meeting_start`, `duration` when known, and `attendees` frontmatter. Meeting notes preserve the server's Summary, Decisions, checkable Action items, Topics and folded Transcript callout, omitting empty sections. If no brief is available, the transcript callout is unfolded. Both folders are configurable; existing notes are never overwritten, and delivery is confirmed only after the note is verified in the vault. Turn on **Ask before saving iOS captures** to confirm each batch, or turn the inbox off. The command **Save iOS captures now** checks immediately and always reports what it found.
- Some sections are conditionally visible based on current settings.
