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
    getModelById?: jest.Mock;
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
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
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

  it("keeps a local Pi selection intact when the chat model is changed explicitly", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
      getModelById: jest.fn(async (id: string) => ({
        id,
        provider: "openai",
      })),
    });

    jest.spyOn(chatView as any, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "focusInput").mockImplementation(() => {});
    jest.spyOn(chatView as any, "notifySettingsChanged").mockImplementation(() => {});

    await chatView.setSelectedModelId("local-pi-openai@@gpt-4.1");

    expect(chatView.selectedModelId).toBe("local-pi-openai@@gpt-4.1");
    expect(chatView.getSelectedModelId()).toBe("local-pi-openai@@gpt-4.1");
  });

  it("clears stale Pi session state when the selected model changes", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
      getModelById: jest.fn(async (id: string) => ({
        id,
        provider: "systemsculpt",
      })),
    });

    chatView.selectedModelId = "local-pi-github-copilot@@claude-haiku-4.5";
    chatView.piSessionFile = "/tmp/pi-session.jsonl";
    chatView.piSessionId = "session-123";
    chatView.piLastEntryId = "entry-456";
    chatView.piLastSyncedAt = "2026-03-28T00:00:00.000Z";

    jest.spyOn(chatView as any, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "focusInput").mockImplementation(() => {});
    jest.spyOn(chatView as any, "notifySettingsChanged").mockImplementation(() => {});

    await chatView.setSelectedModelId("systemsculpt@@systemsculpt/ai-agent");

    expect(chatView.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");
    expect(chatView.piSessionFile).toBeUndefined();
    expect(chatView.piSessionId).toBeUndefined();
    expect(chatView.piLastEntryId).toBeUndefined();
    expect(chatView.piLastSyncedAt).toBeUndefined();
  });

  it("preserves an explicitly requested model when resetting to a fresh chat", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    jest.spyOn(chatView as any, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "updateSystemPromptIndicator").mockImplementation(() => {});

    await chatView.setState({
      chatId: "",
      selectedModelId: "local-pi-github-copilot@@claude-haiku-4.5",
    });

    expect(chatView.chatId).toBe("");
    expect(chatView.selectedModelId).toBe("local-pi-github-copilot@@claude-haiku-4.5");
    expect(chatView.getSelectedModelId()).toBe("local-pi-github-copilot@@claude-haiku-4.5");
  });

  it("resets composer automation state when resetting to a fresh chat", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    const resetForFreshChat = jest.fn();
    (chatView as any).inputHandler = {
      resetForFreshChat,
    };

    jest.spyOn(chatView as any, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "updateSystemPromptIndicator").mockImplementation(() => {});

    await chatView.setState({
      chatId: "",
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    });

    expect(resetForFreshChat).toHaveBeenCalledTimes(1);
  });

  it("updates leaf state without requesting focus", () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    const setViewState = jest.fn();
    (chatView.leaf as any).setViewState = setViewState;

    (chatView as any).updateViewState();

    expect(setViewState).toHaveBeenCalledWith(
      expect.objectContaining({
        type: chatView.getViewType(),
      }),
      { focus: false }
    );
  });

  it("preserves completed tool results when assistant updates are persisted", async () => {
    const chatView = createChatView({
      getCachedModels: jest.fn(() => []),
      getModels: jest.fn(async () => []),
    });

    jest.spyOn(chatView, "saveChat").mockResolvedValue(undefined);

    chatView.messages = [
      {
        role: "assistant",
        content: "",
        message_id: "assistant-1",
        tool_calls: [
          {
            id: "call-1",
            state: "completed",
            result: {
              success: true,
              data: { path: "alpha.md" },
            },
          },
        ],
      } as any,
    ];

    const persisted = await chatView.persistAssistantMessage(
      {
        role: "assistant",
        content: "Done",
        message_id: "assistant-1",
        tool_calls: [
          {
            id: "call-1",
            state: "completed",
          },
        ],
      } as any,
      { syncPiTranscript: false }
    );

    expect(chatView.saveChat).toHaveBeenCalledTimes(1);
    expect(persisted.tool_calls).toEqual([
      expect.objectContaining({
        id: "call-1",
        state: "completed",
        result: expect.objectContaining({
          success: true,
          data: { path: "alpha.md" },
        }),
      }),
    ]);
    expect(chatView.messages[0].tool_calls).toEqual(persisted.tool_calls);
  });
});
