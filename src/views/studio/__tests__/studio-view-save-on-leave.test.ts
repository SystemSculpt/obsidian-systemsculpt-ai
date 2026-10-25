/** @jest-environment jsdom */
import { App, ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { createEmptyStudioProject } from "../../../studio/schema";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import { StudioRunObserver } from "../../../studio/StudioRunObserver";
import { textNode } from "../../../studio/nodes/textNode";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const PATH = "Studio/Typing.systemsculpt";

/** A Studio view over a session with the default autosave delays; `saved` lists each written text. */
async function fixture() {
  const app = new App();
  app.scope = new Scope();
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  Object.assign(app.workspace, {
    requestSaveLayout: jest.fn(),
    on: (name: string, callback: (...args: unknown[]) => void) => {
      const callbacks = events.get(name) ?? new Set();
      callbacks.add(callback); events.set(name, callbacks);
      return { name, callback };
    },
    offref: ({ name, callback }: { name: string; callback: () => void }) => events.get(name)?.delete(callback),
  });
  const emit = (name: string, ...args: unknown[]) => { for (const callback of events.get(name) ?? []) callback(...args); };
  const project = createEmptyStudioProject({ name: "Typing", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  project.graph.layout = { mode: "manual" };
  project.graph.nodes = [{ id: "draft", kind: textNode.kind, version: textNode.version, title: "Draft", position: { x: 0, y: 0 }, config: { ...textNode.configDefaults } }];
  const saved: string[] = [];
  const session = new StudioProjectSession({ projectPath: PATH, project, saveProject: async (_path, desired) => {
    saved.push(String(desired.graph.nodes[0].config.value));
    return { project: JSON.parse(JSON.stringify(desired)), conflicts: [] };
  } });
  const observer = new StudioRunObserver(jest.fn());
  const runs = {
    app, list: () => [], get: () => undefined, subscribe: () => () => undefined,
    load: async () => undefined, hasOlder: () => false, isCapped: () => false, canControl: () => true, hasRequest: () => false,
  };
  const service = {
    subscribeRunEvents: (listener: Parameters<StudioRunObserver["subscribe"]>[0]) => observer.subscribe(listener),
    getActiveRun: (path: string) => observer.getActiveRun(path), getLatestRunEvents: async () => [],
    agentRuns: runs, listNodeDefinitions: () => [textNode],
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  const leaf = new WorkspaceLeaf(app);
  const view = new SystemSculptStudioView(leaf, { getStudioService: () => service, settings: {} } as any);
  for (const element of [view.containerEl, view.contentEl]) Object.assign(element, { onWindowMigrated: () => () => undefined });
  Object.assign(view.containerEl, { isShown: () => !view.containerEl.hidden });
  document.body.appendChild(view.containerEl);
  await view.onOpen();
  await view.setState({ file: PATH }, {} as any);
  /** Keystrokes 200 ms apart, as the card's text editor reports them. */
  const type = async (text: string) => {
    for (let length = 1; length <= text.length; length++) {
      session.mutate("node.config", draft => { draft.graph.nodes[0].config.value = text.slice(0, length); }, { mode: "continuous" });
      await jest.advanceTimersByTimeAsync(200);
    }
  };
  /** Lets an immediate save finish without reaching the 1.5 s pause. */
  const settle = async () => { await jest.advanceTimersByTimeAsync(0); await session.waitForInFlightSave(); };
  return { view, leaf, app, session, saved, emit, type, settle };
}

describe("Studio saves typing when the user leaves it", () => {
  const host = ItemView.prototype as unknown as { setState?: () => Promise<void> };
  const originalSetState = host.setState;
  beforeEach(() => { host.setState = async () => {}; jest.useFakeTimers(); });
  afterEach(async () => { host.setState = originalSetState; jest.useRealTimers(); document.body.empty(); });

  it("waits for a 1.5 s pause while typing continues", async () => {
    const f = await fixture();
    await f.type("Weekly");
    expect(f.saved).toEqual([]);
    await jest.advanceTimersByTimeAsync(1300);
    await f.session.waitForInFlightSave();
    expect(f.saved).toEqual(["Weekly"]);
    await f.view.onClose();
  });

  it("saves at once when focus leaves a Studio field", async () => {
    const f = await fixture();
    const field = f.view.contentEl.createEl("textarea");
    await f.type("Notes");
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await f.settle();
    expect(f.saved).toEqual(["Notes"]);
    await f.view.onClose();
  });

  it("saves at once when the window loses focus", async () => {
    const f = await fixture();
    await f.type("Plan");
    window.dispatchEvent(new Event("blur"));
    await f.settle();
    expect(f.saved).toEqual(["Plan"]);
    await f.view.onClose();
  });

  it("saves at once when another leaf becomes active, and not when this one does", async () => {
    const f = await fixture();
    await f.type("Ideas");
    f.emit("active-leaf-change", f.leaf);
    await f.settle();
    expect(f.saved).toEqual([]);
    f.emit("active-leaf-change", new WorkspaceLeaf(f.app));
    await f.settle();
    expect(f.saved).toEqual(["Ideas"]);
    await f.view.onClose();
  });

  it("saves at once when its tab is hidden", async () => {
    const f = await fixture();
    await f.type("Draft");
    f.view.containerEl.hidden = true;
    f.emit("layout-change");
    await f.settle();
    expect(f.saved).toEqual(["Draft"]);
    await f.view.onClose();
  });

  it("saves the burst when the view closes and stops listening afterwards", async () => {
    const f = await fixture();
    await f.type("Close");
    await f.view.onClose();
    expect(f.saved).toEqual(["Close"]);
    const save = jest.spyOn(f.session, "flushPendingSaveWork");
    window.dispatchEvent(new Event("blur"));
    f.emit("active-leaf-change", new WorkspaceLeaf(f.app));
    expect(save).not.toHaveBeenCalled();
  });
});
