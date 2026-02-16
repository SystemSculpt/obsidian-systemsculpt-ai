# Commands and hotkeys

Source of truth:

- `src/core/plugin/commands.ts`
- `src/main.ts` (additional diagnostics/search commands)

`Mod` means `Cmd` on macOS and `Ctrl` on Windows/Linux.

## Core and navigation

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Chat |  | `open-systemsculpt-chat` | Opens a new chat view |
| Open SystemSculpt Chat History |  | `open-chat-history` | Opens chat history modal |
| Resume Chat from Current History File |  | `resume-chat-from-history` | Only when active file is a chat history file |
| Open SystemSculpt AI Settings |  | `open-systemsculpt-settings` | Opens plugin settings tab |
| Open Credits & Usage |  | `open-credits-balance` | Opens the credits/usage modal |
| Reload Obsidian |  | `reload-obsidian` | Reloads app window |

## Chat and writing

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Change Chat Model (Current Chat) |  | `change-chat-model` | Requires active SystemSculpt chat view |
| Set Default Chat Model |  | `set-default-chat-model` | Sets default model for new chats |
| Change/Generate Title | `Mod+Shift+T` | `change-chat-title` | Works in chat and markdown notes |
| Open Template Selection |  | `open-template-modal` | Inserts a template into active editor |
| Quick Edit (Active File) |  | `quick-file-edit` | Opens Quick Edit widget |
| Chat with File |  | `chat-with-file` | Opens chat with current file preloaded |

## Search and embeddings

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Search | `Mod+K` | `open-systemsculpt-search` | Opens search modal |
| Open Similar Notes Panel |  | `open-embeddings-view` | Opens embeddings/similar-notes view |
| Find Similar Notes (Current Note) |  | `find-similar-current-note` | Added in `src/main.ts`; requires active note |
| Process Embeddings |  | `process-embeddings` | Informational; processing is automatic |
| Rebuild Embeddings |  | `rebuild-embeddings` | Clears all embeddings data |
| Rebuild Embeddings (Current Model) |  | `rebuild-embeddings-current-model` | Rebuilds only current provider/model namespace |
| Show Embeddings Database Statistics (Debug) |  | `embeddings-database-stats` | Visible only when embeddings are enabled |

## Daily Vault

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open Today's Daily Note |  | `daily-vault-open-today` | Opens/creates today's note per settings |
| Create Daily Note |  | `daily-vault-create-note` | Forces creation flow |
| Open Yesterday's Daily Note |  | `daily-vault-open-yesterday` | Opens yesterday when available |
| Start Daily Review |  | `daily-vault-start-daily-review` | Starts daily review flow |
| Start Weekly Review |  | `daily-vault-start-weekly-review` | Starts weekly review flow |
| View Daily Streak |  | `daily-vault-view-streak` | Shows streak summary |
| Open Daily Vault Settings |  | `daily-vault-open-settings` | Focuses Daily Vault tab |

## Audio and media

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Toggle Audio Recorder | `Mod+R` | `toggle-audio-recorder` | Starts/stops recording |
| Open Meeting Processor |  | `open-meeting-processor` | Opens meeting processor modal |
| YouTube Canvas - Extract transcript and create note |  | `open-youtube-canvas` | Opens YouTube Canvas modal |
| Run Audio Chunking Analysis |  | `audio-chunking-analysis` | Developer-facing analysis command |

## Automations and SystemSculpt Canvas

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Run Workflow Automation |  | `run-workflow-automation` | Runs automation for active markdown note |
| Show Automation Backlog |  | `open-automation-backlog` | Opens automation backlog modal |
| SystemSculpt - Create Prompt Node (Active Canvas) |  | `canvasflow-create-prompt-node` | Only when active view is Canvas |
| SystemSculpt - Toggle Canvas Enhancements |  | `canvasflow-toggle-enhancements` | Toggles SystemSculpt canvas enhancement mode |

## Benchmark and diagnostics

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Benchmark |  | `open-systemsculpt-benchmark` | Opens benchmark runner view |
| Open SystemSculpt Benchmark Results |  | `open-systemsculpt-benchmark-results` | Opens leaderboard/results view |
| Open SystemSculpt Janitor |  | `open-systemsculpt-janitor` | Opens janitor modal |
| Copy Resource Usage Report |  | `systemsculpt-copy-resource-report` | Copies/saves resource report |
| Toggle Mobile Emulation Mode |  | `toggle-mobile-emulation` | Developer tool for supported builds |
