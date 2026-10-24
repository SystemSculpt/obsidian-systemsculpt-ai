/** @jest-environment jsdom */

import { App, Menu } from "obsidian";
import { AgentWorkspace, type AgentWorkspaceOptions } from "../AgentWorkspace";
import type { AgentChromeState } from "../AgentChatChrome";
import type { AgentConversationSnapshot, AgentToolPart } from "../../../chat/ChatConversation";

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

  it("announces working once, completion and stopped through the one region, never streamed text", async () => {
    jest.useFakeTimers();
    const { parent, workspace } = mount({ backendName: () => "Codex" });
    try {
      const region = parent.querySelector('[data-testid="chat.announcer"]')!;
      const announce = jest.spyOn(workspace, "announce");
      const snapshot: AgentConversationSnapshot = { runId: "run", turnId: "turn", status: "running", messages: [],
        parts: [{ kind: "text", id: "text", messageId: "answer", order: 0, markdown: "Hello", state: "streaming" }] };
      const render = async (value: AgentConversationSnapshot) => {
        const rendered = workspace.setAgentSnapshot(value);
        await jest.advanceTimersByTimeAsync(20);
        await rendered;
        await jest.advanceTimersByTimeAsync(50);
      };
      await render(snapshot);
      expect(region.textContent).toBe("Codex is working");
      await render({ ...snapshot, parts: [{ ...snapshot.parts[0], kind: "text", messageId: "answer", markdown: "Hello again", state: "streaming" }] });
      expect(announce.mock.calls).toEqual([["Codex is working"]]);
      await render({ ...snapshot, status: "completed" });
      expect(region.textContent).toBe("Codex replied");
      await render({ ...snapshot, status: "completed" });
      expect(announce.mock.calls).toEqual([["Codex is working"], ["Codex replied"]]);
      await render({ ...snapshot, runId: "next", turnId: "next" });
      await render({ ...snapshot, runId: "next", turnId: "next", status: "cancelled" });
      expect(region.textContent).toBe("Stopped");
      expect(parent.querySelectorAll('[aria-live="polite"], [role="status"]:not([aria-live="off"])')).toHaveLength(1);
      workspace.setBanner("Cannot save this chat", "error");
      expect(parent.querySelector(".systemsculpt-agent-banner")?.getAttribute("role")).toBe("alert");
    } finally { workspace.unload(); jest.useRealTimers(); }
  });

  it.each([true, false])("routes an approval card and its answer (%s) through the shared live region", async (approved) => {
    jest.useFakeTimers();
    const { parent, workspace } = mount({ backendName: () => "Claude Code", onApprove: jest.fn(() => true) });
    try {
      const part: AgentToolPart = { kind: "tool", id: "edit", callId: "edit", messageId: "answer", order: 0,
        name: "Edit", input: { file_path: "/vault/Notes/Plan.md", old_string: "Draft", new_string: "Ready" },
        native: { agent: "claude", workingDirectory: "/vault" }, state: "approval-required", approvalId: "approval", location: "vault" };
      const rendered = workspace.setAgentSnapshot({ runId: "run", turnId: "turn", status: "running", messages: [], parts: [part] });
      await jest.advanceTimersByTimeAsync(20);
      await rendered;
      await jest.advanceTimersByTimeAsync(50);
      const region = parent.querySelector('[data-testid="chat.announcer"]')!;
      expect(region.textContent).toContain("Claude Code wants to edit Plan.md. Enter to approve, Escape to deny.");
      parent.querySelector<HTMLButtonElement>(`[data-testid="chat.approval.${approved ? "allow-once" : "deny"}"]`)!.click();
      await jest.advanceTimersByTimeAsync(50);
      expect(region.textContent).toBe(approved ? "Approved" : "Denied");
      expect(parent.querySelectorAll('[aria-live="polite"], [role="status"]:not([aria-live="off"])')).toHaveLength(1);
    } finally { workspace.unload(); jest.useRealTimers(); }
  });

  it("announces a queued follow-up and a Codex question through the shared region", async () => {
    jest.useFakeTimers();
    const { parent, workspace } = mount({ backendName: () => "Codex", onSubmit: jest.fn(async () => undefined) });
    try {
      workspace.setRunPending(true);
      workspace.setInputText("Next step");
      parent.querySelector<HTMLButtonElement>('[data-testid="chat.composer.send"]')!.click();
      await jest.advanceTimersByTimeAsync(70);
      const region = parent.querySelector('[data-testid="chat.announcer"]')!;
      expect(region.textContent).toContain("Message queued.");
      workspace.setRunPending(false);
      const part: AgentToolPart = { kind: "tool", id: "question", callId: "question", messageId: "answer", order: 0,
        name: "request_user_input", input: { questions: [{ id: "scope", question: "Which notes?", options: [{ label: "All" }] }] },
        native: { agent: "codex", workingDirectory: "/vault" }, state: "approval-required", approvalId: "question", location: "server" };
      const rendered = workspace.setAgentSnapshot({ runId: "run", turnId: "turn", status: "running", messages: [], parts: [part] });
      await jest.advanceTimersByTimeAsync(20);
      await rendered;
      await jest.advanceTimersByTimeAsync(50);
      expect(region.textContent).toContain("Codex asks: Which notes?");
      expect(parent.querySelectorAll('[aria-live="polite"], [role="status"]:not([aria-live="off"])')).toHaveLength(1);
    } finally { workspace.unload(); jest.useRealTimers(); }
  });

  it("preserves announcements in order when multiple events arrive before the live-region flush", () => {
    jest.useFakeTimers();
    const { parent, workspace } = mount();
    try {
      const region = parent.querySelector('[data-testid="chat.announcer"]')!;
      workspace.announce("Codex is working");
      workspace.announce("Codex replied");
      jest.advanceTimersByTime(50);
      expect(region.textContent).toBe("Codex is working Codex replied");
      workspace.announce("Message queued.");
      expect(region.textContent).toBe("");
      jest.advanceTimersByTime(50);
      expect(region.textContent).toBe("Message queued.");
      workspace.announce("Message queued.");
      expect(region.textContent).toBe("");
      jest.advanceTimersByTime(50);
      expect(region.textContent).toBe("Message queued.");
    } finally { workspace.unload(); jest.useRealTimers(); }
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
