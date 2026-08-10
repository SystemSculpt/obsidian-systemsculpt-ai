/**
 * @jest-environment jsdom
 */

import type { App, PluginManifest } from "obsidian";

import { runDriverAction, type ActionContext } from "../actions";
import { TestDriverClient } from "../TestDriverClient";
import type { TestDriverHandshake } from "../protocol";

jest.mock("../actions", () => ({
  runDriverAction: jest.fn(),
}));
jest.mock("virtual:systemsculpt-test-driver-artifact", () => ({
  TEST_DRIVER_ARTIFACT_ID:
    "SystemSculptPluginArtifact/v1:00000000000000000000000000000001",
}), { virtual: true });

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type Listener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  public static readonly OPEN = 1;
  public static instances: FakeWebSocket[] = [];

  public readonly send = jest.fn<void, [string]>();
  public readonly close = jest.fn<void, [number?, string?]>();
  public readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type ClientInternals = {
  poll(): Promise<void>;
  connect(handshake: TestDriverHandshake): void;
  actionChain: Promise<void>;
  socket: WebSocket | null;
};

function handshake(serverId: string): TestDriverHandshake {
  return {
    version: 1,
    serverId,
    port: 4321,
    token: `token-${serverId}`,
    createdAt: new Date().toISOString(),
  };
}

function makeClient(
  read: jest.Mock<Promise<string>, [string]>,
  readSupportDiagnostics?: ActionContext["readSupportDiagnostics"],
): TestDriverClient {
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: { read },
      getName: () => "main-vault",
    },
  } as unknown as App;
  const manifest = {
    id: "systemsculpt-ai",
    name: "SystemSculpt AI",
    version: "0.0.0-test",
    minAppVersion: "1.0.0",
    description: "test",
    author: "SystemSculpt",
  } as PluginManifest;
  return new TestDriverClient(
    app,
    manifest,
    "test-build",
    "http://127.0.0.1:8787/api/plugin",
    undefined,
    readSupportDiagnostics,
  );
}

const mockedRunDriverAction = runDriverAction as jest.MockedFunction<typeof runDriverAction>;
const originalWebSocket = globalThis.WebSocket;

