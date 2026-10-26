/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { displayChatTabContent } from "../settings/ChatTabContent";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Notice: jest.fn(),
}));

const createPluginStub = (app: App) => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    app,
    settings: {
      chatFontSize: "medium",
      textExecutionBackend: "systemsculpt",
      settingsMode: "standard",
      defaultChatTag: "",
      reduceChatMotion: false,
    },
    getSettingsManager: jest.fn(() => settingsManager),
  } as any;
};

const typeValue = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
};

describe("Chat tab native layout", () => {
  let app: App;
  let cleanups: Set<() => void>;

  const cleanupRender = () => {
    [...cleanups].forEach((cleanup) => cleanup());
    cleanups.clear();
  };

  const render = async () => {
    const plugin = createPluginStub(app);
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
      registerRenderCleanup: jest.fn((cleanup: () => void) => {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      }),
    };
    const container = document.createElement("div");
    await displayChatTabContent(container, tab);
    return {
      plugin,
      tab,
      container,
      input: container.querySelector<HTMLInputElement>('input[type="text"]')!,
      updateSettings: plugin.getSettingsManager().updateSettings as jest.Mock,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = "";
    cleanups = new Set();
    app = new App();
    app.workspace.offref = jest.fn();
    (globalThis as any).confirm = jest.fn(() => true);
  });

  afterEach(() => {
    cleanupRender();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("uses native Setting rows for client-owned chat preferences only", async () => {
    const { container } = await render();

    const names = Array.from(container.querySelectorAll('.setting-item .setting-item-name')).map((el) => el.textContent?.trim());
    expect(names).toContain("Default chat tag");
    expect(names).not.toContain("Web search by default");
    expect(names).toContain("Default chat font size");
    expect(names).not.toContain("Hide SystemSculpt system & tool messages");
    expect(names).toContain("Reduce chat motion");
    expect(container.textContent).toContain("Your system preference is always honored.");
    expect(names).not.toContain("Default system prompt");
    expect(names).not.toContain("Favorite models");
    expect(container.textContent).toContain("Chat settings");
    expect(container.textContent).toContain("chat preferences and display choices");
    expect(container.querySelector(".ss-favorites-manager")).toBeNull();
  });

  it("starts Reduce chat motion off and saves the explicit opt-in", async () => {
    const { container, updateSettings } = await render();
    document.body.append(container);
    const row = Array.from(container.querySelectorAll(".setting-item"))
      .find(el => el.querySelector(".setting-item-name")?.textContent === "Reduce chat motion")!;
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    toggle.click();
    expect(updateSettings).toHaveBeenLastCalledWith({ reduceChatMotion: true });
    toggle.click();
    expect(updateSettings).toHaveBeenLastCalledWith({ reduceChatMotion: false });
    await Promise.resolve();
    // The toggle itself shows the change.
    expect(Notice).not.toHaveBeenCalled();
  });

  it("coalesces typing and normalizes only the final chat tag", async () => {
    const { input, updateSettings } = await render();

    typeValue(input, " #n");
    jest.advanceTimersByTime(200);
    typeValue(input, " ##notes ");
    jest.advanceTimersByTime(299);
    expect(updateSettings).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ defaultChatTag: "notes" });
    input.dispatchEvent(new Event("blur"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it.each(["blur", "render cleanup"])("flushes the last edit on %s without a later timer save", async (boundary) => {
    const { input, updateSettings } = await render();
    typeValue(input, "#draft");
    typeValue(input, "#final");
    expect(updateSettings).not.toHaveBeenCalled();

    if (boundary === "blur") input.dispatchEvent(new Event("blur"));
    else cleanupRender();

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ defaultChatTag: "final" });
    expect(jest.getTimerCount()).toBe(0);
    jest.runOnlyPendingTimers();
    cleanupRender();
    typeValue(input, "#detached");
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("flushes before replacing the chat controls", async () => {
    const { container, tab, input, updateSettings } = await render();
    typeValue(input, "#keep-me");

    await displayChatTabContent(container, tab);

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ defaultChatTag: "keep-me" });
    expect(jest.getTimerCount()).toBe(0);
    input.dispatchEvent(new Event("blur"));
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
