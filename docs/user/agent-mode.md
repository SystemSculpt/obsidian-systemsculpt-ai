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

The Web control asks SystemSculpt to use web search
for that turn. Search and page retrieval happen on the server; the plugin
receives the resulting agent events and citations. There are no client-side
web-search tools, direct web endpoints, or web-research corpus directory.

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

## Practical safety tips

- Prefer read/search/list tools before edit/write/move/trash.
- Deny any unclear destructive request and ask the model for a plan first.
- Use **Allow until closed** only when you expect the same kind of change repeatedly.
