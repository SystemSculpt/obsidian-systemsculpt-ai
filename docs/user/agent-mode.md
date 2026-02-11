# Agent Mode (tools)

Agent Mode allows the model to call structured tools during chat.

## Where tools come from

- Filesystem MCP server: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP server: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`

## Built-in tool list

| Tool | Purpose |
| --- | --- |
| `read` | Read file contents (supports pagination) |
| `write` | Create/overwrite/append files |
| `edit` | Apply structured edits to existing files |
| `create_folders` | Create folders |
| `list_items` | List files/folders |
| `move` | Move/rename files and folders |
| `trash` | Move files/folders to Obsidian trash |
| `find` | Search by file/folder name |
| `search` | Full-text search inside files |
| `open` | Open files in Obsidian workspace |
| `context` | Add/remove files from chat context |
| `youtube_transcript` | Extract transcript from YouTube URL |
| `web_search` | Search web and save corpus entries |
| `web_fetch` | Fetch URL content and save corpus entry |

## Approval behavior

Approval logic is policy-based (`src/utils/toolPolicy.ts`).

- Auto-run by default: non-destructive filesystem tools, `youtube_transcript`, and web research tools.
- Approval required by default: destructive filesystem tools (`write`, `edit`, `move`, `trash`).
- Trusted/allowlisted tools can auto-run.
- External MCP servers (non-internal) require approval unless allowlisted.

## Paths and arguments

- Filesystem paths are vault-relative.
- URL-encoded paths are normalized by tool layers when possible.
- Tool arguments must match each tool schema exactly.

## Practical safety tips

- Prefer read/search/list tools before edit/write/move/trash.
- Deny any unclear destructive request and ask the model for a plan first.
- Keep an allowlist only for tools you trust repeatedly.
