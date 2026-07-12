/**
 * @jest-environment jsdom
 */

import { App, WorkspaceLeaf } from "obsidian";
import { SystemSculptService } from "../../../services/SystemSculptService";
import { EntitlementService } from "../../../services/entitlement/EntitlementService";
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
    customProviders?: Array<Record<string, unknown>>;
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
        customProviders: options?.customProviders ?? [],
        mcpServers: [],
      },
      modelService: {
        getCachedModels: jest.fn(() => options?.cachedModels ?? []),
      },
      openSettingsTab: jest.fn(),
    };
    // The real entitlement service (#209) drives the gating decisions under test.
    plugin.getEntitlementService = () => new EntitlementService(plugin);

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

  it("never walls a BYOK user with a configured custom provider, even with no license (#209)", () => {
    // The May 2026 bug: a BYOK user (own OpenRouter key, no SystemSculpt
    // license) was blocked from Chat by a license prompt purely because the
    // managed model was the default selection. Same no-license inputs as the
    // test above, but WITH a configured custom provider — they must land on a
    // ready state, never the "Setup required" / "Open Account" wall.
    const chatView = createChatView({
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      cachedModels: [],
      licenseKey: "",
      licenseValid: false,
      customProviders: [
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "byok-key",
          isEnabled: true,
        },
      ],
    });

    chatView.displayChatStatus();

    const statusText = chatView.chatContainer.textContent || "";
    const actionLabels = Array.from(
      chatView.chatContainer.querySelectorAll(".systemsculpt-chat-status-action-label")
    ).map((el) => el.textContent?.trim());

    expect(statusText).not.toContain("Finish setup");
    expect(statusText).not.toContain("Setup required");
    expect(statusText).not.toContain("Add and validate your SystemSculpt license");
    expect(actionLabels).not.toContain("Open Account");
    // Lands on the normal ready state with the usual primary action.
    expect(statusText).toContain("New chat");
    expect(statusText).toContain("Ready");
    expect(actionLabels).toContain("Add Context");
  });

  it("persists the active model and backend into leaf state without reviving legacy prompt fields", () => {
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
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        chatBackend: "systemsculpt",
      })
    );
    expect(state).not.toHaveProperty("systemPromptType");
    expect(state).not.toHaveProperty("systemPromptPath");
  });
});
