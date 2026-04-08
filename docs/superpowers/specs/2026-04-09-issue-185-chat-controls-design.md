# Issue #185: Restore Chat Controls -- Agent Toggle, Favorites Filter, Prompt Selector

**Date:** 2026-04-09
**Issue:** [#185](https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/185)
**Branch strategy:** Two parallel worktrees
- Worktree 1: Favorites filter (independent, small)
- Worktree 2: Agent mode toggle + system prompt selector (shared integration points)

---

## Feature 1: Agent Mode Toggle

### Setting

New boolean `agentModeEnabled` in `SystemSculptSettings`, default `true` (preserves current behavior).

### UI

Toggle button in the chat composer toolbar's left group (alongside attach and web search buttons). Uses a Lucide icon (e.g. `bot` or `wand`). Active state styled with the existing `ss-active` class pattern.

- Tooltip when ON: "Agent mode (tools + file operations)"
- Tooltip when OFF: "Chat only (no tools)"

### Behavior when OFF

- `SystemSculptService.prepareChatRequest()` (~line 656): skip `AGENT_PRESET.systemPrompt`, pass `undefined` instead
- Same function (~line 664): skip tool fetching, leave `tools = []`
- Both paths already support this -- `systemPromptOverride` and `allowTools` params exist in the API

### Per-chat state

Toggle state lives on `ChatView` as instance state (like `webSearchEnabled`). Switching mid-conversation is immediate. The global default comes from settings.

### Files touched

| File | Change |
|------|--------|
| `src/types.ts` | Add `agentModeEnabled: boolean` to settings, default `true` |
| `src/views/chatview/ui/createInputUI.ts` | Add toggle button to left group, add to `ChatComposerDeps` and `ChatComposerElements` |
| `src/views/chatview/InputHandler.ts` | Pass `allowTools: false` and no system prompt override when agent mode is off |
| `src/views/chatview/ChatView.ts` | Add `agentModeEnabled` instance property |
| `src/css/components/agent-toggle.css` | Active/inactive state styling, reuse `ss-active` pattern |

---

## Feature 2: Favorites Filter Button

### What exists

`FavoritesService` has:
- `toggleShowFavoritesOnly()` / `isShowFavoritesOnly()`
- `toggleFavoritesFirst()`
- Emits `systemsculpt:favorites-filter-changed` events
- `getFilteredAndSortedModels()`

`ListSelectionModal` already imports `FavoritesService` and uses `FavoriteToggle` for individual model stars. CSS for `.systemsculpt-favorites-filter` and `.is-active` already exists.

### What to add

Filter button in `ListSelectionModal`'s header/toolbar area:
- Star icon with label or count
- Toggles `showFavoritesOnly` via the existing service
- Applies `.is-active` class when filtering is on (CSS exists)
- Listens for `systemsculpt:favorites-filter-changed` to stay synced
- Re-filters the rendered list by calling `getFilteredAndSortedModels()`

### Files touched

| File | Change |
|------|--------|
| `src/core/ui/modals/standard/ListSelectionModal.ts` | Add filter button, wire to service, re-filter on toggle |

No new files, no new CSS, no new types.

---

## Feature 3: System Prompt Selector

### Core concept

System prompts are markdown files in the vault. The selector is a first-class UI element in the chat composer, orthogonal to agent mode.

### Storage

Prompts live as `.md` files in a configurable vault folder (default: `SystemSculpt/Prompts/`). Users edit them with Obsidian's full editor, organize with subfolders.

Example structure:
```
SystemSculpt/Prompts/
  Python Expert.md
  Legal Reviewer.md
  Concise.md
```

Optional frontmatter for metadata:
```yaml
---
description: "Specialized for Python code review and debugging"
icon: "code"
---
```

The body of the file is the system prompt text.

### Folder lifecycle

`PromptService` creates the prompts folder on first access if it doesn't exist. The selection modal shows an empty state ("No prompts yet -- create one to get started") when the folder is empty.

### Interaction with agent mode

The two features are orthogonal layers:
- **Custom prompt** = personality/instructions layer
- **Agent mode** = tools layer

| Agent Mode | Custom Prompt | System Prompt Sent |
|---|---|---|
| ON | None | `AGENT_PRESET.systemPrompt` (current behavior) |
| ON | Selected | Custom prompt + agent tool-usage instructions appended |
| OFF | None | No system prompt (pure chat) |
| OFF | Selected | Custom prompt only |

When both are active, the custom prompt replaces the agent's personality section but the mechanical tool-usage instructions are appended so tools still function correctly.

### UI

**Prompt indicator chip** in the chat composer toolbar center area (near the model indicator). Shows the current prompt name or "No prompt" when none selected. Clicking opens the selection modal.

The modal uses the existing `ListSelectionModal` pattern:
- **"None"** option at top -- clears custom prompt
- **Vault prompts** -- scanned from the prompts folder, filename as title, frontmatter `description` as subtitle
- **"Create new prompt"** action at bottom -- creates a new `.md` file and opens it in editor

### Per-chat state

Selected prompt path is stored per-chat (persisted in `ChatStorageService`). Switching prompts mid-conversation takes effect on the next message. New chats inherit the last-used prompt as default (stored in settings as `lastUsedPromptPath`).

### New files

| File | Purpose |
|------|---------|
| `src/services/PromptService.ts` | Scan prompts folder, read/parse prompt files, provide prompt list |
| `src/views/chatview/PromptSelector.ts` | Chip UI + modal opening logic |
| `src/css/components/prompt-selector.css` | Styling for the prompt chip |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Add `promptsFolderPath: string` and `lastUsedPromptPath: string` to settings |
| `src/views/chatview/ChatView.ts` | Add `selectedPromptPath` instance property |
| `src/views/chatview/ui/createInputUI.ts` | Add prompt chip slot to toolbar center |
| `src/views/chatview/InputHandler.ts` | Read selected prompt, pass as `systemPromptOverride` |
| `src/services/SystemSculptService.ts` | Handle composition logic (custom prompt + agent instructions when both active) |
| `src/views/chatview/ChatStorageService.ts` | Persist selected prompt path per chat |

---

## Agent system prompt decomposition

To support the composable prompt + agent mode design, the current monolithic `AGENT_PRESET.systemPrompt` in `src/constants/prompts/agent.ts` needs to be split into two parts:

1. **Personality section** -- the identity, communication style, scope instructions. This is what gets replaced by a custom prompt.
2. **Tool-usage section** -- the mechanical instructions for how to format tool calls, handle file operations, etc. This always gets appended when agent mode is ON, regardless of custom prompt.

This split happens in `SystemSculptService.prepareChatRequest()` at the composition point.
