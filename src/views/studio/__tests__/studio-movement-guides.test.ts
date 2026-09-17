/** @jest-environment jsdom */
import { App, type WorkspaceLeaf } from "obsidian";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { createEmptyStudioProject } from "../../../studio/schema";
import { installWindowPointerListenerHarness } from "./studio-graph-pointer-test-helpers";

function harness() {
  const project = createEmptyStudioProject({ name: "Guides", policyPath: "policy.json", minPluginVersion: "0", maxRuns: 1, maxArtifactsMb: 1 });
  project.graph.nodes = [{ id: "card", kind: "studio.text", title: "Card", version: "1.0.0", config: {}, position: { x: 0, y: 0 } }];
  project.graph.groups = [{ id: "group", name: "Group", nodeIds: ["card"], shapeIds: ["drawing"] }];
  project.diagram = { shapes: [
    { id: "drawing", shape: "rectangle", label: "Drawing", position: { x: 150, y: 0 }, size: { width: 100, height: 100 } },
    { id: "target", shape: "rectangle", label: "Target", position: { x: 500, y: 0 }, size: { width: 100, height: 100 } },
  ], arrows: [] };
  const view = new SystemSculptStudioView({ app: new App() } as WorkspaceLeaf, {} as any) as any;
  jest.spyOn(view, "currentProject", "get").mockReturnValue(project);
  jest.spyOn(view, "render").mockImplementation(() => undefined);
  jest.spyOn(view.projectSessionController, "commitMutation").mockImplementation((_reason, mutate) => (mutate as Function)(project) !== false);
  const layer = document.createElement("div");
  const canvas = document.createElement("div");
  view.graphCanvasEl = canvas;
  const node = document.createElement("div");
  Object.defineProperties(node, { offsetWidth: { value: 100 }, offsetHeight: { value: 100 } });
  view.graphInteraction.registerNodeElement("card", node);
  view.graphInteraction.registerAlignmentGuidesElement(layer);
  view.graphInteraction.registerCanvasElement(canvas);
  return { project, view, layer, canvas, node };
}

it("renders actual mixed-selection gaps during a shape drag and clears them on release", () => {
  const { project, view, layer } = harness();
  view.graphInteraction.setSelectedNodeIds(["card"]);
  view.shapeController.setSelectedShapeIds(["drawing"]);
  const drag = view.shapeController.layerOptions().onMoveSelection;
  drag({ x: 20, y: 3 }, { first: true, final: false });
  expect(project.graph.nodes[0].position).toEqual({ x: 20, y: 0 });
  expect(project.diagram?.shapes[0].position).toEqual({ x: 170, y: 0 });
  expect(layer.textContent).toContain("230 px");
  expect(layer.textContent).not.toContain("to align");
  expect(layer.querySelector(".ss-studio-alignment-guide.is-near")).toBeNull();
  drag({ x: 20, y: 3 }, { first: false, final: true });
  expect(layer.children).toHaveLength(0);
  expect(project.diagram?.shapes[1].position).toEqual({ x: 500, y: 0 });
});

it.each(["pointerup", "pointercancel"] as const)("renders group guides and clears them on %s", (ending) => {
  const { project, view, layer, canvas } = harness();
  view.graphInteraction.renderGroupLayer();
  expect(canvas.querySelector('[data-testid="studio.group.align"]')).toBeNull();
  const frame = canvas.querySelector(".ss-studio-group-frame")!;
  const frames: FrameRequestCallback[] = [];
  const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  const listeners = installWindowPointerListenerHarness();
  try {
    const start = new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true });
    Object.defineProperty(start, "pointerId", { value: 7 });
    frame.dispatchEvent(start);
    listeners.emit("pointermove", { pointerId: 7, clientX: 120, clientY: 103 } as PointerEvent);
    frames.splice(0).forEach((callback) => callback(0));
    expect(layer.textContent).toContain("230 px");
    expect(project.graph.nodes[0].position).toEqual({ x: 20, y: 0 });
    listeners.emit(ending, { pointerId: 7, clientX: 120, clientY: 103 } as PointerEvent);
    expect(layer.children).toHaveLength(0);
  } finally { listeners.restore(); raf.mockRestore(); }
});

it("keeps distances in canvas pixels while guide coordinates scale with zoom", () => {
  const { view, layer } = harness();
  view.graphInteraction.setGraphZoom(0.5);
  view.graphInteraction.showMovementGuides(["card"], ["drawing"]);
  expect(layer.textContent).toContain("250 px");
  expect(layer.querySelector<HTMLElement>(".ss-studio-distance-span")?.style.width).toBe("125px");
  expect(layer.querySelector(".ss-studio-alignment-guide.is-near")).toBeNull();
  view.graphInteraction.setGraphZoom(2);
  view.graphInteraction.showMovementGuides(["card"], ["drawing"]);
  expect(layer.textContent).toContain("250 px");
  expect(layer.querySelector<HTMLElement>(".ss-studio-distance-span")?.style.width).toBe("500px");
});

it("restores a cancelled mixed shape drag exactly even when its origin is near a target", () => {
  const { project, view } = harness();
  project.graph.nodes[0].position.y = 3;
  project.diagram!.shapes[0].position.y = 3;
  view.graphInteraction.setSelectedNodeIds(["card"]);
  view.shapeController.setSelectedShapeIds(["drawing"]);
  const drag = view.shapeController.layerOptions().onMoveSelection;
  drag({ x: 20, y: 2 }, { first: true, final: false });
  expect(project.graph.nodes[0].position.y).toBe(0);
  drag({ x: 0, y: 0 }, { first: false, final: true, cancelled: true });
  expect(project.graph.nodes[0].position).toEqual({ x: 0, y: 3 });
  expect(project.diagram!.shapes[0].position).toEqual({ x: 150, y: 3 });
});
