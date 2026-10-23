/** @jest-environment jsdom */

import { App, Menu } from "obsidian";
import { AgentWorkspace, type AgentWorkspaceOptions } from "../AgentWorkspace";
import type { AgentChromeState } from "../AgentChatChrome";

type MockMenu = Menu & { items: Array<{ title?: string }>; shown: boolean; select: (title: string) => unknown };
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
  });

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
    expect(parent.querySelector('[data-testid="chat.empty"]')?.textContent).toContain("Chat with your vault using SystemSculpt.");
    workspace.setChrome(chrome({ account: "signed-in" }));
    expect(parent.querySelector('[data-testid="chat.empty"]')?.textContent).toContain("Ask about your notes or give SystemSculpt a task.");
    expect(parent.querySelector('[data-testid="chat.run.detail"]')?.textContent).toBe("Credits");
    workspace.unload();
  });

  it("keeps one polite live region for announcements", () => {
    const { parent, workspace } = mount();
    const region = parent.querySelector<HTMLElement>('[data-testid="chat.announcer"]')!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.classList.contains("systemsculpt-agent-sr-only")).toBe(true);
    workspace.unload();
  });
});
