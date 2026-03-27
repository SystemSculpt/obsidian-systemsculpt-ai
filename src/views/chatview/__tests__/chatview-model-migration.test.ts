/**
 * @jest-environment jsdom
 */

import { App, WorkspaceLeaf } from "obsidian";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { PlatformContext } from "../../../services/PlatformContext";
import { ChatView } from "../ChatView";

describe("ChatView loaded model migration", () => {
  beforeEach(() => {
    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as any);
    jest.spyOn(PlatformContext, "get").mockReturnValue({
      supportsDesktopOnlyFeatures: () => true,
    } as any);
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

  it("keeps resolving legacy custom-provider chat selections after provider keys are redacted", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => [
        {
          id: "openai@@gpt-4.1",
          provider: "openai",
          piExecutionModelId: "openai/gpt-4.1",
          piLocalAvailable: true,
        },
      ]),
      getModels: jest.fn(async () => []),
    });

    (chatView as any).plugin.settings.customProviders = [
      {
        id: "provider_1",
        name: "My OpenAI",
        endpoint: "https://api.openai.com/v1",
        apiKey: "",
        isEnabled: true,
      },
    ];

    await expect(
      (chatView as any).resolveLoadedSelectedModelId("my-openai@@gpt-4.1")
    ).resolves.toBe("openai@@gpt-4.1");
  });

  it("keeps mobile restore on a safe alias path without loading the live Pi catalog", async () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      supportsDesktopOnlyFeatures: () => false,
    });

    const getModels = jest.fn(async () => [
      {
        id: "systemsculpt@@systemsculpt/managed",
      },
    ]);
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels,
    });

    await expect(
      (chatView as any).resolveLoadedSelectedModelId("systemsculpt@@systemsculpt/managed")
    ).resolves.toBe("systemsculpt@@systemsculpt/ai-agent");
    expect(getModels).not.toHaveBeenCalled();
  });

  it("keeps the SystemSculpt backend label on mobile while dropping local session state", () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      supportsDesktopOnlyFeatures: () => false,
    });

    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    (chatView as any).applyChatLeafState({
      chatBackend: "systemsculpt",
      piSessionFile: "/tmp/pi-session.jsonl",
      piSessionId: "session-123",
      piLastEntryId: "entry-456",
      piLastSyncedAt: "2026-03-10T00:00:00.000Z",
    });

    expect(chatView.chatBackend).toBe("systemsculpt");
    expect(chatView.piSessionFile).toBeUndefined();
    expect(chatView.piSessionId).toBeUndefined();
    expect(chatView.piLastEntryId).toBeUndefined();
    expect(chatView.piLastSyncedAt).toBeUndefined();
  });
});
