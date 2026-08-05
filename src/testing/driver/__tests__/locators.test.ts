/**
 * @jest-environment jsdom
 */

import type { App } from "obsidian";

import {
  liveTestIdCatalog,
  resolveTarget,
  type LocatorContext,
} from "../locators";

function makeContext(settingsRoot?: () => HTMLElement | null): LocatorContext {
  return {
    app: {
      workspace: { getLeavesOfType: () => [] },
    } as unknown as App,
    settingsRoot,
  };
}

describe("test driver locators", () => {
  beforeEach(() => {
    document.body.empty();
  });

  it("finds controls in the separate settings document", () => {
    const settingsDocument = document.implementation.createHTMLDocument("Settings");
    const container = settingsDocument.createElement("div");
    settingsDocument.body.append(container);

    const surface = settingsDocument.createElement("div");
    surface.className = "ss-settings-surface";
    container.append(surface);

    const tabs = settingsDocument.createElement("div");
    tabs.className = "ss-settings-tab-bar";
    surface.append(tabs);
    const chatTab = settingsDocument.createElement("button");
    chatTab.textContent = "Chat";
    chatTab.dataset.testid = "settings.tab.chat";
    chatTab.setAttribute("aria-label", "Chat settings tab");
    tabs.append(chatTab);

    const row = settingsDocument.createElement("div");
    row.className = "setting-item";
    row.innerHTML = [
      '<div class="setting-item-name">Default chat font size</div>',
      '<div class="setting-item-control"><select><option value="medium">Medium</option></select></div>',
    ].join("");
    surface.append(row);

    const ctx = makeContext(() => container);
    expect(resolveTarget(ctx, "settings.surface")).toBe(surface);
    expect(resolveTarget(ctx, "settings.tab:Chat")).toBe(chatTab);
    expect(resolveTarget(ctx, "settings.tab.chat")).toBe(chatTab);
    expect(resolveTarget(ctx, "label:Chat settings tab")).toBe(chatTab);
    expect(resolveTarget(ctx, "setting:Default chat font size")?.tagName).toBe("SELECT");
    expect(liveTestIdCatalog(ctx)).toContainEqual({
      id: "settings.tab.chat",
      visible: false,
      count: 1,
    });
  });

  it("keeps main-window controls available when settings use another document", () => {
    const chatButton = document.createElement("button");
    chatButton.dataset.testid = "chat.header.new";
    document.body.append(chatButton);

    const settingsDocument = document.implementation.createHTMLDocument("Settings");
    const settingsRoot = settingsDocument.createElement("div");
    settingsDocument.body.append(settingsRoot);

    const ctx = makeContext(() => settingsRoot);
    expect(resolveTarget(ctx, "chat.header.new")).toBe(chatButton);
    expect(liveTestIdCatalog(ctx)).toContainEqual({
      id: "chat.header.new",
      visible: false,
      count: 1,
    });
  });

  it("finds ChatView controls in a separate workspace document", () => {
    const chatDocument = document.implementation.createHTMLDocument("Chat pop-out");
    const chatContainer = chatDocument.createElement("div");
    chatDocument.body.append(chatContainer);
    const send = chatDocument.createElement("button");
    send.dataset.testid = "chat.composer.send";
    send.setAttribute("aria-label", "Send message");
    chatContainer.append(send);

    const ctx: LocatorContext = {
      app: {
        workspace: {
          getLeavesOfType: () => [{ view: { containerEl: chatContainer } }],
        },
      } as unknown as App,
    };

    expect(resolveTarget(ctx, "chat.composer.send")).toBe(send);
    expect(resolveTarget(ctx, "css:[data-testid='chat.composer.send']")).toBe(send);
    expect(resolveTarget(ctx, "label:Send message")).toBe(send);
    expect(liveTestIdCatalog(ctx)).toContainEqual({
      id: "chat.composer.send",
      visible: false,
      count: 1,
    });
  });
});
