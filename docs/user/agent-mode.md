# Tool use and modes in Chat

SystemSculpt can use tools during chat when the current flow needs them. There is no separate Agent Mode toggle in the plugin.

## Approval behavior

The run line under the composer says who answers and where it runs, the mode, and
the model (or, for hosted chat, your credits), for example
`Claude Code on this Mac · Auto · Default`. Each part opens a menu in one click;
`Mod+.` opens the mode menu while the chat has focus. New chats default to
**Auto**; Auto uses the selected backend's safety policy, not permission bypass.
Mode changes apply from the next message, even while a response is running, and
never start a new chat. Saved hosted chats keep their saved mode; missing or
unrecognized saved modes use **Ask**.

### Claude Code (desktop)

| Mode | Behavior |
| --- | --- |
| **Auto** (default) | Runs safe actions without asking. Claude Code's safety check blocks risky ones. |
| **Ask before edits** | Asks before every edit and command. |
| **Accept edits** | Edits notes without asking. Asks before commands. |
| **Plan only** | Reads and plans. Changes nothing until you approve the plan. |
| **Claude Code settings** | Uses the permission rules in your Claude Code settings. |

These are Claude Code's native modes (`auto`, `manual`, `acceptEdits`, and `plan`);
**Claude Code settings** leaves the mode to your native configuration. When Claude
Code asks to use a tool, an inline card in the conversation shows what it wants to
change, including a diff for edits. The original request is available under **Details**.

If Auto is unavailable, the chat shows **Accept edits · Auto unavailable** and a
notice explaining that edits are accepted automatically while other actions ask.
Update Claude Code to use Auto. The plugin never passes `bypassPermissions` or
`dontAsk`.

### Codex (desktop)

| Mode | Behavior |
| --- | --- |
| **Auto** (default) | Works inside this vault. Codex's reviewer only asks you about unsafe actions. |
| **Ask** | Works inside this vault. Asks before editing other files or using the internet. |
| **Read only** | Reads your vault without changing it. |
| **Codex settings** | Uses your own Codex configuration. |

Auto uses native `on-request` approvals, a `workspace-write` sandbox rooted in the
vault, and `approvalsReviewer: auto_review`. Ask keeps that sandbox and approval
policy but uses the `user` reviewer. Read only uses a `read-only` sandbox and
`never` approvals: it cannot escalate into a write. The plugin-defined modes never
request `danger-full-access` or combine `never` with a writable sandbox.

Codex settings inherits your native approval policy, sandbox, permission profiles
and reviewer. When resuming a chat in that mode, the plugin resolves current
configuration through an ephemeral thread without running a model turn, rather
than keeping stale permissions from the saved thread. Native approval and question
requests appear inline in the conversation. Studio retains its native request dialogs.

These Codex chat modes do not change Studio permissions. Studio Codex execution
continues to inherit your native configuration.

### SystemSculpt (hosted, desktop and mobile)

| Mode | Behavior |
| --- | --- |
| **Auto** (default for new chats) | Reads, creates and edits notes without asking. Asks before moving or deleting. |
| **Ask** | Asks before every change to your vault. |
| **Full access** | Makes every change without asking, including moves and deletes. |

Read, list, find, search, open, and context actions run without approval in every
hosted mode. Auto also allows write, edit, multi-edit and folder creation without
asking, but move/rename and trash still require approval. Ask pauses before any
vault mutation. For a pending request, you can deny, allow once, or allow that
action until the chat closes. Full access also allows moving files or folders to
Obsidian trash without pausing; choose it only when you intend that access.

## Reviewing inline approvals

All three chat backends use inline approval cards, not pop-up dialogs. Focus a
pending card and press **Enter** or **⌘/Ctrl+Enter** to approve, or **Esc** to deny.
Use **↑/↓** to move between pending cards. **⇧⌘/Ctrl+Enter** chooses **Approve all
in this chat** when the agent offers a session-scoped grant.

A session approval covers only the scope shown by that action; it is not blanket
permission. Native agents own the grant, and already-pending requests still need
their own answer. Closing the live chat ends its native session grants.

A new card does not interrupt typing. Use **Approval needed · Review** or
**⌥/Alt+↑** (also **⌥/Alt+↓**) anywhere in the chat view to focus the first pending
card. With no card pending, these keys keep their normal behavior. Resolved cards
retain their result, and focus moves to the next pending card or back to the composer.

## Where tools come from

Hosted vault actions are built directly into SystemSculpt. No separate tool server
or client-side model runtime is required. On-machine Claude Code and Codex use
their own native tools, permissions and session history instead of the hosted tool
list below.

## Built-in tool list

| Tool | Purpose |
| --- | --- |
| `read` | Read file contents (supports pagination) |
| `write` | Create/overwrite/append files |
| `edit` | Apply structured edits to existing files |
| `multi_edit` | Apply an atomic batch of edits across multiple files |
| `create_folders` | Create folders |
| `list_items` | List files/folders |
| `move` | Move/rename files and folders |
| `trash` | Move files/folders to Obsidian trash |
| `find` | Search by file/folder name |
| `search` | Full-text search inside files |
| `open` | Open files in Obsidian workspace |
| `context` | Add/remove files from chat context |

## Server-owned web search

SystemSculpt can use web search when current or external information would
materially improve its answer. Search happens on the server; the plugin
receives brief activity updates and cited answers. There are no
client-side web-search tools, direct web endpoints, provider credentials, or
web-research corpus directory.

## Vault and image context

Use **+** in the message box, an `@` or `[[` mention, or a drop to add vault notes
and supported images to a message, or pin them for every message. SystemSculpt sends image context as image input, so you can ask about
what is visible in a diagram, screenshot, or other supported vault image. The
supported formats are PNG, JPG, and WebP, with a 10 MB limit per image. The
semantic vault index remains text-based; adding an image to the current chat is
different from searching every image in the vault.

## Paths and arguments

For hosted built-in tools:

- Filesystem paths are vault-relative.
- URL-encoded paths are normalized by tool layers when possible.
- Tool arguments must match each tool schema exactly.
- New files and folders get names that work on every device and in Obsidian
  Sync. When a requested name contains characters such as `:` `?` `*` `#` `[`
  `]` `|`, starts or ends with a dot or space, or is a reserved Windows name
  such as `CON`, the write, folder creation, or move uses a portable name
  instead and tells the model the path it used. If that portable name is
  already taken, a number is added, so an existing note is never replaced.
  Existing files keep their exact names, so the agent can still edit or rename
  them.

## Practical safety tips

- Prefer read/search/list tools before edit/write/move/trash.
- Deny any unclear destructive request and ask the model for a plan first.
- Use **Approve all in this chat** only when you expect more actions within its displayed scope.
