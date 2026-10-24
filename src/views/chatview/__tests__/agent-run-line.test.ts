/** @jest-environment jsdom */

import { Menu } from "obsidian";
import { AgentRunLine, returnFocusAfterMenu, type AgentRunLineOptions } from "../AgentRunLine";
import type { AgentChromeState } from "../AgentChatChrome";

type MockMenu = Menu & {
  items: Array<{ title?: string; checked?: boolean | null; disabled?: boolean; isLabel?: boolean; separator?: boolean }>;
  shown: boolean;
  select: (title: string) => unknown;
  hide: () => unknown;
};

const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;

function state(overrides: Partial<AgentChromeState> = {}): AgentChromeState {
  return {
    backend: "claude",
    localAgents: true,
    host: "Mac",
    detecting: false,
    detection: {
      preferred: "claude",
      agents: {
        claude: { installed: true, signedIn: true, recentSessionCount: 2, lastUsed: 10 },
        codex: { installed: true, signedIn: true, recentSessionCount: 0, lastUsed: null },
      },
    },
    chosen: false,
    prefersLocalAgent: false,
    account: "signed-out",
    credits: null,
    hostedMode: "auto",
    claude: { mode: "auto", model: "", autoUnavailable: false },
    codex: { mode: "auto", model: "gpt-6.1", effort: "high", serviceTier: "default", autoUnavailable: false, models: null },
    hasMessages: false,
    running: false,
    activeNote: null,
    switchedFrom: null,
    usedInVault: new Set(),
    ...overrides,
  };
}

function mount(overrides: Partial<AgentRunLineOptions> = {}) {
  const parent = document.body.createDiv();
  const options: AgentRunLineOptions = {
    onSelectBackend: jest.fn(),
    onSelectMode: jest.fn(),
    onModelChange: jest.fn(),
    onDetectAgain: jest.fn(),
    onOpenSettings: jest.fn(),
    onAction: jest.fn(),
    onModelMenuOpen: jest.fn(),
    ...overrides,
  };
  const line = new AgentRunLine(parent, options);
  line.load();
  return { parent, line, options };
}

const segment = (parent: HTMLElement, key: string) =>
  parent.querySelector<HTMLButtonElement>(`[data-testid="chat.run.${key}"]`)!;

