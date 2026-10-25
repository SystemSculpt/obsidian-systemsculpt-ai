/** @jest-environment jsdom */
import { App, Component, ItemView, MarkdownRenderer, Scope, WorkspaceLeaf } from "obsidian";
import { createEmptyStudioProject } from "../../../studio/schema";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import { StudioRunObserver } from "../../../studio/StudioRunObserver";
import { textNode } from "../../../studio/nodes/textNode";
import { runCollectionNode } from "../../../studio/nodes/runCollectionNode";
import { commandCenterNode } from "../../../studio/nodes/commandCenterNode";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { readCodexCatalog } from "../../../services/codex/CodexModelCatalog";

jest.mock("../../../services/codex/CodexModelCatalog", () => ({ ...jest.requireActual("../../../services/codex/CodexModelCatalog"), readCodexCatalog: jest.fn() }));

const PATH = "Studio/Recovery.systemsculpt";
const AT = "2026-10-24T12:00:00.000Z";
const definitions = [textNode, runCollectionNode, commandCenterNode];
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

async function fixture(load: () => Promise<void> = async () => {}) {
  const app = new App(); app.scope = new Scope();
  Object.assign(app.vault.adapter, { getBasePath: () => "/tmp/recovery-vault" });
  const events = new Map<string, Set<() => void>>();
  Object.assign(app.workspace, {
    requestSaveLayout: jest.fn(),
    on: (name: string, callback: () => void) => {
      const callbacks = events.get(name) ?? new Set();
      callbacks.add(callback); events.set(name, callbacks); return { name, callback };
    },
    offref: ({ name, callback }: { name: string; callback: () => void }) => events.get(name)?.delete(callback),
  });
  const emit = () => { for (const callback of events.get("layout-change") ?? []) callback(); };
  let disk = createEmptyStudioProject({ name: "Recovery", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  disk.graph.layout = { mode: "manual" };
  disk.graph.nodes = definitions.map((definition, index) => ({
    id: definition.kind.slice(7), kind: definition.kind, version: definition.version,
    title: definition.kind, position: { x: index * 350, y: 0 }, config: { ...definition.configDefaults },
  }));
  disk.graph.nodes.find(node => node.id === "text")!.config.value = "# Text preview";
  const session = new StudioProjectSession({ projectPath: PATH, project: disk, saveProject: async (_path, desired) => {
    disk = JSON.parse(JSON.stringify(desired)); return { project: disk, conflicts: [] };
  } });
  const observer = new StudioRunObserver(jest.fn());
  const listeners = new Set<(projectId: string) => void>();
  const records: any[] = [];
  const runs = {
    app, list: jest.fn((_projectId: string, sources?: string[]) => records.filter(run => !sources?.length || sources.includes(run.nodeId))),
    get: (id: string) => records.find(run => run.id === id),
    subscribe: (listener: (projectId: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    load: jest.fn(load), hasOlder: () => false, isCapped: () => false, canControl: () => true, hasRequest: () => false, isStale: () => false, canMarkStopped: () => false,
  };
  const service = {
    subscribeRunEvents: (listener: Parameters<StudioRunObserver["subscribe"]>[0]) => observer.subscribe(listener), getActiveRun: (path: string) => observer.getActiveRun(path),
    getLatestRunEvents: async () => [], agentRuns: runs, listNodeDefinitions: () => definitions,
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  const view = new SystemSculptStudioView(new WorkspaceLeaf(app), { getStudioService: () => service, settings: {} } as any);
  for (const element of [view.containerEl, view.contentEl]) Object.assign(element, { onWindowMigrated: () => () => {} });
  Object.assign(view.containerEl, { isShown: () => !view.containerEl.hidden });
  document.body.appendChild(view.containerEl);
  await view.onOpen(); await view.setState({ file: PATH }, {} as any); await flush();
  return {
    view, records, runs, session,
    hide: () => { view.containerEl.hidden = true; emit(); },
    show: () => { view.containerEl.hidden = false; emit(); },
    nativeChange: () => { for (const listener of listeners) listener(disk.projectId); },
    close: async () => { await view.onClose(); view.containerEl.remove(); await session.close(); },
  };
}

describe("Studio visibility recovery", () => {
  const host = ItemView.prototype as unknown as { setState?: () => Promise<void> }, originalSetState = host.setState;
  beforeEach(() => {
    host.setState = async () => {};
    jest.useFakeTimers(); jest.setSystemTime(new Date(AT));
    jest.mocked(readCodexCatalog).mockReset();
    jest.mocked(readCodexCatalog).mockResolvedValue({ models: [], permissions: "" } as any);
  });
  afterEach(() => { host.setState = originalSetState; jest.useRealTimers(); jest.restoreAllMocks(); });

  it("presents recovered run history after hidden successful reload", async () => {
    const notice = jest.spyOn(console, "log").mockImplementation(() => {});
    let rejectLoad!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    const f = await fixture(() => pending);
    try {
      f.hide();
      rejectLoad(new Error("Temporary history failure"));
      await flush();
      expect(notice).toHaveBeenCalledWith("Notice: Temporary history failure");
      // Another visible board recovers shared history while this board sleeps.
      f.runs.load.mockResolvedValue(undefined);
      f.records.push({ id: "recovered", projectId: "p", nodeId: "worker", title: "Recovered history", status: "completed", currentActivity: "Recovered result", messages: [], createdAt: AT, updatedAt: AT });
      await f.runs.load(); f.nativeChange();
      f.show();
      const board = f.view.contentEl.querySelector('[data-testid="studio.run.board"]')!;
      expect(board.textContent).toContain("Recovered history");
      expect(board.textContent).not.toContain("Temporary history failure");
    } finally { await f.close(); }
  });

  it.each(["success", "failure"])("defers pending Markdown %s until shown", async outcome => {
    let finish!: () => void;
    jest.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, target) => new Promise((resolve, reject) => {
      finish = () => {
        if (outcome === "failure") reject(new Error("Delayed Markdown failure"));
        else { target.setText(markdown); resolve(); }
      };
    }));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const f = await fixture();
    try {
      expect(MarkdownRenderer.render).toHaveBeenCalled();
      f.hide();
      const preview = f.view.contentEl.querySelector(".ss-studio-text-node-display")!;
      const before = preview.innerHTML;
      finish(); await flush();
      expect(preview.innerHTML).toBe(before);
      f.show(); await flush();
      expect(preview.textContent).toContain("Text preview");
    } finally { await f.close(); }
  });

  it("discards hidden Markdown delivery when the view closes", async () => {
    let finish!: () => void;
    jest.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, target) => new Promise(resolve => {
      finish = () => { target.setText(markdown); resolve(); };
    }));
    const f = await fixture();
    f.hide();
    const preview = f.view.contentEl.querySelector(".ss-studio-text-node-display")!;
    const before = preview.innerHTML;
    finish(); await flush();
    await f.close(); await flush();
    f.show();
    expect(preview.innerHTML).toBe(before);
    expect(f.view.contentEl.childElementCount).toBe(0);
  });

  it("unloads Markdown children as cards are replaced and removed, not just when the view closes", async () => {
    const cleanups: jest.Mock[] = [];
    const owners: Component[] = [];
    jest.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, target, _path, owner) => {
      const cleanup = jest.fn();
      const child = new Component(); child.load(); child.register(cleanup);
      owner.addChild(child); owners.push(owner); cleanups.push(cleanup);
      target.setText(markdown);
    });
    const f = await fixture();
    try {
      expect(owners[0]).not.toBe(f.view);
      for (let index = 1; index <= 4; index++) {
        f.session.mutate("node.config", project => { project.graph.nodes.find(node => node.id === "text")!.config.value = `# Revision ${index}`; });
        jest.advanceTimersByTime(50); await flush();
        expect(cleanups).toHaveLength(index + 1);
        expect(cleanups.filter(cleanup => cleanup.mock.calls.length === 0)).toHaveLength(1);
      }
      f.session.mutate("graph.node.remove", project => { project.graph.nodes = project.graph.nodes.filter(node => node.id !== "text"); });
      jest.advanceTimersByTime(50); await flush();
      for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("releases children of a failed Markdown render while preserving the plain-text fallback", async () => {
    const cleanup = jest.fn();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, _target, _path, owner) => {
      const child = new Component(); child.load(); child.register(cleanup); owner.addChild(child);
      throw new Error("Markdown processor failed");
    });
    const f = await fixture();
    try {
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(f.view.contentEl.querySelector(".ss-studio-text-node-display")!.textContent).toBe("# Text preview");
    } finally { await f.close(); }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("releases pending Markdown children on close and drains children registered by a late completion", async () => {
    const earlyCleanup = jest.fn(), lateCleanup = jest.fn();
    let finish!: () => void;
    jest.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, target, _path, owner) => {
      const early = new Component(); early.load(); early.register(earlyCleanup); owner.addChild(early);
      return new Promise(resolve => {
        finish = () => {
          const late = new Component(); late.load(); late.register(lateCleanup); owner.addChild(late);
          target.setText(markdown); resolve();
        };
      });
    });
    const f = await fixture();
    const preview = f.view.contentEl.querySelector(".ss-studio-text-node-display")!;
    const before = preview.innerHTML;
    await f.close();
    expect(earlyCleanup).toHaveBeenCalledTimes(1);
    finish(); await flush();
    expect(lateCleanup).toHaveBeenCalledTimes(1);
    expect(preview.innerHTML).toBe(before);
  });

  it("defers pending command-center catalog DOM updates until shown", async () => {
    let resolveCatalog!: (catalog: any) => void;
    jest.mocked(readCodexCatalog).mockImplementation(() => new Promise(resolve => { resolveCatalog = resolve; }));
    const f = await fixture();
    try {
      const model = f.view.contentEl.querySelector('[data-testid="studio.command.model"]')!;
      model.dispatchEvent(new Event("focusin", { bubbles: true }));
      expect(readCodexCatalog).toHaveBeenCalledTimes(1);
      f.hide();
      const row = f.view.contentEl.querySelector(".ss-studio-command-execution")!;
      const before = row.innerHTML;
      resolveCatalog({ models: [{ model: "new-model", name: "Loaded model", efforts: ["high"], defaultEffort: "high" }], permissions: "" });
      await flush();
      expect(row.innerHTML).toBe(before);
      f.show(); expect(row.textContent).toContain("Loaded model");
    } finally { await f.close(); }
  });
});
