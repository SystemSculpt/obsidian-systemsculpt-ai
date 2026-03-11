import { chatSettingsHandling } from "../chatSettingsHandling";
import { showStandardChatSettingsModal } from "../../../modals/StandardChatSettingsModal";

jest.mock("../../../modals/StandardChatSettingsModal", () => ({
  showStandardChatSettingsModal: jest.fn(),
}));

describe("chatSettingsHandling", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("opens chat settings modal with chat display context", async () => {
    const chatView: any = {
      app: { id: "app" },
      plugin: { id: "plugin" },
      chatFontSize: "large",
      handleError: jest.fn(),
    };

    (showStandardChatSettingsModal as jest.Mock).mockResolvedValue(true);

    await chatSettingsHandling.openChatSettings(chatView);

    expect(showStandardChatSettingsModal).toHaveBeenCalled();
    const [, options] = (showStandardChatSettingsModal as jest.Mock).mock.calls[0];
    expect(options.chatView).toBe(chatView);
    expect(options.plugin).toBe(chatView.plugin);
  });

  it("handles errors by delegating to chatView.handleError", async () => {
    const chatView: any = {
      app: {},
      plugin: {},
      chatFontSize: "medium",
      handleError: jest.fn(),
    };

    (showStandardChatSettingsModal as jest.Mock).mockRejectedValue(new Error("fail"));

    await chatSettingsHandling.openChatSettings(chatView);
    expect(chatView.handleError).toHaveBeenCalledWith("Failed to open chat settings");
  });
});
