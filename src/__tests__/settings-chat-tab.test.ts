/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayChatTabContent } from "../settings/ChatTabContent";

const createPluginStub = (app: App) => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    app,
    emitter: { emit: jest.fn() },
    settings: {
      chatFontSize: "medium",
      settingsMode: "standard",
      defaultChatTag: "",
      respectReducedMotion: true,
    },
    getSettingsManager: jest.fn(() => settingsManager),
  } as any;
};

describe("Chat tab native layout", () => {
  let app: App;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
    (globalThis as any).confirm = jest.fn(() => true);
  });

  it("uses native Setting rows for client-owned chat preferences only", async () => {
    const plugin = createPluginStub(app);
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };
    const container = document.createElement("div");

    await displayChatTabContent(container, tab);

    const names = Array.from(container.querySelectorAll('.setting-item .setting-item-name')).map((el) => el.textContent?.trim());
    expect(names).toContain("Default chat tag");
    expect(names).toContain("Default chat font size");
    expect(names).not.toContain("Hide SystemSculpt system & tool messages");
    expect(names).toContain("Honor OS reduced motion");
    expect(names).not.toContain("Default system prompt");
    expect(names).not.toContain("Favorite models");
    expect(container.textContent).toContain("Chat settings");
    expect(container.textContent).toContain("chat preferences and display choices");
    expect(container.querySelector(".ss-favorites-manager")).toBeNull();
  });
});
