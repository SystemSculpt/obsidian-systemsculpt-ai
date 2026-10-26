# Getting started

SystemSculpt AI runs inside Obsidian. On desktop, new chats can automatically use
your installed, signed-in Claude Code or Codex; you need no SystemSculpt account or
license to use your own agents. Hosted chat uses your SystemSculpt account and is
also the chat backend on mobile.

Free to install. Paid Monthly and Yearly plans are available for hosted
SystemSculpt features in Obsidian, not required for your own desktop agents.
[Compare plans and current usage terms](https://systemsculpt.com/pricing?utm_source=obsidian&utm_medium=plugin_readme&utm_campaign=pricing_discovery_oct2026)
if you want hosted features.

## Install

### Community Plugins (recommended)

1. Open `Settings -> Community plugins`.
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

## First-run setup

### Use your own agent on desktop

If Claude Code or Codex is already installed and signed in, open a new chat and
check its execution summary. Your explicit backend choice takes priority; existing
paid hosted users keep SystemSculpt during migration. Otherwise, SystemSculpt
chooses the ready agent with more primary session files modified in the last 30
days, then the newest session-file modification time; Claude Code wins an exact
tie. If neither is ready, the new chat uses hosted SystemSculpt.

Use the run line under the composer to choose another backend, mode or model. Its
backend menu also has **Detect again** for after you install or sign in to an agent. Detection is cached for the Obsidian session
and also refreshes after a native run fails because an agent is missing or signed
out; there is no background polling. It lists session-store names and timestamps
only, never file contents under `~/.claude` or `~/.codex`. See
[Chat execution and automatic detection](settings.md#chat-execution-and-automatic-detection).

### Connect hosted SystemSculpt

For hosted chat, mobile chat, or other hosted features:

1. Open `Settings -> SystemSculpt AI -> Account`.
2. Use `Sign in` (or `Sign up`) to connect your SystemSculpt account in the browser, or enter and activate a license key manually.
3. Choose **View plans** to compare monthly, yearly, and credit packs. If you already purchased, sign in with the same email or activate the key from your receipt.
4. Review credits and account status. **Manage account** opens billing controls. You can also find **Sign in** and **View plans / buy credits** in the command palette.
5. Open docs or support links if you need help. If the browser does not return automatically, use **Open the sign-in page again** and paste the connection code. On Obsidian 1.8.7 or newer, a pending sign-in survives an app restart for up to ten minutes on the same device.

## Start chatting

- Command palette: `Open SystemSculpt Chat`
- Ribbon icon: `Open SystemSculpt Chat`
- The run line under the composer shows the backend, mode and model or credits;
  each part is a menu. **Auto** is the default for new chats. Saved chats keep their
  backend, and saved hosted modes are preserved (missing or unknown modes use **Ask**).
- An empty chat suggests three starters for the note you have open; they fill the
  message box without sending.
- **History** in the chat header (or `Mod+K` in the chat) lists your chats in place,
  grouped by date, with search across titles and message text.

## On-machine Codex (desktop)

If Codex was not selected automatically, choose **Codex** in the run line's backend
menu or in **Settings → SystemSculpt AI → Chat**. Install the
Codex CLI and run `codex login` in a terminal once. Codex owns its authentication,
tools and durable history; custom configurations that do not require an OpenAI
login remain available through manual selection.

The default **Auto** mode works inside the vault with Codex's automatic approval
reviewer. **Ask** uses you as the reviewer, **Read only** prevents changes, and
**Codex settings** inherits your native configuration. Auto is not full access or
permission bypass. Model, reasoning, speed and mode changes apply to the next
native turn. Switching backend opens a new chat and preserves the existing
conversation and draft. Studio Codex permissions still come from native
configuration, not the chat mode. Hosted media and Similar Notes still use
SystemSculpt.

See [Studio workspaces and native execution](../studio-workspaces.md) for setup and recovery behavior, and [native Codex discovery](../development.md#native-codex-discovery) for custom executable and home settings.

## On-machine Claude Code (desktop)

If Claude Code was not selected automatically, choose **Claude Code** in the run
line's backend menu or in **Settings → SystemSculpt AI → Chat**. Install Claude Code, run `claude` in a terminal and type `/login` once.
Chats run in your vault folder with Claude Code's own login and session history.

The default **Auto** mode uses Claude Code's native safety check, not bypass.
You can choose **Ask before edits**, **Accept edits**, **Plan only**, or **Claude
Code settings** instead. If Auto is unavailable, the chat uses **Accept edits**
and shows **Auto unavailable** with an explanation; update Claude Code to use
Auto. Review native permission requests in inline cards in the conversation:
Enter approves, Escape denies, and Alt+Up focuses a pending request. See
[Tool use and modes in Chat](agent-mode.md) and
[On-machine Claude Code](../studio-workspaces.md#on-machine-claude-code).

## Add context

- Select **+** in the message box: **Add current note**, **Add notes from vault…**,
  **Upload from computer…**, or **Pin files for every message…**.
- Type `@` or `[[` to mention a note. Pick it with the arrow keys and Enter or Tab:
  the message keeps a `[[Note]]` link and the note is attached to that message.
- When the message box is empty, a dashed chip suggests the note you have open.
  It is added only when you select it.
- Drop files from your computer, notes from the file explorer, or Similar Notes
  results anywhere on the chat. Paste images or files into the message box.
- Each attachment is a chip above the message. Select a chip to open it, pin it
  for every message, or remove it. Pinned files show a pin and stay after you send.
- Use `Chat with File` from the command palette.

## Message box keys

- **Enter** sends; **Shift+Enter** adds a new line. On touch screens, Enter adds a
  new line and the send button sends.
- While a response runs, **Esc** stops it and **Enter** queues your next message.
- **Up** and **Down** in an empty message box bring back your earlier messages.
- Typing while the conversation has focus continues in the message box.

## Tool use

- SystemSculpt can use built-in tools automatically when the current flow needs them.
- Hosted **Auto** reads, creates, writes and edits without asking, but asks before
  move/rename or trash. **Ask** pauses before every vault change; **Full access**
  also allows moves and trash without asking.
- Native Codex chat uses your configured Codex authentication and native approval
  controls. Claude Code chat uses your Claude Code login and its permission modes.
  See [Tool use and modes in Chat](agent-mode.md).

## Enable Similar Notes (optional)

1. Open `Settings -> SystemSculpt AI -> Knowledge`.
2. Enable embeddings.
3. Review indexing scope and exclusions for your vault.
4. Open `Open Similar Notes Panel`.

## Next docs

- [Settings](settings.md)
- [Commands](commands.md)
- [Troubleshooting](troubleshooting.md)
