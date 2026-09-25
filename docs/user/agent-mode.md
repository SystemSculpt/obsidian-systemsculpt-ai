# Tool use in Chat

SystemSculpt can use built-in tools during chat when the current flow needs them. There is no separate Agent Mode toggle in the plugin.

## Where tools come from

Vault actions are built directly into SystemSculpt. No separate tool server or
client-side model runtime is required.

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

Use the files control in the composer to add vault context, including supported
images. SystemSculpt sends image context as image input, so you can ask about
what is visible in a diagram, screenshot, or other supported vault image. The
supported formats are PNG, JPG, and WebP, with a 10 MB limit per image. The
semantic vault index remains text-based; adding an image to the current chat is
different from searching every image in the vault.

## Approval behavior

Choose the approval mode in the chat composer:

- **Ask Approval** pauses before vault changes. You can deny, allow once, or allow that action until the chat closes.
- **Full Access** runs all vault actions without pausing, including moving files or folders to trash.

Read, list, find, search, open, and context actions run without approval. Write,
edit, multi-edit, folder creation, move, and trash actions follow the selected
approval mode.

## Paths and arguments

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
- Use **Allow until closed** only when you expect the same kind of change repeatedly.
