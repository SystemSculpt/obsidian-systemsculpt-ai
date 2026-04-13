# Claude PR Review Regressions

- Watch for Obsidian lifecycle leaks where commands, views, intervals, event refs, MCP connections, or DOM listeners are not released in `onunload`.
- Watch for desktop/mobile separation regressions where MCP transport, bridge code, or unsupported APIs become reachable on mobile.
- Watch for vault-data handling changes that send chat, embedding, or note content to new surfaces without explicit user control.
