import { yieldToEventLoop } from "../yieldToEventLoop";

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
