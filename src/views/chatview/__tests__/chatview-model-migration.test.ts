/** @jest-environment jsdom */

import { App, WorkspaceLeaf } from "obsidian";
import { AGENT_PRESET } from "../../../constants/prompts";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { ChatView } from "../ChatView";

const CANONICAL_ID = "systemsculpt@@systemsculpt/ai-agent";

describe("ChatView standard identity migration", () => {
  beforeEach(() => {
    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as never);
  });

  afterEach(() => jest.restoreAllMocks());

  function createChatView(initialModelId: string = CANONICAL_ID): {
    chatView: ChatView;
    updateSettings: jest.Mock;
  } {
    const app = new App();
    const leaf = new WorkspaceLeaf(app);
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    (app as App & { vault: object }).vault = {
      getAbstractFileByPath: jest.fn(() => null),
      adapter: {},
    };
    const plugin = {
      app,
      manifest: { id: "systemsculpt-ai" },
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        selectedModelId: initialModelId,
        chatFontSize: "medium",
        respectReducedMotion: false,
      },
      openSettingsTab: jest.fn(),
      getSettingsManager: () => ({ updateSettings }),
    };
    Object.defineProperty(plugin, "modelService", {
      get: () => { throw new Error("forbidden modelService read"); },
    });
    Object.defineProperty(plugin, "getEntitlementService", {
      get: () => { throw new Error("forbidden entitlement read"); },
    });
    return {
      chatView: new ChatView(leaf as never, plugin as never),
      updateSettings,
    };
  }

  it.each([
    "",
    "systemsculpt/ai-agent",
    "systemsculpt@@systemsculpt/managed",
    "openai@@gpt-4.1",
    "local-pi-anthropic@@claude-haiku-4-5",
    "retired-provider@@retired-model",
  ])("normalizes loaded migration input %p before any lookup", async (candidate) => {
    const { chatView } = createChatView("openrouter@@legacy");
    await expect(
      (chatView as ChatView & {
        resolveLoadedSelectedModelId(value: string): Promise<string>;
      }).resolveLoadedSelectedModelId(candidate),
    ).resolves.toBe(CANONICAL_ID);
  });

  it("normalizes restored leaf state and fresh-chat command input", async () => {
    const { chatView } = createChatView("openai@@gpt-4.1");
    expect(chatView.getSelectedModelId()).toBe(CANONICAL_ID);

    jest.spyOn(chatView as never, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "updateSystemPromptIndicator").mockImplementation(() => undefined);
    await chatView.setState({ chatId: "", selectedModelId: "local-pi-openai@@gpt-5.4" });

    expect(chatView.selectedModelId).toBe(CANONICAL_ID);
    expect(chatView.getState().selectedModelId).toBe(CANONICAL_ID);
  });

  it("persists only the canonical identity through the existing settings owner", async () => {
    const { chatView, updateSettings } = createChatView();
    jest.spyOn(chatView, "saveChat").mockResolvedValue(undefined);
    jest.spyOn(chatView as never, "refreshModelMetadata").mockResolvedValue(undefined);
    jest.spyOn(chatView, "focusInput").mockImplementation(() => undefined);
    jest.spyOn(chatView as never, "notifySettingsChanged").mockImplementation(() => undefined);

    await chatView.setSelectedModelId("openrouter@@openai/gpt-5.4-mini");

    expect(chatView.selectedModelId).toBe(CANONICAL_ID);
    expect(updateSettings).toHaveBeenCalledWith({ selectedModelId: CANONICAL_ID });
  });

  it("loads a historical Pi-shaped leaf as legacy without retaining session state", async () => {
    const { chatView } = createChatView();
    (chatView as ChatView & {
      applyChatLeafState(state: object): void;
    }).applyChatLeafState({
      selectedModelId: "local-pi-openai@@gpt-4.1",
      chatBackend: "systemsculpt",
      piSessionFile: "/tmp/pi-session.jsonl",
      piSessionId: "session-123",
    });
    expect(chatView.chatBackend).toBe("legacy");
    expect(chatView.getState()).not.toHaveProperty("piSessionFile");
    expect(chatView.getState()).not.toHaveProperty("piSessionId");
    await expect(chatView.getCurrentSystemPrompt()).resolves.toBe(AGENT_PRESET.systemPrompt);
  });

  it("keeps fresh standard Chat on managed prompt semantics", async () => {
    const { chatView } = createChatView();
    await expect(chatView.getCurrentSystemPrompt()).resolves.toBe(AGENT_PRESET.systemPrompt);
  });
});
