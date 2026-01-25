import { ChatPersistenceManager } from "../persistence/ChatPersistenceManager";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe("ChatPersistenceManager", () => {
  it("debounces autosave requests and flushes once", async () => {
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const manager = new ChatPersistenceManager({
      debounceMs: 200,
      saveChat,
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
    });

    manager.scheduleAutosave();
    manager.scheduleAutosave();
    manager.scheduleAutosave();

    expect(saveChat).not.toHaveBeenCalled();

    jest.advanceTimersByTime(250);
    await Promise.resolve();

    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it("commits immediately and clears pending autosave", async () => {
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const onAssistantResponse = jest.fn().mockResolvedValue(undefined);
    const manager = new ChatPersistenceManager({
      debounceMs: 500,
      saveChat,
      onAssistantResponse,
    });

    manager.scheduleAutosave();
    jest.advanceTimersByTime(200);

    await manager.commit({
      role: "assistant",
      content: "Final",
      message_id: "m-1",
    } as any);

    expect(onAssistantResponse).toHaveBeenCalledTimes(1);
    expect(saveChat).toHaveBeenCalledTimes(1);

    // Pending timer cleared - advancing time should not trigger another save
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it("propagates onAssistantResponse failures (no silent loss)", async () => {
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const onAssistantResponse = jest.fn().mockRejectedValue(new Error("disk write failed"));
    const manager = new ChatPersistenceManager({
      debounceMs: 200,
      saveChat,
      onAssistantResponse,
    });

    await expect(
      manager.commit({ role: "assistant", content: "x", message_id: "m2" } as any)
    ).rejects.toThrow(/disk write failed/);

    // No save should occur after a failed persistence
    expect(saveChat).not.toHaveBeenCalled();
  });

  it("waits for in-flight autosave and persists final state on commit", async () => {
    jest.useFakeTimers();
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;
    const saveChat = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((res) => { resolveFirst = res; })
      )
      .mockImplementationOnce(
        () => new Promise<void>((res) => { resolveSecond = res; })
      );

    const onAssistantResponse = jest.fn().mockResolvedValue(undefined);
    const manager = new ChatPersistenceManager({ debounceMs: 10, saveChat, onAssistantResponse });

    // Trigger debounced autosave, then flush
    manager.scheduleAutosave();
    jest.advanceTimersByTime(20);
    await Promise.resolve();
    expect(saveChat).toHaveBeenCalledTimes(1); // first save in-flight

    // While first save is in-flight, commit is called
    const commitPromise = manager.commit({ role: 'assistant', content: 'X', message_id: 'm3' } as any);
    expect(onAssistantResponse).toHaveBeenCalledTimes(1);

    // Finish first save; loop should detect queued flush and perform second save
    resolveFirst && resolveFirst();
    await Promise.resolve();
    expect(saveChat).toHaveBeenCalledTimes(2);

    // Finish second save and ensure commit resolves
    resolveSecond && resolveSecond();
    await commitPromise;
  });

  it("propagates assistant persistence errors", async () => {
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const failure = new Error("write failed");
    const onAssistantResponse = jest.fn().mockRejectedValue(failure);
    const manager = new ChatPersistenceManager({
      debounceMs: 200,
      saveChat,
      onAssistantResponse,
    });

    await expect(
      manager.commit({
        role: "assistant",
        content: "oops",
        message_id: "m-err",
      } as any)
    ).rejects.toThrow(failure);

    expect(saveChat).not.toHaveBeenCalled();
  });
});
