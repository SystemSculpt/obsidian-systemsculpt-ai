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

SystemSculpt no longer forces a custom top-of-ribbon cluster or divider. Obsidian keeps control of ribbon placement, and you can still hide or reorder icons with the app's standard ribbon controls.
