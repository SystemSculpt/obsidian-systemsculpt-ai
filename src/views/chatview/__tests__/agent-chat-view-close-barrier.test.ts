/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";

describe("AgentChatView close barrier", () => {
  it("reuses one close operation for producer quiescence and Obsidian detach", async () => {
    let finishClose!: () => void;
    const pendingClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const performClose = jest.fn(() => pendingClose);
    const view = Object.create(AgentChatView.prototype) as {
      closeBarrier: Promise<void> | null;
      performClose: () => Promise<void>;
      quiesceIncidentProducers: () => Promise<void>;
      onClose: () => Promise<void>;
    };
    view.closeBarrier = null;
    view.performClose = performClose;

    const producerBarrier = view.quiesceIncidentProducers();
    const obsidianClose = view.onClose();

    expect(performClose).toHaveBeenCalledTimes(1);
    expect(obsidianClose).toBe(producerBarrier);

    finishClose();
    await expect(Promise.all([producerBarrier, obsidianClose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
