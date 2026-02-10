# Agent Mode (MCP tools)

Agent Mode lets the model request structured tool calls that run inside your vault. Tool continuation, retry, and policy decisions are PI-managed.

## How it works

1. You enable Agent Mode in the chat UI.
2. The model requests a tool call (for example: search for a file, read a note, apply an edit).
3. PI applies its tool policy and continuation behavior.
4. Tool results are returned to the model in-context.

## Enable/disable

Agent Mode is per-chat. Use the **Agent Mode** chip next to Model/Prompt in the chat toolbar, or open **Chat Settings** (gear icon) to toggle it.

## Tool call UI

### Approval actions

- Tool approval actions, when shown, come from PI policy/runtime behavior.

### Status chips

- `Awaiting approval`: waiting for your decision.
- `Approved, waiting to run`: approved, but waiting to execute.
- `Running`: currently executing.
- `Done`: finished successfully.
- `Denied`: rejected by user.
- `Failed`: execution returned an error.

### Summaries and details

- Tool cards use plain-language summaries so each action is readable without inspecting raw arguments.
- `move` calls show path changes explicitly as From -> To.
- `What changed` details expand progressively: brief summary first, then concrete file/path changes as results arrive.

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

## Paths

Filesystem tools take vault-relative paths (for example: `My Folder/My Note.md`). Spaces are supported. If you paste a URL-encoded path (for example from an Obsidian URL), `%20` / `%2F` will be decoded automatically.

### YouTube

| Tool | What it does |
| --- | --- |
| `youtube_transcript` | Fetch captions/transcript text for a YouTube URL |

## Safety tips

- Prefer `read`/`search`/`find` before allowing `edit`/`write`/`move`/`trash`.
- Approve destructive operations carefully (especially bulk edits/moves).
- If something looks off, deny the call and ask the model to explain its plan first.

## Tool loop guard

Tool-loop prevention and continuation behavior are controlled by the PI runtime. If PI blocks a repeated/failing tool sequence, the chat will show the runtime-provided error and stop continuing that loop.

## Safety policy

Safety policy is managed by PI runtime behavior.
