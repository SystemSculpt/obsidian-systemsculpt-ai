/** @jest-environment jsdom */

import { ItemView } from "obsidian";
import { ChatView } from "../ChatView";

describe("ChatView close settlement ownership", () => {
  it("awaits the active turn before clearing messages, DOM, or view resources", async () => {
    const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    const message = { role: "assistant", content: "settling", message_id: "assistant-1" };
    const chatContainer = document.createElement("div");
    chatContainer.appendChild(document.createElement("div"));
    let settle!: () => void;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    const order: string[] = [];

    view.messages = [message];
    view.chatContainer = chatContainer;
    view.resourcesDisposed = false;
    view.resourceDisposalPromise = null;
    view.dragDropCleanup = jest.fn(() => order.push("drag-cleanup"));
    view.scrollManager = { cleanup: jest.fn(() => order.push("scroll-cleanup")), destroy: jest.fn() };
    view.contextManager = { destroy: jest.fn(() => order.push("context-cleanup")) };
    view.inputHandler = {
      abortActiveTurn: jest.fn(() => terminal.then(() => {
        order.push("terminal-persistence");
        chatContainer.appendChild(document.createElement("span"));
      })),
      disposeLocalResources: jest.fn(async () => { order.push("input-cleanup"); }),
      unload: jest.fn(),
    };

    const closing = view.onClose();
    await Promise.resolve();

    expect(view.messages).toEqual([message]);
    expect(chatContainer.childElementCount).toBe(1);
    expect(order).toEqual([]);

    settle();
    await closing;

    expect(order).toEqual([
      "terminal-persistence",
      "input-cleanup",
      "drag-cleanup",
      "scroll-cleanup",
      "context-cleanup",
    ]);
    expect(view.messages).toEqual([]);
    expect(view.inputHandler.disposeLocalResources).toHaveBeenCalledTimes(1);
    expect(view.scrollManager.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans and calls super exactly once when terminal settlement rejects", async () => {
    const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    const terminalError = new Error("tool checkpoint persistence failed");
    const inputCleanup = jest.fn().mockRejectedValue(terminalError);
    const scrollCleanup = jest.fn();
    const contextCleanup = jest.fn();
    const superClose = jest.spyOn(ItemView.prototype, "onClose").mockResolvedValue(undefined);

    view.messages = [{ role: "assistant", content: "pending", message_id: "assistant-1" }];
    view.resourcesDisposed = false;
    view.resourceDisposalPromise = null;
    view.dragDropCleanup = jest.fn();
    view.scrollManager = { cleanup: scrollCleanup, destroy: jest.fn() };
    view.contextManager = { destroy: contextCleanup };
    view.inputHandler = {
      abortActiveTurn: jest.fn().mockRejectedValue(terminalError),
      disposeLocalResources: inputCleanup,
      unload: jest.fn(),
    };

    await expect(view.onClose()).rejects.toBe(terminalError);

    expect(view.messages).toEqual([]);
    expect(inputCleanup).toHaveBeenCalledTimes(1);
    expect(scrollCleanup).toHaveBeenCalledTimes(1);
    expect(contextCleanup).toHaveBeenCalledTimes(1);
    expect(superClose).toHaveBeenCalledTimes(1);

    await expect((view as any).disposeViewResources()).resolves.toBeUndefined();
    expect(inputCleanup).toHaveBeenCalledTimes(1);
    expect(scrollCleanup).toHaveBeenCalledTimes(1);
    expect(superClose).toHaveBeenCalledTimes(1);
    superClose.mockRestore();
  });
});
