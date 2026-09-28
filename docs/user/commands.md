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
| Copy Vault-Relative File Path |  | `copy-current-file-path` | Copies the focused note or Studio file's path relative to the vault, with a success notice; assign a shortcut in Obsidian Hotkeys |

## Chat and writing

Chat always runs through SystemSculpt. There are no separate chat-model commands in the plugin.

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Create Title from Content | `Mod+Shift+T` | `change-chat-title` | Works in chat and markdown notes |
| Chat with File |  | `chat-with-file` | Opens chat with current file preloaded |

## Search and embeddings

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Search | `Mod+K` | `open-systemsculpt-search` | Searches notes, canvases, and Studio projects; an empty query shows recently modified files |
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
| Open audio processor |  | `open-audio-processor` | Processes audio or YouTube into a detailed note, meeting brief, or clean transcript |
| Process YouTube video |  | `process-youtube-video` | Opens Audio Processor on the YouTube input |
| Save audio summary |  | `save-audio-summary` | Creates or opens a summary-only note for detailed and meeting brief outputs |
| Save audio transcript |  | `save-audio-transcript` | Opens or restores the linked transcript for the active Audio Processor note |

## Studio

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| New SystemSculpt Studio Project |  | `new-systemsculpt-studio-project` | Creates a new `.systemsculpt` project and opens Studio |
| Open SystemSculpt Studio |  | `open-systemsculpt-studio` | Opens the current/first available `.systemsculpt` project in Studio, or creates one automatically when none exists |
| Run Current SystemSculpt Studio Project |  | `run-systemsculpt-studio-project` | Runs the active/current Studio project |
| SystemSculpt Studio: Fit Selection in Viewport |  | `fit-systemsculpt-studio-selection-in-viewport` | Frames selected Studio nodes |
| SystemSculpt Studio: Overview Graph in Viewport |  | `overview-systemsculpt-studio-graph-in-viewport` | Frames the full Studio graph |

While the Studio canvas is active:

- `Shift+C` or `S` selects the pointer tool; `B` draws a box, `C` draws a circle, and `A`
  draws a visual arrow. `Escape` returns to the pointer. The same tools are
  available in the canvas toolbar.
- With the arrow tool, drag from a node or shape onto another node or shape.
  These arrows are visual annotations and do not pass data or affect execution.
- `Mod+F` fits the selected nodes, or the whole graph when nothing is selected.
- `Mod+A` selects all cards and shapes. Placement is manual. While dragging,
  alignment guides and pixel distances help you line things up. Dragging within 5 screen pixels of an edge or center gently snaps the selection into alignment.
- `Shift+wheel` scrolls horizontally. An unmodified wheel scrolls vertically;
  trackpad horizontal scrolling and `Mod+wheel` zoom also remain available.

Text fields and embedded editors keep their normal Find and Select All shortcuts
and native scrolling. `Mod+Shift+1` also fits selected nodes, including while
editing a field. Dialogs, menus, and other panels opened over the canvas keep
their own keys and pastes: `Delete`, `Backspace`, and the tool keys pressed
there never change the canvas.

## Diagnostics

| Command | Default hotkey | Command ID | Notes |
| --- | --- | --- | --- |
| Open SystemSculpt Janitor |  | `open-systemsculpt-janitor` | Reviews cleanup candidates before moving them to Trash |
| Copy Resource Usage Report |  | `systemsculpt-copy-resource-report` | Copies/saves resource report |

### Studio cards

Each card shows one thing. An image or video card is the media itself, with its actions beneath it. A text card is Markdown you edit in place. Script, JSON, value, process and command cards show their source: use **Edit source**, then **Apply** (Cmd/Ctrl+Enter) to save. Apply never runs a node. Image generation, video generation, text generation and Codex cards show their fields as controls with the result beneath. Collections, run boards, buttons, command centers and workflows show their panel, with a **Source** toggle in the title bar for the definition. Invalid edits stay in the editor; if an agent changes the same source, Studio retains your draft and asks you to reload.

Adding a node with the **Add** button places it to the right of the selected node, or in the centre of the current view when nothing is selected, and never on top of an existing card. Right-click on the canvas still adds the node where you clicked. Ordinary cards stay where you place them, including after content edits and resizing. Generated image/video cards collect in their producer’s **Outputs** container, initially to its right. Each run adds cards to a three-column grid; only the contents of that container arrange automatically. Move the container as a unit to keep later results in the same place.

**Run** on a card runs only that card. Whatever is already connected to it is used as-is: a generated image feeding a video card is not regenerated, and a generation that has never run stops the run with a message naming the card to run first. Cards that only transform their inputs (text, values, media paths) refresh automatically when their inputs changed. The toolbar **Run** still runs the whole graph.

Image and video generation cards choose their model in a catalog window: click the model field to search every available model with its price, what it accepts as input, and a star to favorite it. Favorites stay at the top of that picker. The card then shows only the inputs and options that model supports. Reference images are limited to four per job, or fewer when the model requires it; the picker and card show this effective limit. A run stops early if it is given too many reference images or a frame it cannot take.

A **Video generation** card needs a model and a prompt, and accepts optional first and last frame images when the model supports them. Duration, resolution, aspect ratio and audio follow the chosen model; a **Generating video…** card appears while the clip renders and becomes the video once it is saved.

Add a **Script** node for JavaScript with typed connections. The starter module exports a function receiving `inputs` and `context`, and returns output values. The opening `studio` comment declares ports and runtime settings. Scripts run through an approved local Node executable on desktop. JSON and Markdown data have their own source editors; existing typed actions use YAML definitions. Live collection data continues updating in Result.

Click an empty part of a group's colored background to select its frame, then press **Cmd/Ctrl+F** to fit the whole group and its label. The selected group has a solid outline. Dragging the background still moves the group; node controls and source editors remain independently interactive. Keyboard users can focus a group and press Enter or Space to select it.

Janitor only applies the reviewed files. Files changed, moved, replaced, or added after review are preserved. Audio cleanup keeps transcripts, and notes containing frontmatter are not treated as empty.
