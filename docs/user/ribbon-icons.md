# Ribbon icons

Source of truth: `src/core/plugin/ribbons.ts`.

SystemSculpt adds the following ribbon actions in this order:

| Icon name | Ribbon action label | Behavior |
| --- | --- | --- |
| `youtube` | YouTube Canvas | Opens YouTube Canvas modal |
| `file-audio` | Process Meeting Audio | Opens meeting processor modal |
| `mic` | Audio Recorder | Toggles the recorder |
| `search` | Open SystemSculpt Search | Opens search modal |
| `trash` | Open SystemSculpt Janitor | Opens janitor modal |
| `history` | Open SystemSculpt History | Opens unified history modal |
| `message-square` | Open SystemSculpt Chat | Opens a new chat view |
| `network` | Open Similar Notes Panel | Opens Similar Notes view |

The first seven actions are kept together at the very top of the left ribbon so the main SystemSculpt tools stay in one contiguous block.
A subtle divider separates that block from the rest of the ribbon.

You can still hide or reorder ribbon icons with Obsidian's standard ribbon controls.
