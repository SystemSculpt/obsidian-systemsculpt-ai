/**
 * @jest-environment jsdom
 */

import { handleKeyDown } from "../UIKeyHandlers";

describe("UIKeyHandlers", () => {
  beforeEach(() => {
    (console.log as any).mockClear?.();
  });

  test("blocks Enter-to-send while chat is still loading", async () => {
    const input = document.createElement("textarea");
    const handleSendMessage = jest.fn(async () => {});

    const event = new KeyboardEvent("keydown", { key: "Enter" });
    await handleKeyDown(
      {
        isChatReady: () => false,
        isGenerating: () => false,
        handleSendMessage,
        handleStopGeneration: jest.fn(),
        input,
      },
      event
    );

    expect(handleSendMessage).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("Notice: Chat is still loading—please wait a moment.");
  });
});

