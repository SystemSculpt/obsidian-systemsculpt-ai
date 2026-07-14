# SystemSculpt Obsidian Plugin

SystemSculpt gives people an agent workspace, semantic vault context, media tools, and visual workflows inside their Obsidian vault. These terms name the product surfaces that the plugin architecture must keep coherent.

## Language

**Plugin surface**:
Any SystemSculpt-owned interface rendered inside Obsidian, including views, settings, modals, floating panels, status items, and injected actions.
_Avoid_: Screen, page, widget

**Agent workspace**:
The conversational workspace where a person gives SystemSculpt tasks, reviews streamed work, approves vault actions, and manages context and attachments.
_Avoid_: ChatView, chat screen

**Studio**:
The visual workspace where a person composes and runs connected vault, media, and generation operations.
_Avoid_: Canvas editor, graph screen

**Similar notes**:
The semantic vault view that relates the active note or agent conversation to relevant notes.
_Avoid_: Embeddings sidebar, vector search panel

**Janitor**:
The review-first workflow for finding and removing empty or generated SystemSculpt vault content.
_Avoid_: Cleanup modal, delete tool

**Settings**:
The SystemSculpt configuration experience embedded in Obsidian's settings window.
_Avoid_: Preferences page, options screen

**Transient surface**:
A short-lived SystemSculpt interface that appears above a workspace, such as a modal, menu, popover, progress panel, or recorder panel.
_Avoid_: Overlay widget, popup component

**Vault action approval**:
The user decision that authorizes a proposed mutation to vault content for one action, the current conversation, or all actions.
_Avoid_: Tool permission, MCP approval
