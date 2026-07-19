# Commands and hotkeys

Source of truth:

- `src/core/plugin/commands.ts`
- `src/main.ts` (additional diagnostics/search commands)

`Mod` means `Cmd` on macOS and `Ctrl` on Windows/Linux.

## Core and navigation

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Chat |  | `open-systemsculpt-chat` | Opens a new chat view |
| Open SystemSculpt History |  | `open-systemsculpt-history` | Opens unified history modal (Chats + Studio sessions) |
| Resume Chat from Current History File |  | `resume-chat-from-history` | Only when active file is a chat history file |
| Open SystemSculpt AI Settings |  | `open-systemsculpt-settings` | Opens plugin settings tab |
| Open Credits & Usage |  | `open-credits-balance` | Opens the credits/usage modal |
| Reload Obsidian |  | `reload-obsidian` | Reloads app window |
| Copy Current File Path | `Mod+Shift+C` | `copy-current-file-path` | Copies the full filesystem path on desktop and the vault-relative path on mobile for the focused vault-backed tab |

## Chat and writing

Chat always runs through SystemSculpt. There are no separate chat-model commands in the plugin.

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Create Title from Content | `Mod+Shift+T` | `change-chat-title` | Works in chat and markdown notes |
| Chat with File |  | `chat-with-file` | Opens chat with current file preloaded |

## Search and embeddings

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Search | `Mod+K` | `open-systemsculpt-search` | Opens search modal |
| Open Similar Notes Panel |  | `open-embeddings-view` | Opens embeddings/similar-notes view |
| Find Similar Notes (Current Note) |  | `find-similar-current-note` | Added in `src/main.ts`; requires active note |
| Rebuild Embeddings |  | `rebuild-embeddings` | Clears all embeddings data |
| Rebuild SystemSculpt Embeddings |  | `rebuild-embeddings-current-model` | Rebuilds the current SystemSculpt embeddings index |
| Show Embeddings Database Statistics (Debug) |  | `embeddings-database-stats` | Visible only when embeddings are enabled |

## Audio and media

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Toggle Audio Recorder |  | `toggle-audio-recorder` | Starts/stops recording |
| Transcribe an audio file |  | `transcribe-audio-file` | Transcribes a vault audio file through SystemSculpt |
| Open audio processor |  | `open-audio-processor` | Creates a structured audio note and linked timestamped transcript |
| Process YouTube video |  | `process-youtube-video` | Opens Audio Processor on the YouTube input |
| Save audio summary |  | `save-audio-summary` | Creates or opens an optional summary-only note for the active Audio Processor note |
| Save audio transcript |  | `save-audio-transcript` | Opens or restores the linked transcript for the active Audio Processor note |

## Studio

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| New SystemSculpt Studio Project |  | `new-systemsculpt-studio-project` | Creates a new `.systemsculpt` project and opens Studio |
| Open SystemSculpt Studio |  | `open-systemsculpt-studio` | Opens the current/first available `.systemsculpt` project in Studio, or creates one automatically when none exists |
| Run Current SystemSculpt Studio Project |  | `run-systemsculpt-studio-project` | Runs the active/current Studio project |
| SystemSculpt Studio: Fit Selection in Viewport |  | `fit-systemsculpt-studio-selection-in-viewport` | Frames selected Studio nodes |
| SystemSculpt Studio: Overview Graph in Viewport |  | `overview-systemsculpt-studio-graph-in-viewport` | Frames the full Studio graph |

## Diagnostics

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Janitor |  | `open-systemsculpt-janitor` | Opens janitor modal |
| Copy Resource Usage Report |  | `systemsculpt-copy-resource-report` | Copies/saves resource report |