describe("AgentRunLine", () => {
  beforeEach(() => {
    document.body.empty();
    menus().length = 0;
  });

  it("is one toolbar of labelled menu buttons with a single Tab stop", () => {
    const { parent, line } = mount();
    line.render(state());
    const toolbar = parent.querySelector<HTMLElement>('[data-testid="chat.run"]')!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Chat run settings");
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Claude Code on this Mac", "Auto", "Default"]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    expect(buttons.every((button) => button.getAttribute("aria-haspopup") === "menu")).toBe(true);
    // The narrow form hides only the suffix (container query).
    expect(toolbar.querySelector(".systemsculpt-agent-run-wide")?.textContent).toBe(" on this Mac");
    expect(segment(parent, "mode").dataset.mode).toBe("auto");
    line.unload();
  });

  it("moves between segments with the arrow keys", () => {
    const { parent, line } = mount();
    line.render(state());
    const backend = segment(parent, "backend");
    backend.focus();
    backend.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(segment(parent, "mode"));
    expect(segment(parent, "mode").tabIndex).toBe(0);
    expect(backend.tabIndex).toBe(-1);
    segment(parent, "mode").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(segment(parent, "detail"));
    segment(parent, "detail").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(backend);
    line.unload();
  });

  it("opens each menu in one click as a DOM menu and routes the choice", () => {
    const { parent, line, options } = mount();
    line.render(state());

    segment(parent, "backend").click();
    let menu = menus().at(-1)!;
    expect(menu.shown).toBe(true);
    expect(segment(parent, "backend").getAttribute("aria-expanded")).toBe("true");
    expect(menu.items.filter((item) => item.isLabel).map((item) => item.title)).toEqual(["On this Mac", "Hosted"]);
    expect(menu.items.find((item) => item.title === "Claude CodeReady · used most")?.checked).toBe(true);
    menu.select("CodexReady");
    expect(options.onSelectBackend).toHaveBeenCalledWith("codex");
    expect(segment(parent, "backend").getAttribute("aria-expanded")).toBe("false");

    segment(parent, "backend").click();
    menus().at(-1)!.select("Detect again");
    expect(options.onDetectAgain).toHaveBeenCalledTimes(1);

    segment(parent, "mode").click();
    menu = menus().at(-1)!;
    expect(menu.items.map((item) => item.title)).toEqual([
      "AutoRuns safe actions without asking. Claude Code's safety check blocks risky ones.",
      "Ask before editsAsks before every edit and command.",
      "Accept editsEdits notes without asking. Asks before commands.",
      "Plan onlyReads and plans. Changes nothing until you approve the plan.",
      "Claude Code settingsUses the permission rules in your Claude Code settings.",
    ]);
    menu.select("Plan onlyReads and plans. Changes nothing until you approve the plan.");
    expect(options.onSelectMode).toHaveBeenCalledWith("plan");

    segment(parent, "detail").click();
    expect(options.onModelMenuOpen).toHaveBeenCalledTimes(1);
    menus().at(-1)!.select("Opus");
    expect(options.onModelChange).toHaveBeenCalledWith("model:opus");
    line.unload();
  });

  it("returns focus to the segment that opened a menu", () => {
    jest.useFakeTimers();
    try {
      const { parent, line } = mount();
      line.render(state());
      const mode = segment(parent, "mode");
      mode.focus();
      mode.click();
      document.body.focus();
      menus().at(-1)!.hide();
      jest.runOnlyPendingTimers();
      expect(document.activeElement).toBe(segment(parent, "mode"));
      line.unload();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(["backend", "mode", "detail"])("contains %s menu Escape before the host can activate another note", (kind) => {
    jest.useFakeTimers();
    const { parent, line } = mount();
    const note = document.body.createEl("textarea");
    const hostEscape = jest.fn((event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) note.focus();
    });
    window.addEventListener("keydown", hostEscape);
    try {
      line.render(state());
      const opener = segment(parent, kind);
      opener.focus();
      opener.click();
      const menu = menus().at(-1)!;
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      opener.dispatchEvent(escape);
      jest.runOnlyPendingTimers();
      expect(menu.shown).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(hostEscape).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
      expect(opener.getAttribute("aria-expanded")).toBe("false");
      // Once closed, Escape belongs to the host again.
      opener.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(note);
    } finally {
      line.unload();
      window.removeEventListener("keydown", hostEscape);
      jest.useRealTimers();
    }
  });

  it("models Obsidian's single replacing onHide callback", () => {
    const menu = new Menu();
    const replaced = jest.fn();
    const current = jest.fn();
    menu.onHide(replaced);
    menu.onHide(current);
    menu.showAtPosition({ x: 0, y: 0 });
    menu.hide();
    menu.hide();
    expect(replaced).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["backend", "CodexReady"],
    ["mode", "Plan onlyReads and plans. Changes nothing until you approve the plan."],
    ["detail", "Opus"],
  ])("releases the %s menu Escape listener after selection and disposal", (kind, choice) => {
    const { parent, line } = mount();
    line.render(state());
    const opener = segment(parent, kind);
    opener.click();
    menus().at(-1)!.select(choice);
    const afterSelection = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    opener.dispatchEvent(afterSelection);
    expect(afterSelection.defaultPrevented).toBe(false);
    opener.click();
    line.unload();
    const afterDisposal = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    opener.dispatchEvent(afterDisposal);
    expect(afterDisposal.defaultPrevented).toBe(false);
  });

  it.each(["before hide", "after hide"])("does not steal focus moved to another pane or dialog %s", (timing) => {
    jest.useFakeTimers();
    try {
      const leaf = document.body.createDiv({ cls: "workspace-leaf" });
      const opener = leaf.createEl("button");
      const destination = document.body.createEl("input");
      opener.focus();
      if (timing === "before hide") destination.focus();
      returnFocusAfterMenu(opener, () => opener);
      if (timing === "after hide") destination.focus();
      jest.runOnlyPendingTimers();
      expect(document.activeElement).toBe(destination);
    } finally {
      jest.useRealTimers();
    }
  });

  it("runs the hosted credits and sign-in actions directly", () => {
    const { parent, line, options } = mount();
    line.render(state({ backend: "systemsculpt" }));
    expect(segment(parent, "detail").textContent).toBe("Sign in");
    expect(segment(parent, "detail").hasAttribute("aria-haspopup")).toBe(false);
    segment(parent, "detail").click();
    expect(options.onAction).toHaveBeenCalledWith("sign-in");
    expect(menus()).toHaveLength(0);
    line.unload();
  });

  it("shows detection as a status, not as menus", () => {
    const { parent, line } = mount();
    line.render(state({ detecting: true }));
    expect(parent.querySelector('[data-testid="chat.run.detecting"]')?.textContent).toBe("Finding Claude Code or Codex…");
    expect(parent.querySelectorAll("button")).toHaveLength(0);
    line.unload();
  });

  it("keeps a focused segment focused across a redraw and refreshes a loading model menu", () => {
    const { parent, line } = mount();
    line.render(state({ backend: "codex" }));
    segment(parent, "detail").focus();
    segment(parent, "detail").click();
    expect(menus().at(-1)!.items[0]).toMatchObject({ title: "Loading Codex models…", isLabel: true });
    line.render(state({
      backend: "codex",
      codex: {
        ...state().codex,
        models: [{ model: "gpt-6.1", name: "GPT-6.1", efforts: ["high"], defaultEffort: "high" }],
      },
    }));
    expect(document.activeElement).toBe(segment(parent, "detail"));
    expect(menus().at(-1)!.shown).toBe(true);
    expect(menus().at(-1)!.items[0].title).toBe("GPT-6.1");
    line.unload();
  });
});
