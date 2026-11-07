/** @jest-environment jsdom */
import { StudioOutputContainerController } from "../StudioOutputContainerController";
import { createEmptyStudioProject } from "../../../studio/schema";
import { materializeImageOutputsAsMediaNodes } from "../../../studio/StudioManagedOutputNodes";

it("measures only output cards, reflows growing rows, waits for the end of a drag without polling, and cancels on disposal", () => {
  jest.useFakeTimers();
  const original = window.ResizeObserver;
  let resized = () => {};
  const observed: Element[] = [];
  const disconnect = jest.fn();
  window.ResizeObserver = class {
    constructor(callback: () => void) { resized = callback; }
    observe(element: Element) { observed.push(element); }
    unobserve() {}
    disconnect = disconnect;
  } as unknown as typeof ResizeObserver;
  const project = createEmptyStudioProject({ name: "Outputs", policyPath: "policy.json", minPluginVersion: "0", maxRuns: 1, maxArtifactsMb: 1 });
  const source = { id: "source", kind: "studio.image_generation", title: "Images", version: "1.0.0", position: { x: 10, y: 20 }, config: {} };
  project.graph.nodes = [source];
  let counter = 0;
  materializeImageOutputsAsMediaNodes({ project, sourceNode: source, outputs: { images: ["a", "b", "c", "d"].map(path => ({ path })) }, createNodeId: () => `n${++counter}`, createEdgeId: () => `e${counter}` });
  const elements = new Map(project.graph.nodes.map(node => {
    const element = document.createElement("div"); element.dataset.nodeId = node.id;
    Object.defineProperty(element, "offsetWidth", { value: 280 });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: 200 });
    return [node.id, element] as const;
  }));
  let dragging = false;
  const positionsChanged = jest.fn();
  const controller = new StudioOutputContainerController({ getProject: () => project, getNodeElement: id => elements.get(id) || null,
    isDragging: () => dragging, commit: mutate => mutate(project), positionsChanged });
  try {
    controller.mount(document.createElement("div"));
    jest.advanceTimersByTime(40);
    expect(observed.map(el => (el as HTMLElement).dataset.nodeId)).toEqual(["n1", "n2", "n3", "n4", "source"]);
    expect(project.graph.nodes[4].position.y).toBe(268);
    dragging = true;
    Object.defineProperty(elements.get("n2"), "offsetHeight", { value: 500 });
    resized(); jest.advanceTimersByTime(40);
    expect(project.graph.nodes[4].position.y).toBe(268);
    expect(jest.getTimerCount()).toBe(0);
    // The view schedules again when the drag ends.
    dragging = false; controller.schedule(); jest.advanceTimersByTime(40);
    expect(project.graph.nodes[4].position.y).toBe(568);
    expect(source.position).toEqual({ x: 10, y: 20 });
    // The last card grows in place: nothing moves, but its container frame must follow.
    const before = positionsChanged.mock.calls.length;
    Object.defineProperty(elements.get("n4"), "offsetHeight", { value: 640 });
    resized(); jest.advanceTimersByTime(40);
    expect(project.graph.nodes[4].position.y).toBe(568);
    expect(positionsChanged).toHaveBeenCalledTimes(before + 1);
    const calls = positionsChanged.mock.calls.length;
    resized(); controller.dispose(); jest.advanceTimersByTime(80);
    expect(positionsChanged).toHaveBeenCalledTimes(calls);
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally { controller.dispose(); window.ResizeObserver = original; jest.useRealTimers(); }
});

it("watches an output card that an in-place refresh adds after mounting", () => {
  jest.useFakeTimers();
  const original = window.ResizeObserver;
  const observed: Element[] = [];
  window.ResizeObserver = class {
    observe(element: Element) { observed.push(element); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const project = createEmptyStudioProject({ name: "Outputs", policyPath: "policy.json", minPluginVersion: "0", maxRuns: 1, maxArtifactsMb: 1 });
  const source = { id: "source", kind: "studio.image_generation", title: "Images", version: "1.0.0", position: { x: 10, y: 20 }, config: {} };
  project.graph.nodes = [source];
  const elements = new Map<string, HTMLElement>();
  const card = (id: string) => { const element = document.createElement("div"); element.dataset.nodeId = id; elements.set(id, element); return element; };
  card("source");
  const positionsChanged = jest.fn();
  const controller = new StudioOutputContainerController({ getProject: () => project, getNodeElement: id => elements.get(id) || null,
    isDragging: () => false, commit: mutate => mutate(project), positionsChanged });
  try {
    controller.mount(document.createElement("div"));
    expect(observed).toHaveLength(0);
    materializeImageOutputsAsMediaNodes({ project, sourceNode: source, outputs: { images: [{ path: "a" }] }, createNodeId: () => "n1", createEdgeId: () => "e1" });
    card("n1");
    expect(controller.sync()).toBe(true);
    expect(controller.sync()).toBe(false);
    expect(observed.map(el => (el as HTMLElement).dataset.nodeId).sort()).toEqual(["n1", "source"]);
    jest.advanceTimersByTime(40);
    expect(positionsChanged).toHaveBeenCalledTimes(1);
  } finally { controller.dispose(); window.ResizeObserver = original; jest.useRealTimers(); }
});
