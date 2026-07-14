/** @jest-environment jsdom */
// Embeddings lifecycle coverage is routed through the embeddings test lane.

import {
  SimilaritySearchRunCoordinator,
  type SimilaritySearchRun,
  type SimilaritySearchSource,
} from "../SimilaritySearchRunCoordinator";

const ownerWindow = () => window;

const source = (key: string): SimilaritySearchSource => ({
  kind: "file",
  key,
  file: { path: key } as any,
});

describe("SimilaritySearchRunCoordinator", () => {
  afterEach(() => jest.useRealTimers());

  it("defers hidden sources and flushes the latest source once visible", async () => {
    jest.useFakeTimers();
    let visible = false;
    const execute = jest.fn(async () => undefined);
    const coordinator = new SimilaritySearchRunCoordinator({
      isVisible: () => visible,
      getOwnerWindow: ownerWindow,
      execute,
      onError: jest.fn(),
    });

    await coordinator.run(source("First.md"));
    await coordinator.run(source("Latest.md"));
    expect(coordinator.hasPending()).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    visible = true;
    coordinator.flushPending(10);
    jest.advanceTimersByTime(10);
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].source.key).toBe("Latest.md");
  });

  it("aborts and fences an older run before executing its replacement", async () => {
    let firstRun!: SimilaritySearchRun;
    let release!: () => void;
    const execute = jest.fn((run: SimilaritySearchRun) => {
      if (!firstRun) {
        firstRun = run;
        return new Promise<void>((resolve) => { release = resolve; });
      }
      return Promise.resolve();
    });
    const coordinator = new SimilaritySearchRunCoordinator({
      isVisible: () => true,
      getOwnerWindow: ownerWindow,
      execute,
      onError: jest.fn(),
    });

    const first = coordinator.run(source("First.md"));
    await Promise.resolve();
    await coordinator.run(source("Second.md"));

    expect(firstRun.signal.aborted).toBe(true);
    expect(firstRun.isCurrent()).toBe(false);
    release();
    await first;
    expect(coordinator.isRunning()).toBe(false);
  });

  it("cancels scheduled and active work on close", async () => {
    jest.useFakeTimers();
    let run!: SimilaritySearchRun;
    const coordinator = new SimilaritySearchRunCoordinator({
      isVisible: () => true,
      getOwnerWindow: ownerWindow,
      execute: async (nextRun) => { run = nextRun; await new Promise(() => undefined); },
      onError: jest.fn(),
    });

    coordinator.schedule(source("Scheduled.md"), 100);
    coordinator.close();
    jest.advanceTimersByTime(100);
    expect(run).toBeUndefined();

    coordinator.open();
    void coordinator.run(source("Active.md"));
    await Promise.resolve();
    coordinator.close();
    expect(run.signal.aborted).toBe(true);
    expect(coordinator.isRunning()).toBe(false);
  });

  it("owns scheduled work in the supplied surface window", () => {
    const ownerWindow = {
      setTimeout: jest.fn(() => 41),
      clearTimeout: jest.fn(),
      AbortController,
    } as unknown as Window;
    const coordinator = new SimilaritySearchRunCoordinator({
      isVisible: () => true,
      getOwnerWindow: () => ownerWindow,
      execute: jest.fn(async () => undefined),
      onError: jest.fn(),
    });

    coordinator.schedule(source("Popout.md"), 25);
    coordinator.close();

    expect(ownerWindow.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25);
    expect(ownerWindow.clearTimeout).toHaveBeenCalledWith(41);
  });
});
