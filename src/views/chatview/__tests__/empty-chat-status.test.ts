/**
 * @jest-environment jsdom
 */

import { App, WorkspaceLeaf } from "obsidian";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { ChatView } from "../ChatView";

describe("ChatView empty chat status", () => {
  const expectNoStandalonePiCopy = (text: string) => {
    expect(text).not.toMatch(/\bPi\b/);
  };

  beforeEach(() => {
    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const createChatView = (options?: {
    selectedModelId?: string;
    cachedModels?: Array<{ id: string }>;
  }) => {
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
        selectedModelId: options?.selectedModelId ?? "",
        chatFontSize: "medium",
        systemPromptType: "general-use",
        systemPromptPath: "",
        respectReducedMotion: false,
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
        mcpServers: [],
      },
      modelService: {
        getCachedModels: jest.fn(() => options?.cachedModels ?? []),
      },
      openSettingsTab: jest.fn(),
    };

    const chatView = new ChatView(leaf as any, plugin);
    chatView.chatContainer = document.createElement("div");
    chatView.contextManager = {
      getContextFiles: jest.fn(() => new Set()),
    } as any;
    document.body.appendChild(chatView.chatContainer);
    return chatView;
  };

  it("shows a neutral new-chat state when a model is already selected", () => {
    const chatView = createChatView({
      selectedModelId: "openai-codex@@gpt-5.3-codex-spark",
      cachedModels: [{ id: "openai-codex@@gpt-5.3-codex-spark" }],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());
    const primaryAction = chatView.chatContainer.querySelector(
      ".systemsculpt-chat-status-action.mod-cta .systemsculpt-chat-status-action-label"
    )?.textContent;

    expect(statusText).toContain("New chat");
    expect(statusText).toContain("Ready");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).toContain("Switch Model");
    expect(actionLabels).not.toContain("Choose Model");
    expect(actionLabels).not.toContain("Copy Log Paths");
    expect(primaryAction).toBe("Add Context");
  });

  it("treats a saved model selection as configured even when the model cache is still cold", () => {
    const chatView = createChatView({
      selectedModelId: "openai-codex@@gpt-5.3-codex-spark",
      cachedModels: [],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    expect(statusText).toContain("New chat");
    expect(statusText).toContain("Switch Model");
    expect(statusText).not.toContain("Finish setup");
  });

  it("keeps model selection guidance when providers are ready but no model is selected", () => {
    const chatView = createChatView({
      selectedModelId: "",
      cachedModels: [{ id: "openai-codex@@gpt-5.3-codex-spark" }],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());

    expect(statusText).toContain("Choose a model");
    expect(statusText).toContain("Almost ready");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).toContain("Choose Model");
    expect(actionLabels).not.toContain("Add Context");
  });

  it("uses generic setup wording when providers are not configured", () => {
    const chatView = createChatView({
      selectedModelId: "",
      cachedModels: [],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());

    expect(statusText).toContain("Finish setup");
    expect(statusText).toContain("Setup required");
    expect(statusText).toContain("Connect a provider, then choose a model.");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).toContain("Open Setup");
    expect(actionLabels).toHaveLength(1);
  });
});
