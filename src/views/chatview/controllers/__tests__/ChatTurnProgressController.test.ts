/**
 * @jest-environment jsdom
 */

import { ChatTurnProgressController } from "../ChatTurnProgressController";

describe("ChatTurnProgressController", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps one elapsed turn status across stream, tool execution, and retry phases", () => {
    const showStreamingStatus = jest.fn();
    const hideStreamingStatus = jest.fn();
    const updateStreamingStatus = jest.fn();
    const firstMessageEl = document.createElement("div");
    const secondMessageEl = document.createElement("div");

    const progress = new ChatTurnProgressController({
      showStreamingStatus,
      hideStreamingStatus,
      updateStreamingStatus,
    });

    progress.begin(firstMessageEl);
    progress.setStatus("reasoning");
    progress.setStatus("executing_tools");
    progress.attach(secondMessageEl);
    progress.setStatus("retrying");
    progress.end();

    expect(showStreamingStatus).toHaveBeenCalledWith(firstMessageEl);
    expect(showStreamingStatus).toHaveBeenCalledWith(secondMessageEl);
    expect(updateStreamingStatus).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      "reasoning",
      "Thinking\u2026",
      expect.objectContaining({ status: "reasoning" })
    );
    expect(updateStreamingStatus).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      "executing_tools",
      "Running tools\u2026",
      expect.objectContaining({ status: "executing_tools" })
    );
    expect(updateStreamingStatus).toHaveBeenCalledWith(
      secondMessageEl,
      "retrying",
      "Retrying response\u2026",
      expect.objectContaining({ status: "retrying" })
    );
    expect(hideStreamingStatus).toHaveBeenCalledWith(secondMessageEl);
  });
});
