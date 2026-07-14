# Ribbon icons

Source of truth: `src/core/plugin/ribbons.ts`.

SystemSculpt adds the following ribbon actions in this order:

| Icon name | Ribbon action label | Behavior |
| --- | --- | --- |
| `mic` | Audio Recorder | Toggles the recorder |
| `search` | Open search | Opens vault search |
| `trash` | Open janitor | Opens vault cleanup |
| `history` | Open history | Opens chat and Studio history |
| `message-square` | Open chat | Opens a new chat |
| `network` | Open Similar Notes Panel | Opens Similar Notes |

SystemSculpt no longer forces a custom top-of-ribbon cluster or divider. Obsidian keeps control of ribbon placement, and you can still hide or reorder icons with the app's standard ribbon controls.
