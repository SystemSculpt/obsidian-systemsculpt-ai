/** @jest-environment jsdom */
import { App, ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { createEmptyStudioProject } from "../../../studio/schema";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import { StudioRunObserver } from "../../../studio/StudioRunObserver";
import { inputNode } from "../../../studio/nodes/inputNode";
import { datasetNode } from "../../../studio/nodes/datasetNode";
import { codexNode } from "../../../studio/nodes/codexNode";
import { runCollectionNode } from "../../../studio/nodes/runCollectionNode";
import { commandCenterNode } from "../../../studio/nodes/commandCenterNode";
import { collectionNode } from "../../../studio/nodes/collectionNode";
import type { StudioAgentRun } from "../../../services/codex/StudioAgentRunStore";
import type { StudioRunEvent } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const PATH = "Studio/Visibility.systemsculpt";
const AT = "2026-10-24T12:00:00.000Z";
const definitions = [inputNode, datasetNode, codexNode, runCollectionNode, commandCenterNode, collectionNode];

async function fixture(initiallyHidden = false, pendingLoad?: Promise<void>) {
  const app = new App();
  app.scope = new Scope();
  const events = new Map<string, Set<() => void>>();
  Object.assign(app.workspace, {
    requestSaveLayout: jest.fn(),
    on: (name: string, callback: () => void) => {
      const callbacks = events.get(name) ?? new Set();
      callbacks.add(callback); events.set(name, callbacks);
      return { name, callback };
    },
    offref: ({ name, callback }: { name: string; callback: () => void }) => events.get(name)?.delete(callback),
  });
  const emit = (name: string, ...args: unknown[]) => {
    for (const callback of events.get(name) ?? []) (callback as (...values: unknown[]) => void)(...args);
  };
  let disk = createEmptyStudioProject({ name: "Visibility", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  disk.graph.layout = { mode: "manual" };
  disk.graph.nodes = definitions.map((definition, index) => ({
    id: definition.kind.slice(7), kind: definition.kind, version: definition.version,
    title: definition.kind, position: { x: index * 350, y: 0 },
    config: { ...definition.configDefaults },
  }));
  disk.graph.nodes.find(node => node.id === "command_center")!.config.actions = [{ id: "work", label: "Worker", kind: "run", target: "codex" }];
  disk.graph.nodes.find(node => node.id === "collection")!.config.value = {
    items: [{ id: "one", title: "Retained row" }],
    source: { schema: "studio.source.v1", mode: "automatic", observedAt: AT, checkedAt: AT, maxAgeSeconds: 30 },
  };
  const projectId = disk.projectId;
  const session = new StudioProjectSession({ projectPath: PATH, project: disk, saveProject: async (_path, desired) => {
    disk = JSON.parse(JSON.stringify(desired));
    return { project: disk, conflicts: [] };
  } });
  const observer = new StudioRunObserver(jest.fn());
  const listeners = new Set<(projectId: string) => void>();
  const records = [
    { id: "worker", nodeId: "codex", title: "Worker", status: "running", currentActivity: "Starting", messages: [], createdAt: AT, updatedAt: AT },
    { id: "orchestrator", nodeId: "command_center", title: "Plan", status: "running", currentActivity: "Planning", messages: [], createdAt: AT, updatedAt: AT,
      workflow: { objective: "Keep the objective", status: "active", boundaries: "Review only", steps: [] } },
  ] as unknown as StudioAgentRun[];
  const runs = {
    app, list: jest.fn((_projectId: string, sources?: string[]) => records.filter(run => !sources?.length || sources.includes(run.nodeId))),
    get: (id: string) => records.find(run => run.id === id),
    subscribe: (listener: (projectId: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    load: jest.fn(async () => { await pendingLoad; }), hasOlder: () => false, isCapped: () => false,
    canControl: () => true, hasRequest: () => false, isStale: () => false, canMarkStopped: () => false,
  };
  const service = {
    subscribeRunEvents: (listener: Parameters<StudioRunObserver["subscribe"]>[0]) => observer.subscribe(listener),
    getActiveRun: (path: string) => observer.getActiveRun(path), getLatestRunEvents: async () => [],
    agentRuns: runs, listNodeDefinitions: () => definitions,
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  const plugin = { getStudioService: () => service, settings: {} };
  const views: SystemSculptStudioView[] = [];
  const migrations = new Map<HTMLElement, Set<(owner: Window) => void>>();
  const open = async (hidden = false) => {
    const view = new SystemSculptStudioView(new WorkspaceLeaf(app), plugin as any);
    for (const element of [view.containerEl, view.contentEl]) {
      const callbacks = new Set<(owner: Window) => void>();
      migrations.set(element, callbacks);
      Object.assign(element, { onWindowMigrated: (callback: (owner: Window) => void) => {
        callbacks.add(callback); return () => callbacks.delete(callback);
      } });
    }
    Object.assign(view.containerEl, { isShown: () => !view.containerEl.hidden });
    view.containerEl.hidden = hidden;
    document.body.appendChild(view.containerEl);
    views.push(view);
    await view.onOpen();
    await view.setState({ file: PATH }, {} as any);
    return view;
  };
  const view = await open(initiallyHidden);
  return {
    view, open, runs, records, listeners, session, disk: () => disk, emit,
    migrate: (ownerDocument: Document) => {
      ownerDocument.body.appendChild(ownerDocument.adoptNode(view.containerEl));
      for (const element of [view.containerEl, view.contentEl]) {
        for (const callback of migrations.get(element) ?? []) callback(ownerDocument.defaultView!);
      }
    },
    hide: (target = view) => { target.containerEl.hidden = true; emit("layout-change"); },
    show: (target = view) => { target.containerEl.hidden = false; emit("active-leaf-change"); },
    publish: (event: StudioRunEvent) => observer.publish(PATH, event),
    begin: () => { observer.begin({ projectPath: PATH, runId: "r", nodeIds: ["dataset"], fromNodeId: "dataset" }); observer.publish(PATH, { type: "run.started", runId: "r", at: AT }); },
    nativeChange: () => { for (const listener of listeners) listener(projectId); },
    close: async () => { for (const opened of views) { await opened.onClose(); opened.containerEl.remove(); } await session.close(); },
  };
}

describe("Studio leaf visibility", () => {
  const host = ItemView.prototype as unknown as { setState?: () => Promise<void> };
  const originalSetState = host.setState;
  beforeEach(() => {
    host.setState = async () => {};
    jest.useFakeTimers(); jest.setSystemTime(new Date(AT));
  });
  afterEach(() => { host.setState = originalSetState; jest.useRealTimers(); jest.restoreAllMocks(); });

  it("suspends hidden activity and every native card subscription, then presents the latest state once", async () => {
    const f = await fixture();
    try {
      f.begin();
      f.publish({ type: "node.started", runId: "r", nodeId: "dataset", at: AT });
      jest.advanceTimersByTime(100);
      const root = f.view.contentEl;
      const board = root.querySelector<HTMLElement>('[data-node-id="run_collection"] .ss-studio-run-lanes')!;
      const rebuild = jest.spyOn(board, "empty");
      const search = root.querySelector<HTMLInputElement>('[data-node-id="run_collection"] [data-testid="studio.run.search"]')!;
      search.value = "Worker"; search.dispatchEvent(new Event("input")); rebuild.mockClear();
      f.hide();
      const before = root.innerHTML;
      f.runs.list.mockClear();
      for (let percent = 1; percent <= 20; percent++) {
        f.publish({ type: "node.progress", runId: "r", nodeId: "dataset", percent, message: `Progress ${percent}`, at: AT });
        f.records[0].currentActivity = `Native ${percent}`;
        f.nativeChange();
      }
      f.records[0].status = "completed";
      f.records[1].workflow!.status = "completed";
      f.nativeChange();
      expect(f.listeners.size).toBe(0);
      expect(f.runs.list).not.toHaveBeenCalled();
      expect(root.innerHTML).toBe(before);
      expect(rebuild).not.toHaveBeenCalled();
      f.show();
      expect(root.textContent).toContain("Native 20");
      expect(root.textContent).toContain("Progress 20");
      expect(root.querySelector('[data-workflow-id="orchestrator"]')?.getAttribute("data-status")).toBe("completed");
      expect(search.value).toBe("Worker");
      expect(rebuild).toHaveBeenCalledTimes(1);
      const shown = root.innerHTML;
      f.emit("layout-change"); f.emit("active-leaf-change");
      expect(root.innerHTML).toBe(shown);
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("ingests and persists completed outputs while hidden, without refreshing the workspace", async () => {
    const f = await fixture();
    try {
      f.begin(); f.hide();
      const before = f.view.contentEl.innerHTML;
      f.publish({ type: "node.output", runId: "r", nodeId: "dataset", outputRef: "out", outputs: { rows: [{ id: "one" }], total: 1 }, at: AT });
      f.publish({ type: "run.completed", runId: "r", status: "success", at: AT });
      await f.session.flushPendingSaveWork();
      expect(f.disk().graph.nodes.find(node => node.id === "dataset")?.config.outputFields).toEqual(["rows", "total"]);
      expect(f.view.contentEl.innerHTML).toBe(before);
      f.show();
      expect(f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Run Studio graph"]')?.disabled).toBe(false);
      expect(f.view.contentEl.querySelector('[data-node-id="dataset"]')?.getAttribute("data-activity")).toBe("done");
    } finally { await f.close(); }
  });

  it("cancels hidden freshness timers and resumes with current age, not queued ticks", async () => {
    const f = await fixture();
    try {
      // Let the independent layout-persistence debounce finish first.
      jest.advanceTimersByTime(500);
      const source = f.view.contentEl.querySelector<HTMLElement>("[data-source-status]")!;
      const paint = jest.spyOn(source, "setText");
      f.hide();
      const timers = jest.getTimerCount();
      jest.advanceTimersByTime(60000);
      expect(paint).not.toHaveBeenCalled();
      expect(source.dataset.sourceStatus).toBe("current");
      expect(timers).toBe(0);
      f.show();
      expect(source.dataset.sourceStatus).toBe("stale");
      expect(paint).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(30000);
      expect(paint).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
    expect(jest.getTimerCount()).toBe(0);
  });

  it("defers late history loads while the owner document is hidden and ignores them after close", async () => {
    let resolveLoad!: () => void;
    const f = await fixture(false, new Promise(resolve => { resolveLoad = resolve; }));
    const visibility = jest.spyOn(document, "visibilityState", "get");
    try {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      const before = f.view.contentEl.innerHTML;
      f.records[0].currentActivity = "Loaded while hidden";
      f.runs.list.mockClear();
      resolveLoad();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(f.runs.list).not.toHaveBeenCalled();
      expect(f.view.contentEl.innerHTML).toBe(before);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(f.view.contentEl.textContent).toContain("Loaded while hidden");
      f.hide();
      await f.view.onClose();
      f.show(); f.nativeChange();
      expect(f.listeners.size).toBe(0);
      expect(f.view.contentEl.childElementCount).toBe(0);
    } finally { visibility.mockRestore(); await f.close(); }
  });

  it("ignores pending native-history completion after a hidden view closes", async () => {
    let resolveLoad!: () => void;
    const f = await fixture(false, new Promise(resolve => { resolveLoad = resolve; }));
    try {
      jest.advanceTimersByTime(500);
      f.hide();
      await f.view.onClose();
      f.runs.list.mockClear();
      resolveLoad();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(f.runs.list).not.toHaveBeenCalled();
      expect(f.listeners.size).toBe(0);
      expect(f.view.contentEl.childElementCount).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally { await f.close(); }
  });

  it("moves visible presentation clocks to the new owner window and cancels them on hide", async () => {
    const f = await fixture();
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const owner = iframe.contentWindow as Window & typeof globalThis;
    // Obsidian installs these DOM helpers in every popout realm.
    for (const [source, target] of [[Element.prototype, owner.Element.prototype], [HTMLElement.prototype, owner.HTMLElement.prototype]]) {
      for (const key of Object.getOwnPropertyNames(source)) {
        if (!(key in target)) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)!);
      }
    }
    const start = jest.spyOn(owner, "setInterval");
    const stop = jest.spyOn(owner, "clearInterval");
    try {
      f.migrate(iframe.contentDocument!);
      expect(start).toHaveBeenCalledWith(expect.any(Function), 30000);
      f.hide();
      expect(stop).toHaveBeenCalledWith(start.mock.results[0].value);
      const calls = start.mock.calls.length;
      f.records[0].currentActivity = "In the popout"; f.nativeChange();
      f.show();
      expect(start).toHaveBeenCalledTimes(calls + 1);
      expect(f.view.contentEl.textContent).toContain("In the popout");
    } finally { await f.close(); iframe.remove(); }
  });

  it("does not mount an initially hidden project and keeps visible unfocused split panes live", async () => {
    const f = await fixture(true);
    try {
      expect(f.view.contentEl.querySelector(".ss-studio-view")).toBeNull();
      expect(f.listeners.size).toBe(0);
      const split = await f.open();
      window.dispatchEvent(new Event("blur"));
      f.records[0].currentActivity = "Visible split keeps working";
      f.nativeChange();
      expect(split.contentEl.textContent).toContain("Visible split keeps working");
      expect(f.view.contentEl.querySelector(".ss-studio-view")).toBeNull();
      f.show();
      expect(f.view.contentEl.textContent).toContain("Visible split keeps working");
      f.hide(split);
      const before = split.contentEl.innerHTML;
      f.records[0].currentActivity = "Other split is still live";
      f.nativeChange();
      expect(f.view.contentEl.textContent).toContain("Other split is still live");
      expect(split.contentEl.innerHTML).toBe(before);
    } finally { await f.close(); }
  });

  it("ends a click-armed connection once another leaf becomes active", async () => {
    const f = await fixture();
    try {
      const root = f.view.contentEl;
      const output = root.querySelector<HTMLElement>('.ss-studio-port-pin[data-port-direction="out"]:not(:disabled)')!;
      const armed = () => output.getAttribute("aria-pressed") === "true";
      output.click();
      expect(armed()).toBe(true);
      expect(root.querySelector(".ss-studio-port-pin.is-drop-target")).not.toBeNull();

      // Its own leaf becoming active (the press that armed it) keeps it.
      f.emit("active-leaf-change", f.view.leaf);
      expect(armed()).toBe(true);

      f.emit("active-leaf-change", new WorkspaceLeaf(f.view.app));
      expect(armed()).toBe(false);
      expect(root.querySelector(".ss-studio-port-pin.is-drop-target")).toBeNull();
      expect(root.querySelector(".ss-studio-edge-preview")).toBeNull();
    } finally { await f.close(); }
  });
});
