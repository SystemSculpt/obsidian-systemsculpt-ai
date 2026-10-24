/** @jest-environment jsdom */

import { App, Menu } from "obsidian";
import { AgentWorkspace, type AgentWorkspaceOptions } from "../AgentWorkspace";
import type { AgentChromeState } from "../AgentChatChrome";

type MockMenu = Menu & { items: Array<{ title?: string; disabled?: boolean; isLabel?: boolean; separator?: boolean }>; shown: boolean; select: (title: string) => unknown };
const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;

function mount(overrides: Partial<AgentWorkspaceOptions> = {}) {
  const parent = document.body.createDiv();
  const workspace = new AgentWorkspace(parent, {
    app: new App(),
    sourcePath: () => "",
    onSubmit: jest.fn(),
    onStop: jest.fn(),
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onApprove: jest.fn(),
    onOpenArtifact: jest.fn(),
    onCopyArtifactPath: jest.fn(),
    onNewChat: jest.fn(),
    onOpenHistory: jest.fn(),
    ...overrides,
  });
  workspace.load();
  return { parent, workspace };
}

const chrome = (overrides: Partial<AgentChromeState> = {}): AgentChromeState => ({
  backend: "systemsculpt",
  localAgents: false,
  host: "computer",
  detecting: false,
  detection: null,
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
});

