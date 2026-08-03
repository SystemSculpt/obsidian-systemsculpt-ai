import {
  AgentConversationSessionBinding,
  type AgentConversationDetachConfirmation,
} from "../AgentConversationSessionBinding";

type Snapshot = Readonly<{ source: string }>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(name: string, detach: () => Promise<void> = async () => undefined) {
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let lastSubscribedListener: ((snapshot: Snapshot) => void) | null = null;
  const value = {
    name,
    subscribe: jest.fn((listener: (snapshot: Snapshot) => void) => {
      listeners.add(listener);
      lastSubscribedListener = listener;
      return () => { listeners.delete(listener); };
    }),
    detach: jest.fn(detach),
    emit(snapshot: Snapshot = { source: name }): void {
      for (const listener of listeners) listener(snapshot);
    },
    emitFromStaleTransport(snapshot: Snapshot = { source: name }): void {
      lastSubscribedListener?.(snapshot);
    },
  };
  return value;
}

describe("AgentConversationSessionBinding", () => {
  it("requires confirmation from the exact outgoing binding before attach", async () => {
    const first = session("first");
    const other = session("other");
    const next = session("next");
    const firstBinding = new AgentConversationSessionBinding(
      first,
      jest.fn(),
    );
    const otherBinding = new AgentConversationSessionBinding(
      other,
      jest.fn(),
    );
    const firstConfirmation = await firstBinding.detach();
    const otherConfirmation = await otherBinding.detach();

    expect(() => firstBinding.attach(next, undefined)).toThrow(
      "exact outgoing session",
    );
    expect(() => firstBinding.attach(next, otherConfirmation)).toThrow(
      "exact outgoing session",
    );
    expect(next.subscribe).not.toHaveBeenCalled();

    firstBinding.attach(next, firstConfirmation);

    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(next.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not attach until the outgoing session-specific detach barrier resolves", async () => {
    const releaseDetach = deferred();
    const outgoing = session("outgoing", () => releaseDetach.promise);
    const incoming = session("incoming");
    const presented: Snapshot[] = [];
    const binding = new AgentConversationSessionBinding(
      outgoing,
      (_session, snapshot) => presented.push(snapshot),
    );

    outgoing.emit();
    const replacing = binding.replace(() => incoming);
    await Promise.resolve();
    outgoing.emitFromStaleTransport({ source: "stale-during-detach" });

    expect(outgoing.detach).toHaveBeenCalledTimes(1);
    expect(incoming.subscribe).not.toHaveBeenCalled();
    expect(presented).toEqual([{ source: "outgoing" }]);

    releaseDetach.resolve();
    await expect(replacing).resolves.toBe(incoming);
    incoming.emit();
    outgoing.emitFromStaleTransport({ source: "stale-after-switch" });

    expect(presented).toEqual([
      { source: "outgoing" },
      { source: "incoming" },
    ]);
  });

  it("serializes rapid switches and fences callbacks from every stale session", async () => {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const first = session("first", () => releaseFirst.promise);
    const second = session("second", () => releaseSecond.promise);
    const third = session("third");
    const presented: string[] = [];
    const binding = new AgentConversationSessionBinding(
      first,
      (_session, snapshot) => presented.push(snapshot.source),
    );

    const switchToSecond = binding.replace(() => second);
    const switchToThird = binding.replace(() => third);
    await Promise.resolve();

    expect(second.subscribe).not.toHaveBeenCalled();
    expect(third.subscribe).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(switchToSecond).resolves.toBe(second);
    await Promise.resolve();
    expect(second.detach).toHaveBeenCalledTimes(1);
    expect(third.subscribe).not.toHaveBeenCalled();

    first.emitFromStaleTransport();
    second.emitFromStaleTransport();
    expect(presented).toEqual([]);

    releaseSecond.resolve();
    await expect(switchToThird).resolves.toBe(third);
    third.emit();
    first.emitFromStaleTransport();
    second.emitFromStaleTransport();

    expect(binding.currentSession).toBe(third);
    expect(presented).toEqual(["third"]);
  });

  it("fails closed when detach rejects and never issues an attach confirmation", async () => {
    const outgoing = session("outgoing", async () => {
      throw new Error("detach failed");
    });
    const incoming = session("incoming");
    const binding = new AgentConversationSessionBinding(
      outgoing,
      jest.fn(),
    );

    await expect(binding.replace(() => incoming)).rejects.toThrow("detach failed");
    expect(incoming.subscribe).not.toHaveBeenCalled();
    expect(() => binding.attach(
      incoming,
      undefined as unknown as AgentConversationDetachConfirmation,
    )).toThrow("exact outgoing session");
  });
});
