import { waitForIdle, yieldToEventLoop } from "../yieldToEventLoop";

describe("yieldToEventLoop", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits for the next macrotask before continuing", async () => {
    let firstTimerRan = false;

    setTimeout(() => {
      firstTimerRan = true;
    }, 0);

    let continued = false;
    const promise = (async () => {
      await yieldToEventLoop();
      continued = true;
      expect(firstTimerRan).toBe(true);
    })();

    expect(firstTimerRan).toBe(false);
    expect(continued).toBe(false);

    jest.runOnlyPendingTimers();
    await promise;

    expect(continued).toBe(true);
  });
});

describe("waitForIdle", () => {
  const idleWindow = window as Window & {
    requestIdleCallback?: unknown;
    cancelIdleCallback?: unknown;
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete idleWindow.requestIdleCallback;
    delete idleWindow.cancelIdleCallback;
  });

  it("runs on the host idle callback with the timeout as a deadline", async () => {
    let idle: (() => void) | null = null;
    idleWindow.requestIdleCallback = jest.fn((callback: () => void) => {
      idle = callback;
      return 7;
    });
    const waiting = waitForIdle(5_000);

    expect(idleWindow.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 5_000 });
    idle!();
    await expect(waiting).resolves.toBe(true);
  });

  it("falls back to the timeout where idle callbacks are unavailable", async () => {
    const waiting = waitForIdle(2_000);
    let settled = false;
    void waiting.then(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe(true);
  });

  it("cancels the pending wait when its owner aborts", async () => {
    const cancelIdleCallback = jest.fn();
    idleWindow.requestIdleCallback = jest.fn(() => 11);
    idleWindow.cancelIdleCallback = cancelIdleCallback;
    const controller = new AbortController();
    const waiting = waitForIdle(5_000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(cancelIdleCallback).toHaveBeenCalledWith(11);
    await expect(waitForIdle(5_000, controller.signal)).resolves.toBe(false);
  });
});
