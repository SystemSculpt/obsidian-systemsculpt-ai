# Commands & hotkeys

SystemSculpt AI registers commands in Obsidian’s command palette.

Notes:

- Some commands only appear when they apply (for example, **Chat with File** requires an active file).
- `Mod` means **Cmd** on macOS and **Ctrl** on Windows/Linux.

## Core commands

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Open SystemSculpt Chat |  | Opens the main chat view |
| Open SystemSculpt Chat History |  | Opens the chat history picker/modal |
| Resume Chat from Current History File |  | Only appears when the active file is a chat history file |
| Open SystemSculpt AI Settings |  | Jumps to the plugin’s settings tab |
| Reload Obsidian |  | Reloads the app window |

## Chat + writing

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Change Chat Model (Current Chat) |  | Requires an active SystemSculpt chat view |
| Set Default Chat Model |  | Updates the default model for new chats |
| Change/Generate Title | `Mod`+`Shift`+`T` | Works in chat view or on a Markdown file |
| Open Template Selection |  | Inserts a selected template into the active editor |
| Quick Edit (Active File) |  | Opens the Quick Edit widget for the current file |

## Files + context

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Chat with File |  | Creates a chat preloaded with the active file (supports many file types) |

## Search + Similar Notes (Embeddings)

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Open Similar Notes Panel |  | Opens the Similar Notes view |
| Find Similar Notes (Current Note) |  | Requires an active editor file; opens Similar Notes if embeddings enabled |
| Process Embeddings |  | Informational (processing is automatic) |
| Rebuild Embeddings |  | Clears all embeddings; files will be re-processed |
| Rebuild Embeddings (Current Model) |  | Rebuilds only the current provider/model namespace |
| Show Embeddings Database Statistics (Debug) |  | Only appears when embeddings are enabled |

## Daily Vault

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Open Today's Daily Note |  | Opens (or creates, depending on settings) today's daily note |
| Create Daily Note |  | Forces creation of today’s daily note |
| Open Yesterday's Daily Note |  | Opens yesterday’s note if it exists |
| Start Daily Review |  | Runs the daily review flow |
| Start Weekly Review |  | Runs the weekly review flow |
| View Daily Streak |  | Shows streak stats in a notice |
| Open Daily Vault Settings |  | Focuses the Daily Vault tab inside settings |

## Audio + transcription

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Toggle Audio Recorder | `Mod`+`R` | Starts/stops recording (if enabled/configured) |
| Open Meeting Processor |  | Opens the meeting processing modal |

## Automations

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Run Workflow Automation |  | Runs an automation against the active Markdown note |
| Show Automation Backlog |  | Opens the automation backlog modal |

## Tooling + maintenance

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Open SystemSculpt Search | `Mod`+`K` | Opens SystemSculpt’s search modal |
| Open SystemSculpt Janitor |  | Opens the Janitor modal |
| Open SystemSculpt Benchmark |  | Runs the built-in benchmark UI |
| Open SystemSculpt Benchmark Results |  | Opens the benchmark results viewer |
| YouTube Canvas - Extract transcript and create note |  | Creates a note from a YouTube transcript (language selectable in the modal; generation can be cancelled) |

## Diagnostics (advanced)

| Command | Default hotkey | Notes |
| --- | --- | --- |
| Copy Resource Usage Report |  | Copies a summary (or saves it) under `.systemsculpt/diagnostics` |
| Run Audio Chunking Analysis |  | Developer-oriented analysis tool |
| Toggle Mobile Emulation Mode |  | Developer tool (only works in compatible Obsidian builds) |
