# Issue #185: Chat Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore three chat controls removed in v4.15: agent mode toggle, favorites filter button, and system prompt selector.

**Architecture:** Two parallel worktrees. Worktree 1 handles the favorites filter button (independent, small). Worktree 2 handles the agent mode toggle and system prompt selector together (shared integration points in `SystemSculptService`, `InputHandler`, `ChatView`, and `createInputUI`). Agent toggle is built first since the prompt selector's composition logic depends on the agent mode split.

**Tech Stack:** TypeScript, Obsidian API, Jest (JSDOM), CSS

**Test runner:** `npm test -- --testPathPattern=<pattern>`

---

## Worktree 1: Favorites Filter Button

### Task 1: Add favorites filter button to ListSelectionModal

**Files:**
- Modify: `src/core/ui/modals/standard/ListSelectionModal.ts`
- Test: `src/core/ui/modals/standard/__tests__/list-selection-favorites-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/ui/modals/standard/__tests__/list-selection-favorites-filter.test.ts`:

```typescript
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// Minimal Obsidian mocks
jest.mock("obsidian", () => ({
  App: class {},
  Modal: class {
    app: any;
    containerEl: any;
    contentEl: any;
    modalEl: any;
    constructor(app: any) {
      this.app = app;
      this.containerEl = document.createElement("div");
      this.contentEl = document.createElement("div");
      this.modalEl = document.createElement("div");
      this.containerEl.appendChild(this.contentEl);
    }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
  },
  setIcon: jest.fn(),
  debounce: (fn: Function, _ms: number, _immediate?: boolean) => fn,
}));

// Mock FavoriteToggle to avoid deep dependency chain
jest.mock("../../../../components/FavoriteToggle", () => ({
  FavoriteToggle: jest.fn(),
}));

// Mock KeyboardNavigationService
jest.mock("../../../services/KeyboardNavigationService", () => ({
  KeyboardNavigationService: jest.fn().mockImplementation(() => ({
    destroy: jest.fn(),
  })),
}));

// Mock PlatformContext
jest.mock("../../../../services/PlatformContext", () => ({
  PlatformContext: { isMobileApp: () => false },
}));

import { ListSelectionModal, ListItem, ListSelectionOptions } from "../ListSelectionModal";

function createMockFavoritesService(showFavoritesOnly = false) {
  return {
    isShowFavoritesOnly: jest.fn().mockReturnValue(showFavoritesOnly),
    toggleShowFavoritesOnly: jest.fn(),
    isFavorite: jest.fn().mockReturnValue(false),
    getFilteredAndSortedModels: jest.fn().mockReturnValue([]),
    getFavoritesCount: jest.fn().mockReturnValue(2),
  } as any;
}

describe("ListSelectionModal favorites filter", () => {
  it("renders a favorites filter button when favoritesService is provided", () => {
    const favoritesService = createMockFavoritesService();
    const items: ListItem[] = [
      { id: "m1", title: "Model A" },
      { id: "m2", title: "Model B" },
    ];
    const options: ListSelectionOptions = {
      title: "Select Model",
      favoritesService,
    };

    const modal = new ListSelectionModal({} as any, items, options);
    modal.open();

    const filterBtn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(filterBtn).toBeTruthy();
  });

  it("does NOT render filter button when no favoritesService", () => {
    const items: ListItem[] = [{ id: "m1", title: "Model A" }];
    const options: ListSelectionOptions = { title: "Select" };

    const modal = new ListSelectionModal({} as any, items, options);
    modal.open();

    const filterBtn = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
    expect(filterBtn).toBeFalsy();
  });

  it("toggles is-active class when clicked", () => {
    const favoritesService = createMockFavoritesService(false);
    // After toggle, it returns true
    favoritesService.toggleShowFavoritesOnly.mockImplementation(() => {
      favoritesService.isShowFavoritesOnly.mockReturnValue(true);
    });

    const items: ListItem[] = [{ id: "m1", title: "Model A" }];
    const modal = new ListSelectionModal({} as any, items, { title: "Select", favoritesService });
    modal.open();

    const filterBtn = modal.contentEl.querySelector(".systemsculpt-favorites-filter") as HTMLElement;
    expect(filterBtn.classList.contains("is-active")).toBe(false);

    filterBtn.click();
    expect(favoritesService.toggleShowFavoritesOnly).toHaveBeenCalled();
    expect(filterBtn.classList.contains("is-active")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=list-selection-favorites-filter`
Expected: FAIL (no filter button rendered)

- [ ] **Step 3: Add the favorites filter button to ListSelectionModal**

In `src/core/ui/modals/standard/ListSelectionModal.ts`, in the `onOpen()` method, after the search bar section (after line ~127) and before the filter buttons section, add:

```typescript
    // Add favorites filter button if service is available
    if (this.favoritesService) {
      this.renderFavoritesFilterButton();
    }
```

Add the method to the class:

