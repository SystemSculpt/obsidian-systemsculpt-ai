/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayChatTabContent } from "../settings/ChatTabContent";
import { FavoritesService } from "../services/FavoritesService";

jest.mock("../views/chatview/MCPService", () => ({
  MCPService: jest.fn().mockImplementation(() => ({
    testConnection: jest.fn().mockResolvedValue({ success: true, tools: [] }),
  })),
}));

jest.mock("../mcp-tools/filesystem/MCPFilesystemServer", () => ({
  MCPFilesystemServer: jest.fn().mockImplementation(() => ({
    getTools: jest.fn().mockResolvedValue([]),
    getToolDisplayDescription: jest.fn(() => ""),
    getToolDisplayName: jest.fn((name: string) => name),
  })),
}));

const createPluginStub = (app: App) => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    app,
    emitter: { emit: jest.fn() },
    settings: {
      systemPromptType: "general-use",
      systemPromptPath: "",
      systemPrompt: "",
      chatFontSize: "medium",
      settingsMode: "standard",
      customProviders: [],
      enableSystemSculptProvider: false,
      mcpServers: [],
      mcpAutoAcceptTools: [],
      favoriteModels: [],
    },
    modelService: {
      getModels: jest.fn().mockResolvedValue([]),
    },
    customProviderService: {
      clearCache: jest.fn(),
      testConnection: jest.fn().mockResolvedValue({ success: true, models: [] }),
    },
    getSettingsManager: jest.fn(() => settingsManager),
  } as any;
};

describe("Chat tab native layout", () => {
  let app: App;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    FavoritesService.clearInstance();
    app = new App();
    (globalThis as any).confirm = jest.fn(() => true);
  });

  it("uses native Setting rows for favorites management", async () => {
    const plugin = createPluginStub(app);
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };
    const container = document.createElement("div");

    await displayChatTabContent(container, tab);

    const names = Array.from(container.querySelectorAll('.setting-item .setting-item-name')).map((el) => el.textContent?.trim());
    expect(names).toContain("Favorite models");
    expect(container.querySelector(".ss-favorites-manager")).toBeNull();
  });
});
