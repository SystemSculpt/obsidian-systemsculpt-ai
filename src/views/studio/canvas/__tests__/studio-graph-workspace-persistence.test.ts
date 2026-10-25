/** @jest-environment jsdom */

import type { StudioNodeInstance, StudioProjectV1 } from "../../../../studio/types";
import { cloneStudioProjectSnapshot } from "../../../../studio/StudioProjectSnapshots";
import { reconcileStudioProject } from "../../../../studio/StudioProjectReconciliation";
import { mergeStudioText } from "../../../../studio/document/StudioTextMerge";
import { renderStudioGraphWorkspace, type StudioGraphWorkspaceRendererOptions } from "../StudioGraphWorkspaceRenderer";

jest.mock("../../../../studio/StudioProjectSnapshots", () => {
  const actual = jest.requireActual("../../../../studio/StudioProjectSnapshots");
  return { ...actual, cloneStudioProjectSnapshot: jest.fn(actual.cloneStudioProjectSnapshot) };
});
jest.mock("../../../../studio/StudioProjectReconciliation", () => {
  const actual = jest.requireActual("../../../../studio/StudioProjectReconciliation");
  return { ...actual, reconcileStudioProject: jest.fn(actual.reconcileStudioProject) };
});
jest.mock("../../../../studio/document/StudioTextMerge", () => {
  const actual = jest.requireActual("../../../../studio/document/StudioTextMerge");
  return { ...actual, mergeStudioText: jest.fn(actual.mergeStudioText) };
});

function node(id: string, x = 0, title = id): StudioNodeInstance {
  return { id, kind: "missing.kind", version: "1.0.0", title, position: { x, y: 0 }, config: {}, continueOnError: false, disabled: false };
}

