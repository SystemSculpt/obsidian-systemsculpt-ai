import {
  AgentConversationSessionBinding,
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
  it("can replace after an explicit detach without detaching the old session twice", async () => {
    const outgoing = session("outgoing");
    const incoming = session("incoming");
    const presented: string[] = [];
    const binding = new AgentConversationSessionBinding(
      outgoing,
      (_session, snapshot) => presented.push(snapshot.source),
    );

    await binding.detach();
    outgoing.emitFromStaleTransport();
    await expect(binding.replace(() => incoming)).resolves.toBe(incoming);
    incoming.emit();

    expect(outgoing.detach).toHaveBeenCalledTimes(1);
    expect(presented).toEqual(["incoming"]);
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

    expect(presented).toEqual(["third"]);
  });

  it("fails closed for every later replacement and detach when the outgoing detach fails", async () => {
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
    const createAnother = jest.fn(() => session("another"));
    await expect(binding.replace(createAnother)).rejects.toThrow("detach failed");
    await expect(binding.detach()).rejects.toThrow("detach failed");
    expect(createAnother).not.toHaveBeenCalled();
    expect(outgoing.detach).toHaveBeenCalledTimes(1);
  });

  it("serializes close behind an in-flight replacement and closes the incoming session", async () => {
    const releaseDetach = deferred();
    const outgoing = session("outgoing", () => releaseDetach.promise);
    const incoming = session("incoming");
    const presented = jest.fn();
    const binding = new AgentConversationSessionBinding(outgoing, presented);

    const replacing = binding.replace(() => incoming);
    const closing = binding.detach();
    await Promise.resolve();
    expect(incoming.detach).not.toHaveBeenCalled();

    releaseDetach.resolve();
    await replacing;
    await closing;
    incoming.emitFromStaleTransport();
    outgoing.emitFromStaleTransport();

    expect(incoming.detach).toHaveBeenCalledTimes(1);
    expect(presented).not.toHaveBeenCalled();
  });

  it("keeps stale callbacks fenced when subscription cleanup throws", async () => {
    const outgoing = session("outgoing");
    const subscribe = outgoing.subscribe.getMockImplementation()!;
    outgoing.subscribe.mockImplementation((listener) => {
      subscribe(listener);
      return () => { throw new Error("cleanup failed"); };
    });
    const incoming = session("incoming");
    const presented: string[] = [];
    const binding = new AgentConversationSessionBinding(
      outgoing,
      (_session, snapshot) => presented.push(snapshot.source),
    );

    binding.unsubscribe();
    outgoing.emit();
    await binding.replace(() => incoming);
    outgoing.emitFromStaleTransport();
    incoming.emit();

    expect(presented).toEqual(["incoming"]);
  });

  it("allows another replacement after the incoming subscription rejects", async () => {
    const outgoing = session("outgoing");
    const broken = session("broken");
    broken.subscribe.mockImplementation(() => { throw new Error("subscribe failed"); });
    const incoming = session("incoming");
    const presented: string[] = [];
    const binding = new AgentConversationSessionBinding(
      outgoing,
      (_session, snapshot) => presented.push(snapshot.source),
    );

    await expect(binding.replace(() => broken)).rejects.toThrow("subscribe failed");
    await binding.replace(() => incoming);
    incoming.emit();

    expect(outgoing.detach).toHaveBeenCalledTimes(1);
    expect(presented).toEqual(["incoming"]);
  });

});
