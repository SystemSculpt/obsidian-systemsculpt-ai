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
    licenseKey?: string;
    licenseValid?: boolean;
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
        licenseKey: options?.licenseKey ?? "license_test",
        licenseValid: options?.licenseValid ?? true,
        chatFontSize: "medium",
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

  it("shows a neutral new-chat state with SystemSculpt", () => {
    const chatView = createChatView({
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      cachedModels: [{ id: "systemsculpt@@systemsculpt/ai-agent" }],
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
    expect(statusText).toContain("SystemSculpt");
    expect(statusText).not.toContain("Model");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).not.toContain("Switch Model");
    expect(actionLabels).not.toContain("Switch Prompt");
    expect(actionLabels).not.toContain("Choose Model");
    expect(actionLabels).not.toContain("Copy Log Paths");
    expect(primaryAction).toBe("Add Context");
  });

  it("keeps the managed model state even when the model cache is still cold", () => {
    const chatView = createChatView({
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      cachedModels: [],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    expect(statusText).toContain("New chat");
    expect(statusText).toContain("SystemSculpt");
    expect(statusText).not.toContain("Model");
    expect(statusText).not.toContain("Finish setup");
    expect(statusText).not.toContain("Prompt");
  });

  it("does not ask the user to choose a model when setup is complete", () => {
    const chatView = createChatView({
      selectedModelId: "",
      cachedModels: [{ id: "systemsculpt@@systemsculpt/ai-agent" }],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());

    expect(statusText).toContain("New chat");
    expect(statusText).toContain("Ready");
    expect(statusText).toContain("SystemSculpt");
    expect(statusText).not.toContain("Model");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).not.toContain("Choose Model");
    expect(actionLabels).not.toContain("Switch Prompt");
    expect(actionLabels).toContain("Add Context");
  });

  it("uses SystemSculpt license setup wording when access is not configured", () => {
    const chatView = createChatView({
      selectedModelId: "",
      cachedModels: [],
      licenseKey: "",
      licenseValid: false,
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());

    expect(statusText).toContain("Finish setup");
    expect(statusText).toContain("Setup required");
    expect(statusText).toContain("Add and validate your SystemSculpt license to start chatting.");
    expectNoStandalonePiCopy(statusText);
    expect(actionLabels).toContain("Open Account");
    expect(actionLabels).toHaveLength(1);
  });

  it("does not persist model or prompt selection into new leaf state", () => {
    const chatView = createChatView({
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      cachedModels: [{ id: "systemsculpt@@systemsculpt/ai-agent" }],
    });
    chatView.chatId = "chat-123";
    chatView.chatTitle = "Test Chat";

    const state = chatView.getState();

    expect(state).toEqual(
      expect.objectContaining({
        chatId: "chat-123",
        chatTitle: "Test Chat",
      })
    );
    expect(state).not.toHaveProperty("chatBackend");
    expect(state).not.toHaveProperty("selectedModelId");
    expect(state).not.toHaveProperty("systemPromptType");
    expect(state).not.toHaveProperty("systemPromptPath");
  });
});
