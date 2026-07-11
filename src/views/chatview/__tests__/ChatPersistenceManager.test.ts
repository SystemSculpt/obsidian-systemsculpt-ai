import { ChatPersistenceManager } from "../persistence/ChatPersistenceManager";
import { ChatPersistenceError } from "../persistence/ChatPersistenceError";

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
    expect(onAssistantResponse).not.toHaveBeenCalled();

    // The stale autosave must settle before the authoritative assistant write.
    resolveFirst && resolveFirst();
    for (let index = 0; index < 6 && onAssistantResponse.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(onAssistantResponse).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 6 && saveChat.mock.calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(saveChat).toHaveBeenCalledTimes(2);

    // Finish second save and ensure commit resolves
    resolveSecond && resolveSecond();
    await commitPromise;
  });

  it("does not self-deadlock when authoritative persistence re-enters the idle seam", async () => {
    let manager!: ChatPersistenceManager;
    const saveChat = jest.fn().mockResolvedValue(undefined);
    manager = new ChatPersistenceManager({
      saveChat,
      onAssistantResponse: jest.fn(async () => manager.waitForIdle()),
    });

    await expect(manager.commit({ role: "assistant", content: "final", message_id: "a-reentrant" } as any))
      .resolves.toBeUndefined();
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it("prevents assistant persistence when the in-flight autosave fails", async () => {
    const cause = new Error("stale autosave failed");
    let rejectAutosave!: (cause: Error) => void;
    const onAssistantResponse = jest.fn().mockResolvedValue(undefined);
    const manager = new ChatPersistenceManager({
      debounceMs: 10,
      chatId: () => "chat-race",
      saveChat: jest.fn().mockReturnValue(new Promise<void>((_, reject) => { rejectAutosave = reject; })),
      onAssistantResponse,
    });

    manager.scheduleAutosave();
    jest.advanceTimersByTime(20);
    await Promise.resolve();
    const commit = manager.commit({ role: "assistant", content: "final", message_id: "a-race" } as any);
    rejectAutosave(cause);

    await expect(commit).rejects.toMatchObject({
      operation: "flush",
      chatId: "chat-race",
      cause,
    });
    expect(onAssistantResponse).not.toHaveBeenCalled();
  });

  it("rejects the final flush with a typed persistence error", async () => {
    const cause = new Error("final write failed");
    const manager = new ChatPersistenceManager({
      debounceMs: 200,
      chatId: () => "chat-final",
      saveChat: jest.fn().mockRejectedValue(cause),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
    });

    await expect(
      manager.commit({ role: "assistant", content: "done", message_id: "m-final" } as any)
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChatPersistenceError>>({
        name: "ChatPersistenceError",
        code: "chat_persistence_failed",
        operation: "flush",
        chatId: "chat-final",
        cause,
      })
    );
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
    ).rejects.toEqual(expect.objectContaining({
      code: "chat_persistence_failed",
      operation: "assistant_commit",
      cause: failure,
    }));

    expect(saveChat).not.toHaveBeenCalled();
  });
});