describe("TestDriverClient socket ownership", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mockedRunDriverAction.mockReset();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it("identifies the exact loaded build and compiled API target in its hello", () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;

    internals.connect(handshake("server-a"));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "hello",
      token: "token-server-a",
      serverId: "server-a",
      marker: "SystemSculptTestDriver/v1",
      artifactId: "SystemSculptPluginArtifact/v1:00000000000000000000000000000001",
      vault: "main-vault",
      pluginVersion: "0.0.0-test",
      buildStamp: "test-build",
      apiBaseUrl: "http://127.0.0.1:8787/api/plugin",
    }));
  });

  it("passes content-free support diagnostics into driver actions", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const readSupportDiagnostics = jest.fn(() => []);
    const client = makeClient(read, readSupportDiagnostics);
    const internals = client as unknown as ClientInternals;
    mockedRunDriverAction.mockResolvedValue({ handled: true });

    internals.connect(handshake("server-a"));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("message", {
      data: JSON.stringify({ type: "action", id: 1, action: "status", params: {} }),
    });
    await internals.actionChain;

    expect((mockedRunDriverAction.mock.calls[0]?.[0] as ActionContext).readSupportDiagnostics)
      .toBe(readSupportDiagnostics);
  });

  it("coalesces overlapping handshake polls into one connection attempt", async () => {
    const readGate = deferred<string>();
    const read = jest.fn<Promise<string>, [string]>(() => readGate.promise);
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;

    const first = internals.poll();
    const second = internals.poll();
    expect(read).toHaveBeenCalledTimes(1);

    readGate.resolve(JSON.stringify(handshake("server-a")));
    await Promise.all([first, second]);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://127.0.0.1:4321/");
  });

  it("runs replacement actions without waiting for an unresolved stale queue", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;
    const firstAction = deferred<unknown>();
    mockedRunDriverAction
      .mockImplementationOnce(() => firstAction.promise)
      .mockResolvedValue({ handled: true });

    internals.connect(handshake("server-a"));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 1, action: "waitFor", params: {} }),
    });
    await Promise.resolve();
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(1);

    firstSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 2, action: "snapshot", params: {} }),
    });
    const staleActionChain = internals.actionChain;
    firstSocket.emit("close", { code: 1000 });
    internals.connect(handshake("server-b"));
    const replacementSocket = FakeWebSocket.instances[1]!;

    firstSocket.emit("message", { data: JSON.stringify({ type: "cancel", id: 999 }) });
    expect(internals.socket).toBe(replacementSocket);
    expect(replacementSocket.close).not.toHaveBeenCalled();

    replacementSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 3, action: "replacement-action", params: {} }),
    });
    await internals.actionChain;

    expect(mockedRunDriverAction).toHaveBeenCalledTimes(2);
    expect(mockedRunDriverAction.mock.calls[1]?.[1]).toBe("replacement-action");
    expect(replacementSocket.send).toHaveBeenCalledWith(expect.stringContaining('"id":3'));

    firstAction.resolve({ handled: true });
    await staleActionChain;
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(2);
    expect(firstSocket.send).not.toHaveBeenCalled();
  });

  it("cancels a timed-out wait out of band so queued diagnostics can run", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;
    const hangingWait = deferred<unknown>();
    mockedRunDriverAction
      .mockImplementationOnce(() => hangingWait.promise)
      .mockResolvedValue({ diagnostics: true });

    internals.connect(handshake("server-a"));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("message", {
      data: JSON.stringify({ type: "action", id: 1, action: "waitFor", params: {} }),
    });
    await Promise.resolve();
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(1);

    socket.emit("message", { data: JSON.stringify({ type: "cancel", id: 1 }) });
    socket.emit("message", {
      data: JSON.stringify({ type: "action", id: 2, action: "logs", params: {} }),
    });
    await internals.actionChain;

    expect((mockedRunDriverAction.mock.calls[0]?.[0] as ActionContext).signal?.aborted)
      .toBe(true);
    expect(mockedRunDriverAction.mock.calls[1]?.[1]).toBe("logs");
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"id":2'));

    hangingWait.resolve({ late: true });
  });

  it("keeps a replacement behind an unresolved DOM mutator", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;
    const mutator = deferred<unknown>();
    mockedRunDriverAction
      .mockImplementationOnce(() => mutator.promise)
      .mockResolvedValue({ replacement: true });

    internals.connect(handshake("server-a"));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 1, action: "type", params: {} }),
    });
    await Promise.resolve();
    firstSocket.emit("close", { code: 1000 });

    internals.connect(handshake("server-b"));
    const replacementSocket = FakeWebSocket.instances[1]!;
    replacementSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 2, action: "status", params: {} }),
    });
    await Promise.resolve();
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(1);

    mutator.resolve({ mutated: true });
    await internals.actionChain;
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(2);
    expect(mockedRunDriverAction.mock.calls[1]?.[1]).toBe("status");
  });

  it("keeps replacement work behind a waitForRun that may approve the UI", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;
    const approvalCapableWait = deferred<unknown>();
    mockedRunDriverAction
      .mockImplementationOnce(() => approvalCapableWait.promise)
      .mockResolvedValue({ replacement: true });

    internals.connect(handshake("server-a"));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 1, action: "waitForRun", params: {} }),
    });
    await Promise.resolve();
    firstSocket.emit("close", { code: 1000 });

    internals.connect(handshake("server-b"));
    const replacementSocket = FakeWebSocket.instances[1]!;
    replacementSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 2, action: "status", params: {} }),
    });
    await Promise.resolve();
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(1);

    approvalCapableWait.resolve({ finished: true });
    await internals.actionChain;
    expect(mockedRunDriverAction).toHaveBeenCalledTimes(2);
    expect(mockedRunDriverAction.mock.calls[1]?.[1]).toBe("status");
  });

  it("can detach an explicitly observation-only waitForRun", async () => {
    const read = jest.fn<Promise<string>, [string]>();
    const client = makeClient(read);
    const internals = client as unknown as ClientInternals;
    const observationalWait = deferred<unknown>();
    mockedRunDriverAction
      .mockImplementationOnce(() => observationalWait.promise)
      .mockResolvedValue({ replacement: true });

    internals.connect(handshake("server-a"));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "action",
        id: 1,
        action: "waitForRun",
        params: { approve: false },
      }),
    });
    await Promise.resolve();
    firstSocket.emit("close", { code: 1000 });
    internals.connect(handshake("server-b"));
    const replacementSocket = FakeWebSocket.instances[1]!;
    replacementSocket.emit("message", {
      data: JSON.stringify({ type: "action", id: 2, action: "status", params: {} }),
    });
    await internals.actionChain;

    expect(mockedRunDriverAction).toHaveBeenCalledTimes(2);
    expect(mockedRunDriverAction.mock.calls[1]?.[1]).toBe("status");
    observationalWait.resolve({ finished: true });
  });
});
