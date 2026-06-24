/**
 * @jest-environment jsdom
 */

import { InputHandler } from "../InputHandler";
import { ChatTurnLifecycleController } from "../controllers/ChatTurnLifecycleController";

/**
 * Guard for BUG-03: closing a chat view (or disposing its input handler) while a
 * turn is streaming must abort the in-flight stream.
 *
 * Previously the only teardown hook called a phantom abort method on the input
 * handler that never existed, so the `turnLifecycle` AbortController was never
 * aborted on close — the stream, its rAF metrics ticker, and autosave all kept
 * running into a removed view, burning tokens/credits. The real abort
 * (`turnLifecycle.stop()`) was reachable only via the Stop button.
 *
 * These tests drive the real ChatTurnLifecycleController so a regression in the
 * teardown wiring re-breaks them.
 */

type AbortHarness = {
  handler: InputHandler & Record<string, any>;
  turnLifecycle: ChatTurnLifecycleController;
  isGenerating: () => boolean;
};

const createAbortHarness = (): AbortHarness => {
  const handler = Object.create(InputHandler.prototype) as InputHandler & Record<string, any>;

  let generating = false;
  const turnLifecycle = new ChatTurnLifecycleController({
    getIsGenerating: () => generating,
    setGenerating: (next) => {
      generating = next;
    },
  });

  handler.turnLifecycle = turnLifecycle;

  // Minimal fields disposeLocalResources() touches so the dispose path runs.
  handler.localResourcesDisposed = false;
  handler.renderTimeout = null;
  handler.recorderVisualizer = null;
  handler.recorderToggleUnsubscribe = null;
  handler.chatContainer = document.createElement("div");

  return { handler, turnLifecycle, isGenerating: () => generating };
};

/**
 * Start a turn that hangs until its signal aborts, returning the captured signal.
 */
const startHangingTurn = (turnLifecycle: ChatTurnLifecycleController): Promise<AbortSignal> => {
  return new Promise<AbortSignal>((resolveSignal) => {
    void turnLifecycle.runTurn(
      (signal) =>
        new Promise<void>((resolveTurn) => {
          resolveSignal(signal);
          if (signal.aborted) {
            resolveTurn();
            return;
          }
          signal.addEventListener("abort", () => resolveTurn(), { once: true });
        })
    );
  });
};

describe("InputHandler abort-on-close (BUG-03)", () => {
  test("abortActiveTurn aborts the in-flight turn's controller", async () => {
    const { handler, turnLifecycle, isGenerating } = createAbortHarness();

    const signal = await startHangingTurn(turnLifecycle);
    expect(signal.aborted).toBe(false);
    expect(isGenerating()).toBe(true);

    handler.abortActiveTurn();

    expect(signal.aborted).toBe(true);
    expect(isGenerating()).toBe(false);
  });

  test("the input handler dispose path aborts the in-flight turn", async () => {
    const { handler, turnLifecycle } = createAbortHarness();

    const signal = await startHangingTurn(turnLifecycle);
    expect(signal.aborted).toBe(false);

    // disposeLocalResources() is the route both unload() and onunload() funnel
    // through, and is reached from ChatView.disposeViewResources() via
    // inputHandler.unload(). Tearing down must abort the active stream.
    handler.disposeLocalResources();

    expect(signal.aborted).toBe(true);
  });

  test("abortActiveTurn is a no-op when idle (no throw, no active turn)", () => {
    const { handler, isGenerating } = createAbortHarness();

    expect(() => handler.abortActiveTurn()).not.toThrow();
    expect(isGenerating()).toBe(false);
  });
});
