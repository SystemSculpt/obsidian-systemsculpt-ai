# Agent Mode (MCP tools)

Agent Mode lets the model request structured tool calls that run inside your vault, with an explicit approve/deny flow.

## How it works

1. You enable Agent Mode in the chat UI.
2. The model requests a tool call (for example: search for a file, read a note, apply an edit).
3. You approve or deny the call.
4. The tool runs, and the result is returned to the model in-context.

## Built-in tools

Tool names below match the MCP tool definitions in:

- `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- `src/mcp-tools/youtube/MCPYouTubeServer.ts`

### Filesystem + vault tools

| Tool | What it does |
| --- | --- |
| `read` | Read file contents (supports pagination for large files) |
| `write` | Create/overwrite/append a file |
| `edit` | Apply find/replace edits to an existing file |
| `create_folders` | Create one or more folders |
| `list_items` | List directory contents |
| `move` | Move/rename files/folders (updates wiki-links/embeds) |
| `trash` | Move files/folders to Obsidian’s trash |
| `find` | Search for files/folders by name |
| `search` | Full-text search across note contents |
| `open` | Open files in the Obsidian workspace |
| `context` | Add/remove files from the chat’s context set |

### YouTube

| Tool | What it does |
| --- | --- |
| `youtube_transcript` | Fetch captions/transcript text for a YouTube URL |

## Safety tips

- Prefer `read`/`search`/`find` before allowing `edit`/`write`/`move`/`trash`.
- Approve destructive operations carefully (especially bulk edits/moves).
- If something looks off, deny the call and ask the model to explain its plan first.

