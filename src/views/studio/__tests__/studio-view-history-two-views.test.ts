/** @jest-environment jsdom */
import { App, ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { createEmptyStudioProject } from "../../../studio/schema";
import { inputNode } from "../../../studio/nodes/inputNode";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import { reconcileStudioProject } from "../../../studio/StudioProjectReconciliation";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { installObsidianKeymap } from "./studio-obsidian-keymap-test-helpers";

it.each(["local edits", "untouched peer", "independent peer edit"])("preserves %s across two views and persisted undo/redo", async mode => {
  const app = new App();
  app.scope = new Scope();
  Object.assign(app.workspace, { requestSaveLayout: jest.fn() });
  // Missing host methods in the shared Obsidian mock, not Studio internals.
  const hostPrototype = ItemView.prototype as unknown as { setState?: () => Promise<void> };
  const originalSetState = hostPrototype.setState;
  hostPrototype.setState = async () => {};
  let disk = createEmptyStudioProject({ name: "Undo", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10 });
  disk.graph.layout = { mode: "manual" };
  disk.graph.nodes.push({ id: "input", kind: inputNode.kind, version: inputNode.version, title: "2", config: { value: "Value" }, position: { x: 10, y: 10 }, disabled: false, continueOnError: false });
  disk.graph.nodes.push({ ...disk.graph.nodes[0], id: "peer", title: "Before peer", position: { x: 500, y: 10 } });
  const session = new StudioProjectSession({ projectPath: "Studio/Test.systemsculpt", project: disk,
    saveProject: async (_path, desired, _before, base) => {
      const result = reconcileStudioProject(base!, desired, disk);
      disk = result.project;
      return result;
    },
  });
  const service = {
    subscribeRunEvents: () => () => {}, getActiveRun: () => null, getLatestRunEvents: async () => [],
    agentRuns: { subscribe: () => () => {}, list: () => [] }, listNodeDefinitions: () => [inputNode],
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  const plugin = { getStudioService: () => service, settings: {} };
  const views = [new SystemSculptStudioView(new WorkspaceLeaf(app), plugin as any), new SystemSculptStudioView(new WorkspaceLeaf(app), plugin as any)];
  let active = views[0];
  jest.spyOn(app.workspace, "getActiveViewOfType").mockImplementation(() => active as any);
  // Keys reach only the active view, through Obsidian's keymap and its view scope.
  const keymap = installObsidianKeymap(app, () => active);
  try {
    for (const view of views) {
      Object.assign(view.contentEl, { onWindowMigrated: () => () => {} });
      document.body.appendChild(view.containerEl);
      await view.onOpen();
      await view.setState({ file: "Studio/Test.systemsculpt" }, {} as any);
    }
    const title = (view: SystemSculptStudioView) => view.contentEl.querySelector<HTMLInputElement>(".ss-studio-node-title-input")!;
    for (const value of ["3", "4"]) {
      const editingTitle = title(views[0]);
      editingTitle.focus();
      editingTitle.value = value;
      editingTitle.dispatchEvent(new Event("input", { bubbles: true }));
      expect(title(views[0])).toBe(editingTitle);
      expect(document.activeElement).toBe(editingTitle);
      expect(title(views[1]).value).toBe(value);
      await session.flushPendingSaveWork();
      expect(title(views[0])).toBe(editingTitle);
      expect(document.activeElement).toBe(editingTitle);
    }
    title(views[0]).blur();
    if (mode === "untouched peer") {
      active = views[1];
      const event = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      await session.flushPendingSaveWork();
      expect(disk.graph.nodes[0].title).toBe("4");
      return;
    }
    if (mode === "independent peer edit") {
      active = views[1];
      const peerTitle = views[1].contentEl.querySelectorAll<HTMLInputElement>(".ss-studio-node-title-input")[1];
      peerTitle.value = "Peer edit";
      peerTitle.dispatchEvent(new Event("input", { bubbles: true }));
      expect(views[0].contentEl.querySelectorAll<HTMLInputElement>(".ss-studio-node-title-input")[1].value).toBe("Peer edit");
      await session.flushPendingSaveWork();
      active = views[0];
    }
    const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(title(views[0]).value).toBe("3");
    expect(title(views[1]).value).toBe("3");
    await session.flushPendingSaveWork();
    expect(disk.graph.nodes[0].title).toBe("3");
    expect(title(views[0]).value).toBe("3");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    expect(title(views[0]).value).toBe("2");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(title(views[0]).value).toBe("3");
    await session.flushPendingSaveWork();
    expect(disk.graph.nodes[0].title).toBe("3");
    expect(disk.graph.nodes[1].title).toBe(mode === "independent peer edit" ? "Peer edit" : "Before peer");
  } finally {
    keymap.dispose();
    for (const view of views) { await view.onClose(); view.containerEl.remove(); }
    await session.close();
    hostPrototype.setState = originalSetState;
  }
});
