import { systemPromptHandling } from "../systemPromptHandling";
import { showStandardChatSettingsModal } from "../../../modals/StandardChatSettingsModal";

jest.mock("../../../modals/StandardChatSettingsModal", () => ({
  showStandardChatSettingsModal: jest.fn(),
}));

describe("systemPromptHandling", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("opens settings modal with current chat context", async () => {
    const chatView: any = {
      app: { id: "app" },
      plugin: { id: "plugin" },
      getCurrentSystemPrompt: jest.fn(async () => "Current Prompt"),
      systemPromptType: "general-use",
      systemPromptPath: "Prompts/System.md",
      getChatTitle: jest.fn(() => "Chat Title"),
      setTitle: jest.fn(async () => {}),
      getMessages: jest.fn(() => [{ role: "user", content: "hi" }]),
      getSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
      setSelectedModelId: jest.fn(async () => {}),
      handleError: jest.fn(),
    };

    (showStandardChatSettingsModal as jest.Mock).mockResolvedValue(true);

    await systemPromptHandling.handleSystemPromptEdit(chatView);

    expect(showStandardChatSettingsModal).toHaveBeenCalled();
    const [, options] = (showStandardChatSettingsModal as jest.Mock).mock.calls[0];
    expect(options.currentPrompt).toBe("Current Prompt");
    expect(options.currentSystemPromptType).toBe("general-use");
    expect(options.systemPromptPath).toBe("Prompts/System.md");
    expect(options.chatTitle).toBe("Chat Title");
    expect(options.messages).toEqual([{ role: "user", content: "hi" }]);

    await options.onTitleChange("New Title");
    expect(chatView.setTitle).toHaveBeenCalledWith("New Title");

    await options.onModelSelect("systemsculpt@@systemsculpt/ai-agent");
    expect(chatView.setSelectedModelId).toHaveBeenCalledWith("systemsculpt@@systemsculpt/ai-agent");
  });

  it("handles errors by delegating to chatView.handleError", async () => {
    const chatView: any = {
      app: {},
      plugin: {},
      getCurrentSystemPrompt: jest.fn(async () => "Prompt"),
      systemPromptType: "general-use",
      systemPromptPath: "",
      getChatTitle: jest.fn(() => "Title"),
      setTitle: jest.fn(async () => {}),
      getMessages: jest.fn(() => []),
      getSelectedModelId: jest.fn(() => "model"),
      setSelectedModelId: jest.fn(async () => {}),
      handleError: jest.fn(),
    };

    (showStandardChatSettingsModal as jest.Mock).mockRejectedValue(new Error("fail"));

    await systemPromptHandling.handleSystemPromptEdit(chatView);
    expect(chatView.handleError).toHaveBeenCalledWith("Failed to edit system prompt");
  });
});

