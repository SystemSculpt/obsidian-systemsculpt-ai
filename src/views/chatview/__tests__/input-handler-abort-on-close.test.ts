/**
 * @jest-environment jsdom
 */

import { InputHandler } from "../InputHandler";
import {
  ChatTurnAlreadyActiveError,
  ChatTurnLifecycleController,
} from "../controllers/ChatTurnLifecycleController";

type AbortHarness = {
  handler: InputHandler & Record<string, any>;
  turnLifecycle: ChatTurnLifecycleController;
  isGenerating: () => boolean;
  generatingTransitions: boolean[];
};

const createAbortHarness = (): AbortHarness => {
  const handler = Object.create(InputHandler.prototype) as InputHandler & Record<string, any>;
  let generating = false;
  const generatingTransitions: boolean[] = [];
  const turnLifecycle = new ChatTurnLifecycleController({
    getIsGenerating: () => generating,
    setGenerating: (next) => {
      generating = next;
      generatingTransitions.push(next);
    },
  });

  handler.turnLifecycle = turnLifecycle;
  handler.localResourcesDisposed = false;
  handler.renderTimeout = null;
  handler.recorderVisualizer = null;
  handler.recorderToggleUnsubscribe = null;
  handler.chatContainer = document.createElement("div");

  return { handler, turnLifecycle, isGenerating: () => generating, generatingTransitions };
};

const startSettlingTurn = async (turnLifecycle: ChatTurnLifecycleController) => {
  let settle!: () => void;
  let capturedSignal!: AbortSignal;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const signalReady = new Promise<void>((resolve) => {
    void turnLifecycle.runTurn(async (signal) => {
      capturedSignal = signal;
      resolve();
      await settlement;
    });
  });
  await signalReady;
  return { signal: capturedSignal, settle };
};

describe("InputHandler authoritative turn cancellation", () => {
  test("Stop requests abort but retains generating ownership until the terminal promise settles", async () => {
    const { handler, turnLifecycle, isGenerating, generatingTransitions } = createAbortHarness();
    const { signal, settle } = await startSettlingTurn(turnLifecycle);

    expect(turnLifecycle.getState()).toBe("running");
    expect(isGenerating()).toBe(true);

    const terminal = handler.abortActiveTurn();

    expect(terminal).toBeInstanceOf(Promise);
    expect(signal.aborted).toBe(true);
    expect(turnLifecycle.getState()).toBe("settling");
    expect(isGenerating()).toBe(true);
    expect(generatingTransitions).toEqual([true]);

    settle();
    await terminal;

    expect(turnLifecycle.getState()).toBe("terminal");
    expect(isGenerating()).toBe(false);
    expect(generatingTransitions).toEqual([true, false]);
  });

  test("close requests abort and cleanup remains owned by the active turn finally", async () => {
    const { handler, turnLifecycle, isGenerating, generatingTransitions } = createAbortHarness();
    const { signal, settle } = await startSettlingTurn(turnLifecycle);

    handler.disposeLocalResources();

    expect(signal.aborted).toBe(true);
    expect(turnLifecycle.getState()).toBe("settling");
    expect(isGenerating()).toBe(true);
    expect(generatingTransitions).toEqual([true]);

    settle();
    await turnLifecycle.stop();

    expect(turnLifecycle.getState()).toBe("terminal");
    expect(isGenerating()).toBe(false);
    expect(generatingTransitions).toEqual([true, false]);
  });

  test("repeated Stop calls share terminal ownership and clear generating exactly once", async () => {
    const { turnLifecycle, isGenerating, generatingTransitions } = createAbortHarness();
    const { signal, settle } = await startSettlingTurn(turnLifecycle);

    const firstTerminal = turnLifecycle.stop();
    const secondTerminal = turnLifecycle.stop();

    expect(firstTerminal).toBe(secondTerminal);
    expect(signal.aborted).toBe(true);
    expect(isGenerating()).toBe(true);
    expect(generatingTransitions).toEqual([true]);

    settle();
    await Promise.all([firstTerminal, secondTerminal]);

    expect(isGenerating()).toBe(false);
    expect(generatingTransitions).toEqual([true, false]);
  });

  test("rejected terminal settlement still cleans resources once and does not poison later disposal", async () => {
    const { handler, turnLifecycle, generatingTransitions } = createAbortHarness();
    const recorderToggleUnsubscribe = jest.fn();
    const cleanupAllStatusIndicators = jest.fn();
    handler.recorderToggleUnsubscribe = recorderToggleUnsubscribe;
    handler.cleanupAllStatusIndicators = cleanupAllStatusIndicators;

    let rejectTurn!: (error: Error) => void;
    const signalReady = new Promise<void>((resolve) => {
      const running = turnLifecycle.runTurn(async () => {
        resolve();
        await new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
      });
      void running.catch(() => {});
    });
    await signalReady;

    const persistenceError = new Error("assistant persistence failed");
    const disposal = handler.disposeLocalResources();
    rejectTurn(persistenceError);

    await expect(disposal).rejects.toBe(persistenceError);
    expect(recorderToggleUnsubscribe).toHaveBeenCalledTimes(1);
    expect(cleanupAllStatusIndicators).toHaveBeenCalledTimes(1);
    expect(generatingTransitions).toEqual([true, false]);

    await expect(handler.disposeLocalResources()).resolves.toBeUndefined();
    expect(recorderToggleUnsubscribe).toHaveBeenCalledTimes(1);
    expect(cleanupAllStatusIndicators).toHaveBeenCalledTimes(1);
  });

  test("rejects a concurrent turn immediately without waiting for the active terminal promise", async () => {
    const { turnLifecycle, generatingTransitions } = createAbortHarness();
    const { settle } = await startSettlingTurn(turnLifecycle);
    const secondExecutor = jest.fn();

    const second = turnLifecycle.runTurn(secondExecutor);
    await expect(second).rejects.toEqual(expect.objectContaining({
      code: "chat_turn_already_active",
      state: "running",
    }));
    expect(secondExecutor).not.toHaveBeenCalled();
    expect(generatingTransitions).toEqual([true]);

    settle();
    await turnLifecycle.stop();
  });

  test("exposes a typed already-active error contract", () => {
    const error = new ChatTurnAlreadyActiveError("settling");
    expect(error).toEqual(expect.objectContaining({
      code: "chat_turn_already_active",
      state: "settling",
      name: "ChatTurnAlreadyActiveError",
    }));
  });

  test("abortActiveTurn is an already-settled no-op when idle", async () => {
    const { handler, isGenerating, generatingTransitions } = createAbortHarness();

    await expect(handler.abortActiveTurn()).resolves.toBeUndefined();
    expect(isGenerating()).toBe(false);
    expect(generatingTransitions).toEqual([]);
  });
});
