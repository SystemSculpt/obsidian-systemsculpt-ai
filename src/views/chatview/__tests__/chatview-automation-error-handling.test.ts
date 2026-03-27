/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";
import { ERROR_CODES, SystemSculptError } from "../../../utils/errors";
import { showPopup } from "../../../core/ui/";

jest.mock("../../../core/ui/", () => ({
  showPopup: jest.fn(),
}));

describe("ChatView automation error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("skips the blocking context overflow popup during automation", async () => {
    const fakeView = {
      inputHandler: {
        isAutomationRequestActive: jest.fn(() => true),
      },
      getEffectiveSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
      resetFailedAssistantTurn: jest.fn().mockResolvedValue(undefined),
      messages: [],
      chatId: "chat-automation-1",
      isGenerating: false,
      app: {},
    };

    await ChatView.prototype.handleError.call(
      fakeView,
      "This request exceeded the maximum context length."
    );

    expect(fakeView.resetFailedAssistantTurn).toHaveBeenCalledTimes(1);
    expect(showPopup).not.toHaveBeenCalled();
  });

  it("skips the blocking credits popup during automation and refreshes credits in the background", async () => {
    const fakeView = {
      inputHandler: {
        isAutomationRequestActive: jest.fn(() => true),
      },
      getEffectiveSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
      resetFailedAssistantTurn: jest.fn().mockResolvedValue(undefined),
      refreshCreditsBalance: jest.fn().mockResolvedValue(undefined),
      messages: [],
      chatId: "chat-automation-2",
      isGenerating: false,
      app: {},
    };

    await ChatView.prototype.handleError.call(
      fakeView,
      new SystemSculptError(
        "Not enough credits to run this request.",
        ERROR_CODES.INSUFFICIENT_CREDITS,
        402,
        {
          creditsRemaining: 0,
          cycleEndsAt: "2026-03-31T00:00:00.000Z",
          purchaseUrl: "https://example.com/buy",
        }
      )
    );

    expect(fakeView.resetFailedAssistantTurn).toHaveBeenCalledTimes(1);
    expect(fakeView.refreshCreditsBalance).toHaveBeenCalledTimes(1);
    expect(showPopup).not.toHaveBeenCalled();
  });
});