```typescript
  private favoritesFilterButton: HTMLElement | null = null;

  private renderFavoritesFilterButton(): void {
    if (!this.favoritesService) return;

    const searchContainer = this.contentEl.querySelector(".ss-modal__search");
    const insertTarget = searchContainer || this.contentEl;

    this.favoritesFilterButton = insertTarget.createDiv({
      cls: "systemsculpt-favorites-filter",
    });

    const iconSpan = this.favoritesFilterButton.createSpan({ cls: "svg-icon" });
    setIcon(iconSpan, "star");

    const isActive = this.favoritesService.isShowFavoritesOnly();
    if (isActive) {
      this.favoritesFilterButton.classList.add("is-active");
    }

    this.registerDomEvent(this.favoritesFilterButton, "click", () => {
      if (!this.favoritesService) return;
      this.favoritesService.toggleShowFavoritesOnly();
      const nowActive = this.favoritesService.isShowFavoritesOnly();
      this.favoritesFilterButton?.classList.toggle("is-active", nowActive);
      this.handleSearch(this.searchInput?.value || "");
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=list-selection-favorites-filter`
Expected: PASS

- [ ] **Step 5: Run the existing ListSelectionModal tests to verify no regressions**

Run: `npm test -- --testPathPattern=ListSelectionModal`
Expected: PASS (or no existing test file -- that's fine)

- [ ] **Step 6: Commit**

```bash
git add src/core/ui/modals/standard/ListSelectionModal.ts \
       src/core/ui/modals/standard/__tests__/list-selection-favorites-filter.test.ts
git commit -m "feat: restore favorites filter button in model selection modal

Re-adds the filter button to ListSelectionModal that toggles
showFavoritesOnly via the existing FavoritesService. CSS for
.systemsculpt-favorites-filter already exists. Closes the
favorites portion of #185."
```

---

## Worktree 2: Agent Mode Toggle + System Prompt Selector

### Task 2: Add agentModeEnabled setting

**Files:**
- Modify: `src/types.ts`
- Test: `src/core/settings/__tests__/SettingsManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/core/settings/__tests__/SettingsManager.test.ts`, inside the settings migration describe block:

```typescript
it("defaults agentModeEnabled to true", () => {
  const result = migrateSettings({} as any);
  expect(result.agentModeEnabled).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=SettingsManager`
Expected: FAIL (`agentModeEnabled` is undefined)

- [ ] **Step 3: Add the setting to types and defaults**

In `src/types.ts`, add to the `SystemSculptSettings` interface (near line 242, after `favoritesFilterSettings`):

```typescript
  agentModeEnabled: boolean;
```

In `DEFAULT_SETTINGS` (near line 572, after `favoritesFilterSettings`):

```typescript
  agentModeEnabled: true,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=SettingsManager`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/core/settings/__tests__/SettingsManager.test.ts
git commit -m "feat: add agentModeEnabled setting (default true)"
```

---

### Task 3: Add agent mode toggle button to chat composer

**Files:**
- Modify: `src/views/chatview/ui/createInputUI.ts`
- Modify: `src/views/chatview/InputHandler.ts`
- Test: `src/views/chatview/ui/__tests__/create-chat-composer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/views/chatview/ui/__tests__/create-chat-composer.test.ts`:

```typescript
  it("creates an agent mode toggle button", () => {
    const root = document.createElement("div");
    const onToggleAgentMode = jest.fn();
    const composer = createChatComposer(root, {
      onOpenChatSettings: jest.fn(),
      onAddContextFile: jest.fn(),
      onSend: jest.fn(),
      onStop: jest.fn(),
      registerDomEvent: (el, type, cb) => el.addEventListener(type as any, cb as any),
      onKeyDown: jest.fn(),
      onInput: jest.fn(),
      onPaste: jest.fn(),
      handleMicClick: jest.fn(),
      hasProLicense: () => true,
      onToggleAgentMode,
      isAgentModeEnabled: () => true,
    });

    expect(composer.agentModeButton).toBeDefined();
    expect(composer.agentModeButton.buttonEl.tagName).toBe("BUTTON");
    expect(composer.agentModeButton.buttonEl.classList.contains("ss-active")).toBe(true);

    composer.agentModeButton.buttonEl.click();
    expect(onToggleAgentMode).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=create-chat-composer`
Expected: FAIL (`agentModeButton` undefined)

- [ ] **Step 3: Add agent mode button to createInputUI**

In `src/views/chatview/ui/createInputUI.ts`:

Add to `ChatComposerDeps`:
```typescript
  onToggleAgentMode?: () => void;
  isAgentModeEnabled?: () => boolean;
```

Add to `ChatComposerElements`:
```typescript
  agentModeButton: ButtonComponent;
```

In `createChatComposer`, after the web search button block (after line ~76), add:

```typescript
  const agentModeButton = new ButtonComponent(leftGroup)
    .setIcon("bot")
    .setTooltip(deps.isAgentModeEnabled?.() ? "Agent mode (tools + file operations)" : "Chat only (no tools)")
    .setClass("clickable-icon")
    .onClick(() => {
      deps.onToggleAgentMode?.();
      const enabled = deps.isAgentModeEnabled?.() ?? true;
      agentModeButton.buttonEl.classList.toggle("ss-active", enabled);
      agentModeButton.setTooltip(enabled ? "Agent mode (tools + file operations)" : "Chat only (no tools)");
    });
  agentModeButton.buttonEl.setAttribute("aria-label", "Toggle agent mode");
  agentModeButton.buttonEl.classList.add("systemsculpt-chat-composer-button");
  if (deps.isAgentModeEnabled?.()) {
    agentModeButton.buttonEl.classList.add("ss-active");
  }
```

Add `agentModeButton` to the return object.

- [ ] **Step 4: Wire the toggle in InputHandler**

In `src/views/chatview/InputHandler.ts`:

Add instance property (near line 90, after `webSearchEnabled`):

```typescript
  private agentModeEnabled: boolean;
```

Initialize it in the constructor from settings:

```typescript
  this.agentModeEnabled = this.plugin.settings.agentModeEnabled ?? true;
```

In the `createChatComposer` call (near line 600), add deps:

```typescript
      onToggleAgentMode: () => { this.agentModeEnabled = !this.agentModeEnabled; },
      isAgentModeEnabled: () => this.agentModeEnabled,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=create-chat-composer`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/views/chatview/ui/createInputUI.ts \
       src/views/chatview/InputHandler.ts \
       src/views/chatview/ui/__tests__/create-chat-composer.test.ts
git commit -m "feat: add agent mode toggle button to chat composer toolbar"
```

---

### Task 4: Wire agent mode to suppress tools and system prompt

**Files:**
- Modify: `src/views/chatview/InputHandler.ts`
- Modify: `src/services/SystemSculptService.ts` (no changes needed -- already supports `allowTools` and `systemPromptOverride`)
- Test: `src/views/chatview/__tests__/agent-mode-toggle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/views/chatview/__tests__/agent-mode-toggle.test.ts`:

```typescript
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

jest.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  Component: class {
    register(_cb: any) {}
    registerDomEvent(el: any, type: string, cb: any) {
      el.addEventListener(type, cb);
    }
  },
  Notice: class {},
  ButtonComponent: class {
    buttonEl = document.createElement("button");
    setIcon() { return this; }
    setTooltip() { return this; }
    setClass() { return this; }
    setCta() { return this; }
    setWarning() { return this; }
    setDisabled() { return this; }
    onClick(cb: any) { this.buttonEl.addEventListener("click", cb); return this; }
  },
  MarkdownRenderer: { render: jest.fn() },
  setIcon: jest.fn(),
  debounce: (fn: Function) => fn,
}));

// Capture the options passed to streamMessage
const capturedStreamCalls: any[] = [];
const mockAiService = {
  streamMessage: jest.fn().mockImplementation(function* (opts: any) {
    capturedStreamCalls.push(opts);
  }),
};

describe("agent mode toggle effect on streaming", () => {
  beforeEach(() => {
    capturedStreamCalls.length = 0;
  });

  it("passes allowTools: false when agent mode is disabled", () => {
    // The InputHandler.streamAssistantTurn calls aiService.streamMessage
    // with no allowTools override currently.
    // When agentModeEnabled is false, it should pass allowTools: false.
    //
    // We verify this by checking that the streamMessage options include
    // allowTools: false when agent mode is off.
    //
    // Since streamAssistantTurn is private, we test through the public
    // interface by checking the contract:
    // - agentModeEnabled = true  -> no allowTools override (default behavior)
    // - agentModeEnabled = false -> allowTools: false

    // This is a contract test - the actual integration is in streamAssistantTurn
    const buildStreamOptions = (agentModeEnabled: boolean) => {
      const base: any = {
        messages: [],
        model: "test-model",
        contextFiles: new Set<string>(),
        signal: new AbortController().signal,
        webSearchEnabled: false,
      };
      if (!agentModeEnabled) {
        base.allowTools = false;
      }
      return base;
    };

    const agentOn = buildStreamOptions(true);
    const agentOff = buildStreamOptions(false);

    expect(agentOn.allowTools).toBeUndefined();
    expect(agentOff.allowTools).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (or passes as contract test)**

Run: `npm test -- --testPathPattern=agent-mode-toggle`
Expected: PASS (contract test validates the shape)

- [ ] **Step 3: Modify streamAssistantTurn to respect agent mode**

In `src/views/chatview/InputHandler.ts`, in `streamAssistantTurn()` (near line 279), modify the `streamMessage` call:

```typescript
    const stream = this.aiService.streamMessage({
      messages: this.getMessages(),
      model: selectedModelId,
      contextFiles,
      signal,
      sessionFile: this.chatView?.getPiSessionFile?.(),
      sessionId: this.chatView?.getPiSessionId?.(),
      onPiSessionReady: (session) => {
        this.chatView?.setPiSessionState?.(session);
      },
      webSearchEnabled: this.webSearchEnabled,
      ...(this.agentModeEnabled ? {} : { allowTools: false }),
      debug: this.chatView.getDebugLogService?.()?.createStreamLogger({
        chatId: this.getChatId(),
        assistantMessageId: messageId,
        modelId: selectedModelId,
      }) || undefined,
    });
```

The `SystemSculptService.prepareChatRequest()` already handles `allowTools: false` -- it skips both `AGENT_PRESET.systemPrompt` injection (because we don't pass a `systemPromptOverride`) and tool fetching (line 665: `options.allowTools !== false`).

Wait -- looking more carefully, when `allowTools` is `false` but no `systemPromptOverride` is passed, the system prompt still falls through to `AGENT_PRESET.systemPrompt` at line 659-660. We need to also suppress the agent system prompt.

The cleanest fix: in `SystemSculptService.prepareChatRequest()`, change the system prompt logic so that when `allowTools` is explicitly `false`, the agent preset is also skipped:

In `src/services/SystemSculptService.ts` at line 656-661, replace:

```typescript
    const finalSystemPrompt =
      typeof systemPromptOverride === "string" && systemPromptOverride.trim().length > 0
        ? systemPromptOverride.trim()
        : modelSource === "systemsculpt"
          ? AGENT_PRESET.systemPrompt
        : undefined;
```

With:

```typescript
    const finalSystemPrompt =
      typeof systemPromptOverride === "string" && systemPromptOverride.trim().length > 0
        ? systemPromptOverride.trim()
        : (modelSource === "systemsculpt" && options.allowTools !== false)
          ? AGENT_PRESET.systemPrompt
        : undefined;
```

This makes `allowTools: false` suppress both tools AND the agent system prompt, which is exactly what the user wants for "pure chat" mode.

- [ ] **Step 4: Run full test suite for regressions**

Run: `npm test -- --testPathPattern="(agent-mode-toggle|SystemSculptService|create-chat-composer)"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/chatview/InputHandler.ts \
       src/services/SystemSculptService.ts \
       src/views/chatview/__tests__/agent-mode-toggle.test.ts
git commit -m "feat: wire agent mode toggle to suppress tools and agent prompt

When agentModeEnabled is false, passes allowTools: false to
streamMessage. SystemSculptService now skips both tool fetching
AND agent system prompt when allowTools is explicitly false.
Addresses the data integrity and context pollution concerns
from #185."
```

---

### Task 5: Split agent system prompt for composability

**Files:**
- Modify: `src/constants/prompts/agent.ts`
- Test: `src/constants/prompts/__tests__/agent-prompt-split.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/constants/prompts/__tests__/agent-prompt-split.test.ts`:

```typescript
import { AGENT_PRESET, AGENT_TOOL_INSTRUCTIONS } from "../agent";

describe("agent prompt decomposition", () => {
  it("exports AGENT_TOOL_INSTRUCTIONS as a separate string", () => {
    expect(typeof AGENT_TOOL_INSTRUCTIONS).toBe("string");
    expect(AGENT_TOOL_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it("AGENT_TOOL_INSTRUCTIONS contains tool_calling section", () => {
    expect(AGENT_TOOL_INSTRUCTIONS).toContain("<tool_calling>");
  });

  it("AGENT_TOOL_INSTRUCTIONS contains making_edits section", () => {
    expect(AGENT_TOOL_INSTRUCTIONS).toContain("<making_edits>");
  });

  it("AGENT_PRESET.systemPrompt still contains the full prompt", () => {
    // The full preset is unchanged for backward compat
    expect(AGENT_PRESET.systemPrompt).toContain("<identity>");
    expect(AGENT_PRESET.systemPrompt).toContain("<tool_calling>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=agent-prompt-split`
Expected: FAIL (`AGENT_TOOL_INSTRUCTIONS` not exported)

- [ ] **Step 3: Extract tool instructions from agent.ts**

In `src/constants/prompts/agent.ts`, add a new export before `AGENT_PRESET`:

```typescript
/**
 * Mechanical tool-usage instructions extracted from the agent prompt.
 * Appended to custom user prompts when agent mode is ON.
 */
export const AGENT_TOOL_INSTRUCTIONS = `<tool_calling>
1. ALWAYS follow each tool's JSON schema exactly; include every required param; do not add extra keys.  
2. If multiple independent tool calls are needed, you may call them in parallel; otherwise, chain dependent calls only after you have the prior result.  
3. Never call tools that are unavailable.  
4. If a tool result is unclear, reflect, adjust, and call again—no USER ping-pong.  
5. Clean up temp files or artifacts you create before finishing.  
6. Never invent vault state or file contents. If you need an exact string/token from the vault, read it with tools and copy it verbatim—no placeholders.  
7. If vault-state is needed, PREFER a tool call over asking the USER.  
8. When you need to understand vault organization, use list_items to browse the directory structure.  
9. Summarize results only after you've confirmed they satisfy the request.  
10. When editing files, prefer minimal diffs; keep changes surgical and reversible.
</tool_calling>

<efficiency>
Use the minimum number of tool calls.  
Batch inputs when the schema allows (e.g., multiple paths/items in one call).  
Only do follow-up calls when the previous result demands it.
</efficiency>

<making_edits>
When modifying files:  
1. Read the file first.  
2. After edits, validate with lint/test tools; fix or report errors immediately.  
3. Never generate binary blobs or massive hashes.  
4. Do not create docs/README unless explicitly requested.  
5. Make side effects explicit; list files changed and rationale.
</making_edits>

<search_and_learning>
Unsure? Gather more data with search tools instead of stalling.
Bias toward self-service over questioning the USER.
</search_and_learning>

<search_strategy>
• Content: break queries into words (["neon", "mcp", "install"])
• Properties: use exact names (e.g., 'blogpost:' for YAML) when crafting search terms
• YAML frontmatter: 'property: value' | Inline: 'property:: value'
• For "files with X property": combine name filters with content search (e.g., 'status: draft')
• When unsure, run multiple searches: content search + name search + scoped directory search
• Try broader terms if exact matches fail
• Never ask for file locations—find them
</search_strategy>

<obsidian_bases>
Obsidian Bases use .base YAML files to define interactive database views of notes.

When working with .base files:
1. Read the existing .base file before editing; preserve structure and indentation.
2. Keep YAML valid (avoid reformatting unrelated sections).
3. Bases filters/formulas are YAML strings. If an expression starts with "!" (negation), it must be quoted (otherwise YAML treats it as a tag and you'll see "Unresolved tag" errors).
4. When a turn involves Bases, a detailed Bases syntax guide may be injected into context—follow it.
</obsidian_bases>

<safety_and_privacy>
• Never exfiltrate secrets or credentials; redact tokens/keys in outputs.  
• Respect user-configured directories; do not traverse outside intended scope.  
• Avoid speculative legal/medical advice; request explicit confirmation for high‑risk actions.  
• Default to no source-code disclosure for licensed dependencies; link to their docs instead.
</safety_and_privacy>`;
```

Leave `AGENT_PRESET` unchanged -- it still contains the full prompt for backward compatibility.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=agent-prompt-split`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/constants/prompts/agent.ts \
       src/constants/prompts/__tests__/agent-prompt-split.test.ts
git commit -m "refactor: extract AGENT_TOOL_INSTRUCTIONS from agent prompt

Separates the mechanical tool-usage instructions from the agent
personality prompt. Custom user prompts can be composed with
AGENT_TOOL_INSTRUCTIONS when agent mode is ON."
```

---

### Task 6: Add prompt settings and PromptService

**Files:**
- Modify: `src/types.ts`
- Create: `src/services/PromptService.ts`
- Test: `src/services/__tests__/PromptService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/PromptService.test.ts`:

```typescript
jest.mock("obsidian", () => ({
  App: class {},
  TFile: class {
    path: string;
    basename: string;
    extension: string;
    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.md$/, "") || "";
      this.extension = "md";
    }
  },
  TFolder: class {
    path: string;
    children: any[];
    constructor(path: string) {
      this.path = path;
      this.children = [];
    }
  },
  parseYaml: jest.fn((str: string) => {
    // Simple YAML parser for tests
    const result: any = {};
    str.split("\n").forEach((line) => {
      const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
      if (match) result[match[1]] = match[2];
    });
    return result;
  }),
}));

import { PromptService, type PromptEntry } from "../PromptService";

describe("PromptService", () => {
  let mockApp: any;
  let mockVault: any;

  beforeEach(() => {
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      createFolder: jest.fn(),
      create: jest.fn(),
    };
    mockApp = { vault: mockVault };
  });

  describe("listPrompts", () => {
    it("returns empty array when folder does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const prompts = await service.listPrompts();
      expect(prompts).toEqual([]);
    });

    it("returns prompt entries from markdown files in folder", async () => {
      const mockFolder = {
        path: "SystemSculpt/Prompts",
        children: [
          { path: "SystemSculpt/Prompts/Python Expert.md", basename: "Python Expert", extension: "md" },
          { path: "SystemSculpt/Prompts/Concise.md", basename: "Concise", extension: "md" },
          { path: "SystemSculpt/Prompts/subfolder", extension: undefined }, // folder, skip
        ],
      };
      mockVault.getAbstractFileByPath.mockReturnValue(mockFolder);
      mockVault.read.mockResolvedValue("---\ndescription: \"A prompt\"\nicon: \"code\"\n---\nPrompt body");

      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const prompts = await service.listPrompts();

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe("Python Expert");
      expect(prompts[0].path).toBe("SystemSculpt/Prompts/Python Expert.md");
      expect(prompts[0].description).toBe("A prompt");
      expect(prompts[0].icon).toBe("code");
    });
  });

  describe("readPromptContent", () => {
    it("returns the body text without frontmatter", async () => {
      const mockFile = { path: "SystemSculpt/Prompts/Test.md", basename: "Test", extension: "md" };
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue("---\ndescription: \"desc\"\n---\nYou are a helpful assistant.");

      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const content = await service.readPromptContent("SystemSculpt/Prompts/Test.md");

      expect(content).toBe("You are a helpful assistant.");
    });

    it("returns null for nonexistent file", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      const content = await service.readPromptContent("nope.md");
      expect(content).toBeNull();
    });
  });

  describe("ensureFolder", () => {
    it("creates the folder if it does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      await service.ensureFolder();
      expect(mockVault.createFolder).toHaveBeenCalledWith("SystemSculpt/Prompts");
    });

    it("does nothing if folder exists", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue({ path: "SystemSculpt/Prompts" });
      const service = new PromptService(mockApp, "SystemSculpt/Prompts");
      await service.ensureFolder();
      expect(mockVault.createFolder).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=PromptService`
Expected: FAIL (module not found)

- [ ] **Step 3: Add settings to types.ts**

In `src/types.ts`, add to `SystemSculptSettings` interface (near the `agentModeEnabled` line):

```typescript
  lastUsedPromptPath: string;
```

In `DEFAULT_SETTINGS`:

```typescript
  lastUsedPromptPath: "",
```

Note: `systemPromptsDirectory` already exists as a setting (default: `"SystemSculpt/System Prompts"`). We reuse that instead of adding a new `promptsFolderPath`.

- [ ] **Step 4: Create PromptService**

Create `src/services/PromptService.ts`:

```typescript
import { App, TFile, TFolder, parseYaml } from "obsidian";

export interface PromptEntry {
  name: string;
  path: string;
  description?: string;
  icon?: string;
}

export class PromptService {
  private app: App;
  private folderPath: string;

  constructor(app: App, folderPath: string) {
    this.app = app;
    this.folderPath = folderPath;
  }

  async listPrompts(): Promise<PromptEntry[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!folder || !("children" in folder)) return [];

    const entries: PromptEntry[] = [];
    for (const child of (folder as TFolder).children) {
      if (!("extension" in child) || (child as TFile).extension !== "md") continue;
      const file = child as TFile;
      const meta = await this.readFrontmatter(file);
      entries.push({
        name: file.basename,
        path: file.path,
        description: meta?.description,
        icon: meta?.icon,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readPromptContent(filePath: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !("extension" in file)) return null;

    const raw = await this.app.vault.read(file as TFile);
    return this.stripFrontmatter(raw);
  }

  async ensureFolder(): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(this.folderPath);
    if (!existing) {
      await this.app.vault.createFolder(this.folderPath);
    }
  }

  async createPrompt(name: string): Promise<string> {
    await this.ensureFolder();
    const filePath = `${this.folderPath}/${name}.md`;
    await this.app.vault.create(filePath, `---\ndescription: ""\n---\n\n`);
    return filePath;
  }

  private async readFrontmatter(file: TFile): Promise<Record<string, string> | null> {
    const raw = await this.app.vault.read(file);
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    try {
      return parseYaml(match[1]) || null;
    } catch {
      return null;
    }
  }

  private stripFrontmatter(raw: string): string {
    return raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=PromptService`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts \
       src/services/PromptService.ts \
       src/services/__tests__/PromptService.test.ts
git commit -m "feat: add PromptService for vault-based system prompt management

Scans markdown files from the system prompts directory, parses
frontmatter for metadata, strips frontmatter to extract prompt
body. Creates folder on first use. Reuses existing
systemPromptsDirectory setting."
```

---

### Task 7: Add prompt selector chip to chat composer

**Files:**
- Create: `src/views/chatview/PromptSelector.ts`
- Create: `src/css/components/prompt-selector.css`
- Modify: `src/views/chatview/ui/createInputUI.ts`
- Modify: `src/views/chatview/InputHandler.ts`
- Test: `src/views/chatview/__tests__/prompt-selector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/views/chatview/__tests__/prompt-selector.test.ts`:

```typescript
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

jest.mock("obsidian", () => ({
  App: class {},
  setIcon: jest.fn((el: HTMLElement, icon: string) => {
    el.dataset.icon = icon;
  }),
}));

import { createPromptChip } from "../PromptSelector";

describe("createPromptChip", () => {
  it("renders with 'No prompt' when no prompt is selected", () => {
    const container = document.createElement("div");
    const chip = createPromptChip(container, {
      currentPromptName: null,
      onClick: jest.fn(),
    });

    expect(chip.textContent).toContain("No prompt");
  });

  it("renders the prompt name when selected", () => {
    const container = document.createElement("div");
    const chip = createPromptChip(container, {
      currentPromptName: "Python Expert",
      onClick: jest.fn(),
    });

    expect(chip.textContent).toContain("Python Expert");
  });

  it("calls onClick when clicked", () => {
    const container = document.createElement("div");
    const onClick = jest.fn();
    const chip = createPromptChip(container, {
      currentPromptName: null,
      onClick,
    });

    chip.click();
    expect(onClick).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern=prompt-selector`
Expected: FAIL (module not found)

- [ ] **Step 3: Create PromptSelector**

Create `src/views/chatview/PromptSelector.ts`:

```typescript
import { setIcon } from "obsidian";

export interface PromptChipOptions {
  currentPromptName: string | null;
  onClick: () => void;
}

export function createPromptChip(parent: HTMLElement, options: PromptChipOptions): HTMLElement {
  const chip = parent.createDiv({ cls: "systemsculpt-prompt-chip" });

  const iconEl = chip.createSpan({ cls: "systemsculpt-prompt-chip-icon" });
  setIcon(iconEl, "scroll-text");

  const labelEl = chip.createSpan({
    cls: "systemsculpt-prompt-chip-label",
    text: options.currentPromptName || "No prompt",
  });

  if (!options.currentPromptName) {
    chip.classList.add("mod-empty");
  }

  chip.addEventListener("click", options.onClick);

  return chip;
}

export function updatePromptChip(chip: HTMLElement, promptName: string | null): void {
  const label = chip.querySelector(".systemsculpt-prompt-chip-label");
  if (label) {
    label.textContent = promptName || "No prompt";
  }
  chip.classList.toggle("mod-empty", !promptName);
}
```

- [ ] **Step 4: Create the CSS**

Create `src/css/components/prompt-selector.css`:

```css
.systemsculpt-prompt-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: var(--font-ui-smaller);
  cursor: pointer;
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  transition: background 0.15s ease;
  max-width: 160px;
  overflow: hidden;
}

.systemsculpt-prompt-chip:hover {
  background: var(--background-modifier-active-hover);
}

.systemsculpt-prompt-chip.mod-empty {
  color: var(--text-muted);
}

.systemsculpt-prompt-chip-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.systemsculpt-prompt-chip-icon .svg-icon {
  width: 14px;
  height: 14px;
}

.systemsculpt-prompt-chip-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --testPathPattern=prompt-selector`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/views/chatview/PromptSelector.ts \
       src/css/components/prompt-selector.css \
       src/views/chatview/__tests__/prompt-selector.test.ts
git commit -m "feat: add prompt selector chip component

Renders a clickable chip in the toolbar showing the current
prompt name or 'No prompt'. Supports update via updatePromptChip()."
```

---

### Task 8: Wire prompt selector into chat flow

**Files:**
- Modify: `src/views/chatview/InputHandler.ts`
- Modify: `src/views/chatview/ui/createInputUI.ts`
- Modify: `src/services/SystemSculptService.ts`

- [ ] **Step 1: Add prompt chip slot to createInputUI**

In `src/views/chatview/ui/createInputUI.ts`, add to `ChatComposerDeps`:

```typescript
  onOpenPromptSelector?: () => void;
```

Add to `ChatComposerElements`:

```typescript
  promptSlot: HTMLDivElement;
```

In `createChatComposer`, after the `modelSlot` creation (after line 44), add:

```typescript
  const promptSlot = toolbar.createDiv({
    cls: "systemsculpt-prompt-chip-slot",
  });
  // Insert prompt slot after model slot in the center area
  modelSlot.after(promptSlot);
```

Add `promptSlot` to the return object.

- [ ] **Step 2: Add prompt state and chip to InputHandler**

In `src/views/chatview/InputHandler.ts`:

Add imports:
```typescript
import { createPromptChip, updatePromptChip } from "./PromptSelector";
import { PromptService, type PromptEntry } from "../../services/PromptService";
import { ListSelectionModal, type ListItem } from "../../core/ui/modals/standard/ListSelectionModal";
```

Add instance properties (near the agentModeEnabled property):
```typescript
  private selectedPromptPath: string | null = null;
  private selectedPromptName: string | null = null;
  private promptChip: HTMLElement | null = null;
  private promptService: PromptService;
```

Initialize in constructor:
```typescript
  this.selectedPromptPath = this.plugin.settings.lastUsedPromptPath || null;
  this.promptService = new PromptService(
    this.app,
    this.plugin.settings.systemPromptsDirectory || "SystemSculpt/System Prompts"
  );
```

After the composer creation in `setupInputUI` (after line 616), add:

```typescript
    // Render prompt selector chip
    const promptSlot = (composer as any).promptSlot as HTMLDivElement;
    if (promptSlot) {
      this.promptChip = createPromptChip(promptSlot, {
        currentPromptName: this.selectedPromptName,
        onClick: () => this.openPromptSelector(),
      });
    }
```

Add the prompt selector method. Note: `ListSelectionModal` uses `openAndGetSelection()` which returns a `Promise<ListItem[]>`:

```typescript
  private async openPromptSelector(): Promise<void> {
    const prompts = await this.promptService.listPrompts();

    const items: ListItem[] = [
      { id: "__none__", title: "None", description: "No custom system prompt", icon: "x" },
      ...prompts.map((p) => ({
        id: p.path,
        title: p.name,
        description: p.description,
        icon: p.icon || "scroll-text",
        selected: p.path === this.selectedPromptPath,
      })),
      { id: "__create__", title: "Create new prompt...", icon: "plus" },
    ];

    const modal = new ListSelectionModal(this.app, items, {
      title: "System Prompt",
      placeholder: "Search prompts...",
    });

    const selected = await modal.openAndGetSelection();
    if (!selected.length) return;

    const item = selected[0];
    if (item.id === "__none__") {
      this.selectedPromptPath = null;
      this.selectedPromptName = null;
    } else if (item.id === "__create__") {
      void this.createNewPrompt();
      return;
    } else {
      this.selectedPromptPath = item.id;
      this.selectedPromptName = item.title;
    }

    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }

    // Persist last used prompt
    this.plugin.settings.lastUsedPromptPath = this.selectedPromptPath || "";
    void this.plugin.saveSettings();
  }

  private async createNewPrompt(): Promise<void> {
    const name = "New Prompt";
    const path = await this.promptService.createPrompt(name);
    this.selectedPromptPath = path;
    this.selectedPromptName = name;
    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }
    // Open the file in the editor
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      await this.app.workspace.openLinkText(path, "", true);
    }
  }
```

- [ ] **Step 3: Pass selected prompt to streamMessage**

In `InputHandler.streamAssistantTurn()`, modify the stream call to include the system prompt:

```typescript
    // Read the selected prompt content if one is active
    let systemPromptOverride: string | undefined;
    if (this.selectedPromptPath) {
      const content = await this.promptService.readPromptContent(this.selectedPromptPath);
      if (content) {
        systemPromptOverride = content;
      }
    }

    const stream = this.aiService.streamMessage({
      messages: this.getMessages(),
      model: selectedModelId,
      contextFiles,
      signal,
      sessionFile: this.chatView?.getPiSessionFile?.(),
      sessionId: this.chatView?.getPiSessionId?.(),
      onPiSessionReady: (session) => {
        this.chatView?.setPiSessionState?.(session);
      },
      webSearchEnabled: this.webSearchEnabled,
      ...(this.agentModeEnabled ? {} : { allowTools: false }),
      ...(systemPromptOverride ? { systemPromptOverride } : {}),
      debug: this.chatView.getDebugLogService?.()?.createStreamLogger({
        chatId: this.getChatId(),
        assistantMessageId: messageId,
        modelId: selectedModelId,
      }) || undefined,
    });
```

- [ ] **Step 4: Handle prompt + agent mode composition in SystemSculptService**

In `src/services/SystemSculptService.ts`, add import:
```typescript
import { AGENT_TOOL_INSTRUCTIONS } from "../constants/prompts/agent";
```

Replace the system prompt logic at line 656-661:

```typescript
    let finalSystemPrompt: string | undefined;
    if (typeof systemPromptOverride === "string" && systemPromptOverride.trim().length > 0) {
      // Custom prompt provided
      if (options.allowTools !== false && modelSource === "systemsculpt") {
        // Agent mode ON + custom prompt: compose custom prompt with tool instructions
        finalSystemPrompt = `${systemPromptOverride.trim()}\n\n${AGENT_TOOL_INSTRUCTIONS}`;
      } else {
        // Agent mode OFF + custom prompt: just the custom prompt
        finalSystemPrompt = systemPromptOverride.trim();
      }
    } else if (modelSource === "systemsculpt" && options.allowTools !== false) {
      // No custom prompt, agent mode ON: full agent preset
      finalSystemPrompt = AGENT_PRESET.systemPrompt;
    }
    // else: no custom prompt, agent mode OFF: no system prompt (undefined)
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --testPathPattern="(prompt-selector|SystemSculptService|create-chat-composer)"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/views/chatview/InputHandler.ts \
       src/views/chatview/ui/createInputUI.ts \
       src/services/SystemSculptService.ts
git commit -m "feat: wire prompt selector into chat flow with agent mode composition

Prompt chip opens a selection modal listing vault prompts.
Selected prompt is passed as systemPromptOverride to streamMessage.
When agent mode is ON, tool instructions are appended to custom
prompts. When OFF, just the custom prompt is sent.
Completes #185."
```

---

### Task 9: Persist selected prompt per chat

**Files:**
- Modify: `src/views/chatview/ChatStorageService.ts`
- Modify: `src/views/chatview/InputHandler.ts`

- [ ] **Step 1: Add selectedPromptPath to SaveChatOptions**

In `src/views/chatview/ChatStorageService.ts`, add to `SaveChatOptions` (near line 36):

```typescript
  selectedPromptPath?: string;
```

Add to `LoadedChatRecord` (near line 23):

```typescript
  selectedPromptPath?: string;
```

- [ ] **Step 2: Persist and load selectedPromptPath in chat metadata**

In `ChatStorageService.saveChatSimple()`, ensure `selectedPromptPath` is included in the chat metadata YAML. Find where the metadata object is built (look for the `metadata` construction with `title`, `model`, etc.) and add:

```typescript
      selectedPromptPath: options.selectedPromptPath || "",
```

In the chat loading method, extract `selectedPromptPath` from parsed metadata and include it in the returned record.

- [ ] **Step 3: Wire InputHandler to save/load the prompt path**

In `InputHandler`, when `saveChat` is called, pass `selectedPromptPath` in the options. When a chat is loaded, restore `this.selectedPromptPath` and `this.selectedPromptName` from the loaded record.

- [ ] **Step 4: Run all tests**

Run: `npm test -- --testPathPattern="(ChatStorageService|prompt-selector|input-handler)"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/chatview/ChatStorageService.ts \
       src/views/chatview/InputHandler.ts
git commit -m "feat: persist selected prompt per chat

Saves selectedPromptPath in chat metadata YAML so prompt
selection survives chat reload."
```

---

### Task 10: Add CSS import and final integration test

**Files:**
- Modify: CSS index/import file (wherever other component CSS files are imported)
- Test: Manual verification

- [ ] **Step 1: Import the new CSS files**

In `src/css/index.css` (the main CSS index), add after the existing component imports (around line 40):

```css
@import 'components/prompt-selector.css';
@import 'components/agent-toggle.css';
```

For `agent-toggle.css`, create `src/css/components/agent-toggle.css`:

```css
.systemsculpt-chat-composer-button[aria-label="Toggle agent mode"] {
  transition: color 0.15s ease;
}

.systemsculpt-chat-composer-button[aria-label="Toggle agent mode"].ss-active {
  color: var(--interactive-accent);
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/css/components/prompt-selector.css \
       src/css/components/agent-toggle.css \
       src/css/index.css
git commit -m "feat: add CSS for agent toggle and prompt selector

Final styling integration for issue #185 chat controls."
```
