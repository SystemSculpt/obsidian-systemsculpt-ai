/**
 * @jest-environment jsdom
 */

import { App, WorkspaceLeaf } from "obsidian";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { ChatView } from "../ChatView";

describe("ChatView loaded model migration", () => {
  beforeEach(() => {
    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createChatView(modelService: {
    getCachedModels: jest.Mock;
    getModels: jest.Mock;
  }): ChatView {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);

    (app as any).vault = {
      getAbstractFileByPath: jest.fn(() => null),
      adapter: {},
    };

    const plugin: any = {
      app,
      manifest: { id: "systemsculpt-ai" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        chatFontSize: "medium",
        systemPromptType: "general-use",
        systemPromptPath: "",
        respectReducedMotion: false,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
      },
      modelService,
      openSettingsTab: jest.fn(),
    };

    return new ChatView(leaf as any, plugin);
  }

  it("maps a legacy SystemSculpt alias back to the canonical SystemSculpt model", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    await expect(
      (chatView as any).resolveLoadedSelectedModelId("systemsculpt@@systemsculpt/managed")
    ).resolves.toBe("systemsculpt@@systemsculpt/ai-agent");
  });

  it("migrates stale local Pi chat selections using cached models", async () => {
    const getModels = jest.fn(async () => []);
    const chatView = createChatView({
      getCachedModels: jest.fn(() => [
        {
          id: "anthropic@@claude-haiku-4-5",
          provider: "anthropic",
          piExecutionModelId: "anthropic/claude-haiku-4-5",
          piLocalAvailable: true,
        },
      ]),
      getModels,
    });

    await expect(
      (chatView as any).resolveLoadedSelectedModelId("local-pi-anthropic@@claude-haiku-4-5-20251001")
    ).resolves.toBe("anthropic@@claude-haiku-4-5");
    expect(getModels).not.toHaveBeenCalled();
  });
});