describe("AgentWorkspace chrome", () => {
  beforeEach(() => {
    document.body.empty();
    menus().length = 0;
  });

  it("has a title you rename in place and three icon buttons, with no credits pill", async () => {
    const onRename = jest.fn();
    const { parent, workspace } = mount({ onRename });
    workspace.setTitle("Plan the Q4 launch");
    const header = parent.querySelector<HTMLElement>(".systemsculpt-agent-header")!;
    expect(Array.from(header.querySelectorAll("button"), (button) => button.getAttribute("aria-label")))
      .toEqual(["Plan the Q4 launch", "Chat history", "New chat", "More"]);
    expect(header.querySelector(".systemsculpt-agent-credits")).toBeNull();

    parent.querySelector<HTMLButtonElement>('[data-testid="chat.header.title"]')!.click();
    let input = parent.querySelector<HTMLInputElement>('[data-testid="chat.header.title-input"]')!;
    expect(document.activeElement).toBe(input);
    input.value = "Ignored";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector('[data-testid="chat.header.title-input"]')).toBeNull();
    expect(document.activeElement).toBe(parent.querySelector('[data-testid="chat.header.title"]'));

    workspace.beginRename();
    input = parent.querySelector<HTMLInputElement>('[data-testid="chat.header.title-input"]')!;
    input.value = "Launch plan";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onRename).toHaveBeenCalledWith("Launch plan");

    workspace.beginRename();
    input = parent.querySelector<HTMLInputElement>('[data-testid="chat.header.title-input"]')!;
    input.value = "Saved on blur";
    input.dispatchEvent(new FocusEvent("blur"));
    expect(onRename).toHaveBeenLastCalledWith("Saved on blur");
    workspace.unload();
  });

  it("fills the More menu from the view", () => {
    const buildMoreMenu = jest.fn((menu: Menu) => {
      menu.addItem((item) => item.setTitle("Rename chat"));
    });
    const { parent, workspace } = mount({ buildMoreMenu });
    parent.querySelector<HTMLButtonElement>('[data-testid="chat.header.more"]')!.click();
    expect(buildMoreMenu).toHaveBeenCalledTimes(1);
    expect(menus().at(-1)?.shown).toBe(true);
    expect(menus().at(-1)?.items.map((item) => item.title)).toEqual(["Rename chat"]);
    workspace.unload();
    expect(menus().at(-1)?.shown).toBe(false);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    parent.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("contains More-menu Escape and returns focus to its opener", () => {
    jest.useFakeTimers();
    const { parent, workspace } = mount();
    const hostEscape = jest.fn();
    window.addEventListener("keydown", hostEscape);
    try {
      const opener = parent.querySelector<HTMLButtonElement>('[data-testid="chat.header.more"]')!;
      opener.focus();
      opener.click();
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      opener.dispatchEvent(escape);
      jest.runOnlyPendingTimers();
      expect(menus().at(-1)?.shown).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(hostEscape).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
    } finally {
      workspace.unload();
      window.removeEventListener("keydown", hostEscape);
      jest.useRealTimers();
    }
  });

  it.each(["chat.run.backend", "chat.run.mode", "chat.run.detail", "chat.header.more"])(
    "releases %s Escape across repeated closes so history and rename still handle it",
    (testId) => {
      jest.useFakeTimers();
      const onRename = jest.fn();
      const { parent, workspace } = mount({
        onRename,
        buildMoreMenu: (menu) => menu.addItem((item) => item.setTitle("Keep chat").onClick(() => undefined)),
        history: {
          loadRows: async () => [], loadSearchText: async () => "",
          isCurrent: () => false, isRunning: () => false,
          onOpen: () => undefined, onNewChat: () => undefined,
          onClose: () => workspace.hideHistory(),
          onToggleFavorite: async () => undefined, onRename: async () => undefined,
          onDelete: async () => false,
        },
      });
      const escape = (target: HTMLElement): void => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      };
      try {
        workspace.setTitle("Original title");
        workspace.setChrome(chrome({ backend: "claude", localAgents: true }));
        const opener = parent.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
        for (const close of ["escape", "selection", "replacement"]) {
          opener.focus();
          opener.click();
          const menu = menus().at(-1)!;
          if (close === "escape") escape(opener);
          else if (close === "selection") {
            const choice = menu.items.find((item) => item.title && !item.disabled && !item.isLabel && !item.separator)!;
            menu.select(choice.title!);
          } else {
            opener.click();
            expect(menu.shown).toBe(false);
            menus().at(-1)!.hide();
          }
          expect(menus().at(-1)!.shown).toBe(false);
          jest.runOnlyPendingTimers();

          workspace.setInputText("Keep this draft");
          workspace.focus();
          const composer = document.activeElement;
          workspace.showHistory();
          escape(parent.querySelector<HTMLInputElement>('[data-testid="history.search"]')!);
          expect(workspace.isHistoryOpen).toBe(false);
          expect(document.activeElement).toBe(composer);
          expect(workspace.getInputText()).toBe("Keep this draft");

          workspace.beginRename();
          const input = parent.querySelector<HTMLInputElement>('[data-testid="chat.header.title-input"]')!;
          input.value = "Cancelled title";
          escape(input);
          expect(parent.querySelector('[data-testid="chat.header.title-input"]')).toBeNull();
          expect(parent.querySelector('[data-testid="chat.header.title"]')?.textContent).toBe("Original title");
          expect(onRename).not.toHaveBeenCalled();
        }
      } finally {
        workspace.unload();
        jest.useRealTimers();
      }
    },
  );

  it("opens history in place of the conversation and restores focus and draft on close", () => {
    const { parent, workspace } = mount();
    workspace.setInputText("Half-written thought");
    workspace.focus();
    const composerInput = parent.querySelector<HTMLTextAreaElement>('[data-testid="chat.composer.input"]')!;
    expect(document.activeElement).toBe(composerInput);

    workspace.showHistory();
    expect(workspace.element.classList.contains("is-history-open")).toBe(true);
    expect(parent.querySelector('[data-testid="history.panel"]')?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(parent.querySelector('[data-testid="history.search"]'));

    workspace.hideHistory();
    expect(workspace.element.classList.contains("is-history-open")).toBe(false);
    expect(document.activeElement).toBe(composerInput);
    expect(workspace.getInputText()).toBe("Half-written thought");
    workspace.unload();
  });

  it("renders the run line and the empty state from one chrome state", () => {
    const { parent, workspace } = mount();
    workspace.setChrome(chrome());
    expect(parent.querySelector('[data-testid="chat.run.backend"]')?.textContent).toBe("SystemSculpt");
    expect(workspace.composer.footerSlot.contains(workspace.runLine.element)).toBe(true);
    expect(parent.querySelector('[data-testid="chat.composer.approval-mode"]')).toBeNull();
    expect(parent.querySelector('[data-testid="chat.empty"]')?.textContent).toContain("Chat with your vault using SystemSculpt.");
    workspace.setChrome(chrome({ account: "signed-in" }));
    expect(parent.querySelector('[data-testid="chat.empty"]')?.textContent).toContain("Ask about your notes or give SystemSculpt a task.");
    expect(parent.querySelector('[data-testid="chat.run.detail"]')?.textContent).toBe("Credits");
    workspace.unload();
  });

  it("routes conversation loading and notices through the shared owner-window announcer", () => {
    jest.useFakeTimers();
    const { parent, workspace } = mount({ backendName: () => "Claude Code" });
    try {
      const region = parent.querySelector('[data-testid="chat.announcer"]')!;
      const empty = parent.querySelector('[data-testid="chat.empty"]')!;
      expect(empty.hasAttribute("hidden")).toBe(false);
      workspace.setLoading(true);
      expect(empty.hasAttribute("hidden")).toBe(true);
      jest.advanceTimersByTime(299);
      expect(parent.querySelector('[data-testid="chat.loading"]')).toBeNull();
      jest.advanceTimersByTime(51);
      expect(parent.querySelector('[data-testid="chat.loading"]')).not.toBeNull();
      expect(region.textContent).toBe("Loading chat");
      workspace.setLoading(false);
      expect(parent.querySelector('[data-testid="chat.loading"]')).toBeNull();
      expect(empty.hasAttribute("hidden")).toBe(false);
      workspace.showNotice("Auto is unavailable.");
      expect(parent.querySelector('[data-testid="chat.notice"]')?.textContent).toContain("Auto is unavailable.");
      expect(parent.querySelector('.systemsculpt-agent-banner')?.hasAttribute('hidden')).toBe(true);
      jest.advanceTimersByTime(50);
      expect(region.textContent).toBe("Auto is unavailable.");
      workspace.announce("Do not announce after unload");
      workspace.unload();
      jest.advanceTimersByTime(50);
      expect(region.textContent).toBe("");
    } finally {
      workspace.unload();
      jest.useRealTimers();
    }
  });

  it("keeps one polite live region for announcements", () => {
    const { parent, workspace } = mount();
    const region = parent.querySelector<HTMLElement>('[data-testid="chat.announcer"]')!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.classList.contains("systemsculpt-agent-sr-only")).toBe(true);
    workspace.setChrome(chrome({ detecting: true, localAgents: true }));
    expect(parent.querySelectorAll('[aria-live="polite"], [role="status"]')).toHaveLength(1);
    for (const selector of [".systemsculpt-agent-banner", ".systemsculpt-agent-queue", ".systemsculpt-agent-prompt-hint", ".systemsculpt-history-panel-status"]) {
      expect(parent.querySelector(selector)?.getAttribute("aria-live")).toBeNull();
      expect(parent.querySelector(selector)?.getAttribute("role")).not.toBe("status");
    }
    const announce = jest.spyOn(workspace, "announce");
    workspace.setBanner("This saved chat is read-only.");
    workspace.setBanner("This saved chat is read-only.");
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("This saved chat is read-only.");
    workspace.unload();
  });
});