function project(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: "studio.project.v1", projectId: "persistent", name: "Persistent", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" },
    graph: { nodes, edges: [], entryNodeIds: [], groups: [] },
    permissionsRef: { policyVersion: 1, policyPath: "policy.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 10 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function options(currentProject: StudioProjectV1): StudioGraphWorkspaceRendererOptions {
  const no = jest.fn();
  const graphInteraction = {
    registerViewportElement: no, handleGraphViewportWheel: no, startMarqueeSelection: no, startCanvasPan: no,
    getGraphZoom: () => 1, registerSurfaceElement: no, registerCanvasElement: no, registerMarqueeElement: no,
    registerAlignmentGuidesElement: no, registerZoomLabelElement: no, registerEdgesLayerElement: no,
    clearGraphElementMaps: no, registerNodeElement: no, registerPortElement: no, renderGroupLayer: no,
    refreshNodeSelectionClasses: no, applyGraphZoom: no, refreshSelectionResizeFrame: no,
    isNodeSelected: () => false, onNodeRemoved: no, notifyNodePositionsChanged: no,
    getNodeElement: (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`),
    isPendingConnectionSource: () => false, getPendingConnection: () => null,
  } as any;
  return {
    root: document.createElement("div"), busy: false, currentProject, currentProjectPath: "Studio/Persistent.systemsculpt",
    nodeDetailMode: "expanded", graphInteraction, getNodeRunState: () => ({ status: "idle", message: "", updatedAt: null, outputs: null }),
    findNodeDefinition: () => null, onRunGraph: no, onOpenAddNodeMenuAtViewportCenter: no, activeCanvasTool: "select", onSelectCanvasTool: no,
    shapeLayer: { selection: { shapeIds: [], arrowIds: [] }, onSelect: no, onMoveSelection: no, onResizeShape: no, onLabelChange: no, onArrowLabelChange: no, onConnectShapes: no, registerLayerHandle: no },
    onZoomIn: no, onZoomOut: no, onZoomReset: no, onZoomOverview: no, onToggleNodeDetailMode: no, onOpenNodeContextMenu: no,
    onCreateTextNodeAtPosition: no, onRunNode: no, onCopyTextGenerationPromptBundle: no, onToggleTextGenerationOutputLock: no,
    onRemoveNode: no, onNodeTitleInput: no, onNodeConfigMutated: no, onNodeGeometryMutated: no,
    takeTextNodeEditorMountState: () => ({ isEditing: false, shouldAutoFocus: false }), onRequestTextNodeEdit: no, onStopTextNodeEdit: no, onRevealPathInFinder: no,
  };
}

describe("persistent Studio graph workspace", () => {
  it("keeps unaffected cards mounted and patches geometry in place", () => {
    const initial = options(project([node("moving", 10), node("other", 100)]));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const moving = initial.root.querySelector<HTMLElement>('[data-node-id="moving"]')!;
    const other = initial.root.querySelector<HTMLElement>('[data-node-id="other"]')!;

    const next = options(project([node("moving", 45), node("other", 100, "changed")]));
    next.root = initial.root;
    expect(handle.refresh(next)).toBe(true);

    expect(initial.root.querySelector('[data-node-id="moving"]')).toBe(moving);
    expect(moving.style.transform).toBe("translate(45px, 0px)");
    expect(initial.root.querySelector('[data-node-id="other"]')).toBe(other);
    expect(other.querySelector<HTMLInputElement>(".ss-studio-node-title-input")?.value).toBe("changed");
    expect((initial.graphInteraction as any).notifyNodePositionsChanged).toHaveBeenCalled();
  });

  it("does not replace a focused card when its snapshot changes", () => {
    const initial = options(project([node("editing")]));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const editing = initial.root.querySelector<HTMLElement>('[data-node-id="editing"]')!;
    const input = editing.appendChild(document.createElement("input"));
    input.focus();
    const next = options(project([node("editing", 0, "external title")]));
    next.root = initial.root;

    expect(handle.refresh(next)).toBe(true);
    expect(initial.root.querySelector('[data-node-id="editing"]')).toBe(editing);
    expect(document.activeElement).toBe(input);
  });

  it("remounts a mounted text card when it enters and leaves edit mode", () => {
    const text: StudioNodeInstance = { ...node("note"), kind: "studio.text", config: { value: "Hello" } };
    let editing = false;
    const initial = options(project([text]));
    initial.isTextNodeEditing = () => editing;
    initial.takeTextNodeEditorMountState = () => ({ isEditing: editing, shouldAutoFocus: false });
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const preview = initial.root.querySelector<HTMLElement>('[data-node-id="note"]')!;
    expect(preview.querySelector(".ss-studio-text-node-editor")).toBeNull();
    preview.tabIndex = 0;
    preview.focus();

    editing = true;
    expect(handle.refresh(initial)).toBe(true);
    const editingCard = initial.root.querySelector<HTMLElement>('[data-node-id="note"]')!;
    expect(editingCard).not.toBe(preview);
    expect(editingCard.querySelector(".ss-studio-text-node-editor")).not.toBeNull();

    editing = false;
    expect(handle.refresh(initial)).toBe(true);
    const restored = initial.root.querySelector<HTMLElement>('[data-node-id="note"]')!;
    expect(restored).not.toBe(editingCard);
    expect(restored.querySelector(".ss-studio-text-node-editor")).toBeNull();
    expect(initial.root.querySelectorAll('[data-node-id="note"]')).toHaveLength(1);
  });

  it("commits 30 keystrokes into a 40-node canvas as plain values without cloning or merging the project", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({ ...node(`n${index}`, index * 320, `Card ${index}`), config: { note: "x".repeat(2400) } }));
    const current = project(nodes);
    const typed: string[] = [];
    const initial = options(current);
    initial.onNodeTitleInput = (target, title) => { typed.push(title); current.graph.nodes.find(item => item.id === target.id)!.title = title; };
    document.body.appendChild(initial.root);
    renderStudioGraphWorkspace(initial);
    const input = initial.root.querySelector<HTMLElement>('[data-node-id="n7"]')!.querySelector<HTMLInputElement>(".ss-studio-node-title-input")!;
    jest.mocked(cloneStudioProjectSnapshot).mockClear();
    jest.mocked(reconcileStudioProject).mockClear();
    jest.mocked(mergeStudioText).mockClear();

    for (let index = 1; index <= 30; index++) {
      input.value = `Card 7${"!".repeat(index)}`;
      input.dispatchEvent(new Event("input"));
    }

    expect(typed).toHaveLength(30);
    expect(current.graph.nodes[7].title).toBe(`Card 7${"!".repeat(30)}`);
    expect(cloneStudioProjectSnapshot).not.toHaveBeenCalled();
    expect(reconcileStudioProject).not.toHaveBeenCalled();
    expect(mergeStudioText).not.toHaveBeenCalled();
  });

  it("merges a keystroke into a title another writer changed after the card displayed it", () => {
    const current = project([node("card", 0, "Weekly")]);
    const typed: string[] = [];
    const initial = options(current);
    initial.onNodeTitleInput = (_target, title) => { typed.push(title); };
    document.body.appendChild(initial.root);
    renderStudioGraphWorkspace(initial);
    const input = initial.root.querySelector<HTMLElement>('[data-node-id="card"]')!.querySelector<HTMLInputElement>(".ss-studio-node-title-input")!;
    current.graph.nodes[0].title = "Draft Weekly";
    input.value = "Weekly review";
    input.dispatchEvent(new Event("input"));
    expect(typed).toEqual(["Draft Weekly review"]);
  });

  it("does not overwrite gesture-owned geometry during an incoming refresh", () => {
    const initial = options(project([node("dragging", 10)]));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const dragging = initial.root.querySelector<HTMLElement>('[data-node-id="dragging"]')!;
    dragging.style.transform = "translate(80px, 0px)";
    const next = options(project([node("dragging", 300)]));
    next.root = initial.root;
    next.shouldPreserveNodeElement = id => id === "dragging";

    expect(handle.refresh(next)).toBe(true);
    expect(initial.root.querySelector('[data-node-id="dragging"]')).toBe(dragging);
    expect(dragging.style.transform).toBe("translate(80px, 0px)");
  });

  it("locks and unlocks cards in place when a run starts and ends, remounting only a command center", () => {
    const center = { ...node("center"), kind: "studio.command_center" };
    const initial = options(project([node("worker"), center]));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const card = (id: string) => initial.root.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    const worker = card("worker"), firstCenter = card("center");
    const title = worker.querySelector<HTMLInputElement>(".ss-studio-node-title-input")!;
    const controls = () => [title, ...worker.querySelectorAll<HTMLButtonElement>('[data-testid="studio.node.run"], [data-testid="studio.node.remove"]')];
    expect(controls()).toHaveLength(3);
    expect(controls().map(control => control.disabled)).toEqual([false, false, false]);

    const running = { ...options(initial.currentProject!), root: initial.root, busy: true };
    expect(handle.refresh(running)).toBe(true);
    expect(card("worker")).toBe(worker);
    expect(controls().map(control => control.disabled)).toEqual([true, true, true]);
    // A command center shows its targets' run status, so it remounts.
    expect(card("center")).not.toBe(firstCenter);

    const finished = { ...options(initial.currentProject!), root: initial.root, busy: false };
    expect(handle.refresh(finished)).toBe(true);
    expect(card("worker")).toBe(worker);
    expect(controls().map(control => control.disabled)).toEqual([false, false, false]);
    initial.root.remove();
  });

  it("locks a focused card only once focus leaves it", async () => {
    const initial = options(project([node("typing")]));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const typing = initial.root.querySelector<HTMLElement>('[data-node-id="typing"]')!;
    const title = typing.querySelector<HTMLInputElement>(".ss-studio-node-title-input")!;
    title.focus();

    const running = { ...options(initial.currentProject!), root: initial.root, busy: true };
    expect(handle.refresh(running)).toBe(true);
    expect(title.disabled).toBe(false);
    expect(document.activeElement).toBe(title);

    // Focus leaving the card refreshes it on its own.
    title.blur();
    await Promise.resolve();
    expect(initial.root.querySelector('[data-node-id="typing"]')).toBe(typing);
    expect(title.disabled).toBe(true);
    initial.root.remove();
  });

  it("remounts a media card when its model catalog arrives and changes the inputs it offers", () => {
    let hidden: string[] = [];
    const video = { ...node("video"), kind: "studio.video_generation" };
    const withPlan = (base: StudioGraphWorkspaceRendererOptions): StudioGraphWorkspaceRendererOptions => ({
      ...base,
      resolveMediaNodeInputPlan: () => ({ kind: "video", modelId: "m", model: null, hiddenInputPortIds: [...hidden], inputPortNotes: {}, hiddenFieldKeys: [] }),
    });
    const initial = withPlan(options(project([video])));
    document.body.appendChild(initial.root);
    const handle = renderStudioGraphWorkspace(initial);
    const first = initial.root.querySelector('[data-node-id="video"]');
    expect(handle.refresh({ ...withPlan(options(initial.currentProject!)), root: initial.root })).toBe(true);
    expect(initial.root.querySelector('[data-node-id="video"]')).toBe(first);

    hidden = ["image"];
    expect(handle.refresh({ ...withPlan(options(initial.currentProject!)), root: initial.root })).toBe(true);
    expect(initial.root.querySelector('[data-node-id="video"]')).not.toBe(first);
    initial.root.remove();
  });
});
