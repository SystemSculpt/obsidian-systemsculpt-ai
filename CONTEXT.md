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
The user decision that authorizes a managed local tool's proposed mutation to vault content for one action, the current conversation, or all actions.
_Avoid_: Tool permission, MCP approval

**Inbox transcription**:
The automatic transcription of new audio files admitted from a configured vault folder, with confirmation for bulk arrivals.
_Avoid_: Workflow engine, Command Center workflow

## Conversations and execution

**Execution backend**:
The selected system that performs a text task: SystemSculpt API or on-machine Codex.
_Avoid_: Provider, model

**Managed execution**:
Work performed by the SystemSculpt service, including its conversation history, generation jobs, and billing.
_Avoid_: Local agent, client agent loop

**Native Codex execution**:
Work performed by the installed Codex using the machine's existing login, native threads, tools, and permission policy.
_Avoid_: Managed execution, plugin agent runtime

**Conversation**:
An ordered history of user requests and agent activity owned by the selected execution backend.
_Avoid_: Transcript, leaf

**Turn**:
One submitted user request and the activity it produces within a conversation.
_Avoid_: Conversation, Studio run

**Chat session**:
The plugin's live connection to one conversation, including its observable state and pending user approvals.
_Avoid_: Authoritative history, saved chat

**Transcript**:
A local readable copy or user export of conversation messages; it does not authorize execution or replace the backend's history.
_Avoid_: Session authority, event journal

**Local tool**:
A supported Obsidian action requested by managed execution and carried out by the plugin under the user's vault action approval policy.
_Avoid_: Agent loop, server tool

**Mutation receipt**:
A durable record of a local tool mutation's claimed or completed outcome, used to prevent duplicate changes after reconnection.
_Avoid_: Permission grant, cached response

## Studio

**Project**:
A saved Studio composition with authored canvas content, supporting assets, permissions, and run history.
_Avoid_: Workspace, workflow

**Project session**:
The shared editable state of one open project, including pending edits across its open views.
_Avoid_: View, run

**Node**:
A configured operation or content item in a Studio project; a card is its visible presentation.
_Avoid_: Run instance, workflow step

**Execution edge**:
A directed connection from one node's output port to another node's input port, supplying data and execution dependencies.
_Avoid_: Arrow, parent link

**Diagram arrow**:
A visual relationship drawn on the canvas that does not establish an execution dependency.
_Avoid_: Execution edge, wire

**Parent link**:
An organizational relationship between nodes, independent of execution dependencies.
_Avoid_: Input, execution edge

**Studio run**:
An explicit execution of a selected scope against a fixed project snapshot, with recorded node results and status.
_Avoid_: Conversation, native run

**Native run**:
An independent instance of a Studio Codex task, associated with its own native thread and projected public activity.
_Avoid_: Node definition, Studio run

**Command Center workflow**:
An owner-started objective with a Codex-authored plan, child assignments, and an explicitly declared outcome.
_Avoid_: Ordinary native run, automatic continuation

**Managed output**:
A generated Studio result placed on the canvas with its producing node and run identity.
_Avoid_: Source node, input attachment

**Recovery snapshot**:
A preserved project version that keeps otherwise conflicting or interrupted edits recoverable.
_Avoid_: Latest project, execution authority
