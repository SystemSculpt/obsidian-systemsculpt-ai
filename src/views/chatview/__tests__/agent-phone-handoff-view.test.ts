/** @jest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App, type Component } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../types";
import type { PhoneHandoffPresentation } from "../AgentPhoneHandoffCards";
import { AgentChatView } from "../AgentChatView";

jest.mock("../../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../../platform/hostCapabilities"),
  hasHostCapability: () => false,
}));

const handoff: PhoneHandoffPresentation = {
  id: "phone-one", instruction: "Make a checklist.", agent: "systemsculpt", state: "pending",
  source: { title: "Launch notes", markdown: "Confirm delivery.", path: "Inbox/Launch.md" },
};

function harness(withInbox = true) {
  const app = new App();
  const openLinkText = jest.fn(async () => undefined);
  app.workspace.openLinkText = openLinkText;
  const containerEl = document.body.createDiv();
  const contentEl = containerEl.createDiv();
  const listeners = new Set<() => void>();
  const unsubscribe = jest.fn();
  const inbox = {
    items: [handoff] as readonly PhoneHandoffPresentation[],
    run: jest.fn(async () => undefined),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => { unsubscribe(); listeners.delete(listener); };
    }),
  };
  const cleanups: (() => void)[] = [];
  const view = Object.assign(Object.create(AgentChatView.prototype), {
    app, containerEl, contentEl, chatId: "", draftKey: "draft", closeBarrier: null,
    plugin: { settings: { ...DEFAULT_SETTINGS }, ...(withInbox ? { getPhoneHandoffInbox: () => inbox } : {}) },
    addChild: (child: Component) => { cleanups.push(() => child.unload()); },
    register: (cleanup: () => void) => { cleanups.push(cleanup); },
    shouldOfferPlan: () => false,
    registerViewKeys: jest.fn(),
    bindAgentSession: jest.fn(),
    installRecorderBindings: jest.fn(),
    installWorkspaceBindings: jest.fn(),
    applyFontSize: jest.fn(),
    syncAttachments: jest.fn(),
    syncChrome: jest.fn(),
    refreshUsedInVault: jest.fn(async () => undefined),
    startNewChat: jest.fn(async () => undefined),
    refreshCreditsBalance: jest.fn(async () => undefined),
    scheduleAttachmentPrune: jest.fn(),
    performClose: jest.fn(async () => undefined),
  }) as AgentChatView;
  return {
    view, contentEl, inbox, openLinkText, unsubscribe, listeners,
    emit: () => { for (const listener of listeners) listener(); },
    unload: () => { for (const cleanup of cleanups.reverse()) cleanup(); },
  };
}

afterEach(() => { jest.restoreAllMocks(); document.body.empty(); });

it("mounts above the transcript in the existing PluginSurface and forwards explicit Run and note opens", async () => {
  const ui = harness();
  await ui.view.onOpen();
  try {
    const cards = ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs")!;
    expect(cards.closest('[data-ss-surface="view"]')).not.toBeNull();
    expect(cards.closest(".systemsculpt-agent-viewport")).toBeNull();
    const region = cards.closest<HTMLElement>(".systemsculpt-agent-phone-handoff-region")!;
    expect(region.nextElementSibling?.classList.contains("systemsculpt-agent-transcript")).toBe(true);
    expect(region.parentElement?.classList.contains("systemsculpt-agent-workspace")).toBe(true);
    expect(region.hidden).toBe(false);
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Phone handoffs");
    expect(ui.contentEl.querySelectorAll(".ss-surface")).toHaveLength(1);
    expect(ui.inbox.run).not.toHaveBeenCalled();
    const click = (id: string) => ui.contentEl.querySelector<HTMLElement>(`[data-testid="chat.phone-handoff.${id}"]`)!.click();
    click("run");
    click("source");
    expect(ui.inbox.run.mock.calls).toEqual([[handoff.id]]);
    expect(ui.openLinkText).toHaveBeenCalledWith("Inbox/Launch.md", "");
    ui.inbox.items = [{ ...handoff, state: "completed", resultPath: "Results/Launch.md" }];
    ui.emit();
    click("result");
    expect(ui.openLinkText).toHaveBeenLastCalledWith("Results/Launch.md", "");
  } finally { await ui.view.onClose(); ui.unload(); }
});

it("hides the empty scroll region and reveals arrivals without taking focus", async () => {
  const ui = harness();
  ui.inbox.items = [];
  await ui.view.onOpen();
  try {
    const region = ui.contentEl.querySelector<HTMLElement>(".systemsculpt-agent-phone-handoff-region")!;
    expect(region.hidden).toBe(true);
    const composer = ui.contentEl.querySelector<HTMLTextAreaElement>('[data-testid="chat.composer.input"]')!;
    composer.focus();
    ui.inbox.items = [handoff];
    ui.emit();
    expect(region.hidden).toBe(false);
    expect(document.activeElement).toBe(composer);
    region.focus();
    expect(document.activeElement).toBe(region);
    ui.inbox.items = [];
    ui.emit();
    expect(region.hidden).toBe(true);
  } finally { await ui.view.onClose(); ui.unload(); }
});

it("bounds the in-flow review region while retaining all text and touch-sized actions", () => {
  const css = readFileSync(resolve(__dirname, "../../../css/views/agent-workspace/states.css"), "utf8");
  const region = css.match(/\.systemsculpt-agent-phone-handoff-region\s*\{([^}]+)\}/)![1];
  expect(region).toMatch(/flex:\s*0 1 auto/);
  expect(region).toMatch(/min-height:\s*0/);
  expect(region).toMatch(/min-width:\s*0/);
  expect(region).toMatch(/max-height:\s*40%/);
  expect(region).toMatch(/overflow-y:\s*auto/);
  expect(region).toMatch(/overscroll-behavior:\s*contain/);
  expect(region).not.toMatch(/position:\s*(absolute|fixed|sticky)/);
  expect(css).toMatch(/\.systemsculpt-agent-phone-handoff-region\[hidden\],[^{]+\{\s*display:\s*none;/);
  for (const selector of ["instruction", "source"]) {
    const text = css.match(new RegExp(`\\.systemsculpt-agent-phone-handoff-${selector}\\s*\\{([^}]+)\\}`))![1];
    expect(text).toMatch(/white-space:\s*pre-wrap/);
    expect(text).not.toMatch(/line-clamp|text-overflow/);
  }
  expect(css).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]+min-height:\s*var\(--ss-touch-target\)/);
});

it("refreshes without taking focus and unsubscribes before closing or unloading the view", async () => {
  const ui = harness();
  await ui.view.onOpen();
  const composer = ui.contentEl.querySelector<HTMLTextAreaElement>('[data-testid="chat.composer.input"]')!;
  composer.focus();
  const focused = document.activeElement;
  const focus = jest.spyOn(HTMLElement.prototype, "focus");
  const details = ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs details") as HTMLDetailsElement;
  details.open = true;
  ui.inbox.items = [{ ...handoff, state: "running" }];
  ui.emit();
  expect(document.activeElement).toBe(focused);
  expect(focus).not.toHaveBeenCalled();
  expect(details.open).toBe(true);
  expect(ui.inbox.run).not.toHaveBeenCalled();
  const staleListener = [...ui.listeners][0];
  const closing = ui.view.onClose();
  expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
  expect(ui.listeners.size).toBe(0);
  expect(ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs")).toBeNull();
  staleListener();
  expect(ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs")).toBeNull();
  await closing;
  await ui.view.onClose();
  ui.unload();
  expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
});

it("also cleans up through the registered unload callback", async () => {
  const ui = harness();
  await ui.view.onOpen();
  ui.unload();
  expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
  expect(ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs")).toBeNull();
  await ui.view.onClose();
  expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
});

it("opens older test/plugin stubs without an inbox getter", async () => {
  const ui = harness(false);
  await expect(ui.view.onOpen()).resolves.toBeUndefined();
  expect(ui.contentEl.querySelector(".systemsculpt-agent-phone-handoffs")).toBeNull();
  await ui.view.onClose();
  ui.unload();
});
