/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";
import { LocalAgentChatSession } from "../../../services/codex/LocalAgentChatSession";
import { readCodexCatalog, type CodexModel } from "../../../services/codex/CodexModelCatalog";
import { hasHostCapability } from "../../../platform/hostCapabilities";
import { waitForIdle } from "../../../utils/yieldToEventLoop";

jest.mock("../../../services/codex/CodexModelCatalog", () => ({
  ...jest.requireActual("../../../services/codex/CodexModelCatalog"),
  readCodexCatalog: jest.fn(),
}));
jest.mock("../../../services/codex/CodexExecutionSettings", () => ({
  ...jest.requireActual("../../../services/codex/CodexExecutionSettings"),
  codexVaultDirectory: jest.fn(() => "/vault"),
}));
jest.mock("../../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../../platform/hostCapabilities"),
  hasHostCapability: jest.fn(),
}));
jest.mock("../../../utils/yieldToEventLoop", () => ({
  ...jest.requireActual("../../../utils/yieldToEventLoop"),
  waitForIdle: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const register = jest.fn();
  const pruneAttachmentStore = jest.fn(async () => undefined);
  const syncChrome = jest.fn();
  const view = Object.create(AgentChatView.prototype) as AgentChatView;
  const agent = Object.assign(Object.create(LocalAgentChatSession.prototype), {
    agent: "codex",
    getSnapshot: jest.fn(() => ({ status: "idle" })),
  });
  Object.assign(view, {
    app: {},
    containerEl: document.createElement("div"),
    agent,
    agentSessionBinding: { unsubscribe: jest.fn(), detach: jest.fn(async () => undefined) },
    transcript: { idle: jest.fn(async () => undefined) },
    contextManager: { dispose: jest.fn() },
    workspace: { setRunPending: jest.fn() },
    chatId: "",
    closing: false,
    closed: false,
    codexCatalog: null,
    codexModels: null,
    clientMonotonicNow: () => 0,
    register,
    pruneAttachmentStore,
    syncChrome,
  });
  return { view, register, pruneAttachmentStore, syncChrome };
}

const models: CodexModel[] = [{ model: "native-model", name: "Native model", efforts: ["high"], defaultEffort: "high" }];
const flushTasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(hasHostCapability).mockReturnValue(true);
});

describe("AgentChatView per-call task lifetime", () => {
  it.each(["success", "idle-failure", "prune-failure"] as const)("releases attachment maintenance after %s without registering teardown closures", async outcome => {
    const h = harness();
    const idle = deferred<boolean>();
    jest.mocked(waitForIdle).mockReturnValueOnce(idle.promise);
    if (outcome === "prune-failure") h.pruneAttachmentStore.mockRejectedValueOnce(new Error("Prune failed"));

    h.view["scheduleAttachmentPrune"]();
    expect(h.view["viewTasks"]?.size).toBe(1);
    if (outcome === "idle-failure") idle.reject(new Error("Idle scheduling failed"));
    else idle.resolve(true);
    await flushTasks();

    expect(h.view["viewTasks"]?.size).toBe(0);
    expect(h.pruneAttachmentStore).toHaveBeenCalledTimes(outcome === "idle-failure" ? 0 : 1);
    expect(h.register).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)("releases catalog work after %s without registering teardown closures", async outcome => {
    const h = harness();
    const catalog = deferred<Awaited<ReturnType<typeof readCodexCatalog>>>();
    jest.mocked(readCodexCatalog).mockReturnValueOnce(catalog.promise);

    h.view["loadCodexCatalog"]();
    expect(h.view["viewTasks"]?.size).toBe(1);
    const settled = h.view["codexCatalog"];
    if (outcome === "failure") catalog.reject(new Error("Catalog failed"));
    else catalog.resolve({ models, permissions: "" });
    await settled;

    expect(h.view["viewTasks"]?.size).toBe(0);
    expect(h.view["codexModels"]).toEqual(outcome === "failure" ? [] : models);
    expect(h.syncChrome).toHaveBeenCalledTimes(1);
    expect(h.register).not.toHaveBeenCalled();
    if (outcome === "failure") expect(h.view["codexCatalog"]).toBeNull();
  });

  it.each(["success", "failure"] as const)("aborts outstanding work on close and ignores a late catalog %s", async outcome => {
    const h = harness();
    const idle = deferred<boolean>();
    const catalog = deferred<Awaited<ReturnType<typeof readCodexCatalog>>>();
    jest.mocked(waitForIdle).mockReturnValueOnce(idle.promise);
    jest.mocked(readCodexCatalog).mockReturnValueOnce(catalog.promise);
    const previousModels: CodexModel[] = [];
    h.view["codexModels"] = previousModels;

    h.view["scheduleAttachmentPrune"]();
    h.view["loadCodexCatalog"]();
    const settledCatalog = h.view["codexCatalog"];
    const idleSignal = jest.mocked(waitForIdle).mock.calls[0][1]!;
    const catalogSignal = jest.mocked(readCodexCatalog).mock.calls[0][1];
    expect(h.view["viewTasks"]?.size).toBe(2);
    expect(idleSignal.aborted).toBe(false);
    expect(catalogSignal.aborted).toBe(false);

    await h.view.onClose();

    expect(idleSignal.aborted).toBe(true);
    expect(catalogSignal.aborted).toBe(true);
    expect(h.view["viewTasks"]?.size).toBe(0);
    expect(h.view["closed"]).toBe(true);
    idle.resolve(true);
    if (outcome === "failure") catalog.reject(new Error("Late catalog failure"));
    else catalog.resolve({ models, permissions: "" });
    await settledCatalog;
    await flushTasks();

    expect(h.view["codexModels"]).toBe(previousModels);
    expect(h.pruneAttachmentStore).not.toHaveBeenCalled();
    expect(h.syncChrome).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.view["viewTasks"]?.size).toBe(0);
    h.view["scheduleAttachmentPrune"]();
    h.view["loadCodexCatalog"]();
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(readCodexCatalog).toHaveBeenCalledTimes(1);
  });
});
