import { StudioGraphSelectionController } from "../StudioGraphSelectionController";
import {
  createElementStub,
  installWindowPointerListenerHarness,
} from "./studio-graph-pointer-test-helpers";

type TestHost = ConstructorParameters<typeof StudioGraphSelectionController>[0];

function createHost(project: unknown): TestHost {
  const host: TestHost = {
    isBusy: () => false,
    getCurrentProject: () => project as ReturnType<TestHost["getCurrentProject"]>,
    renderEdgeLayer: () => undefined,
    commitProjectMutation: (_reason, mutator) => mutator(project as never) !== false,
  };
  return host;
}

function createSizedNodeElement(width: number, height: number): HTMLElement {
  const el = createElementStub() as HTMLElement & {
    offsetWidth: number;
    offsetHeight: number;
  };
  (el as { offsetWidth: number }).offsetWidth = width;
  (el as { offsetHeight: number }).offsetHeight = height;
  return el;
}

/**
 * Two 200x150 nodes. node_1 starts at (40, 50) and drags right by 100 with a
 * 3px vertical misalignment against node_2 at (600, 47): well inside the 8px
 * snap radius, so the drop should land dead on node_2's top edge.
 */
function createProject(): {
  graph: { nodes: Array<{ id: string; position: { x: number; y: number }; kind: string; config: Record<string, unknown> }> };
} {
  return {
    graph: {
      nodes: [
        { id: "node_1", position: { x: 40, y: 50 }, kind: "studio.input", config: {} },
        { id: "node_2", position: { x: 600, y: 47 }, kind: "studio.input", config: {} },
      ],
    },
  };
}

function dragNode(
  controller: StudioGraphSelectionController,
  nodeEl: HTMLElement,
  move: { clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean }
): void {
  const startEvent = {
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 120,
    ctrlKey: false,
    metaKey: false,
    preventDefault: jest.fn(),
  } as unknown as PointerEvent;

  const harness = installWindowPointerListenerHarness();
  try {
    controller.startNodeDrag("node_1", startEvent, nodeEl);
    harness.emit(
      "pointermove",
      {
        pointerId: 7,
        ctrlKey: false,
        metaKey: false,
        preventDefault: jest.fn(),
        ...move,
      } as unknown as PointerEvent
    );
    harness.emit(
      "pointerup",
      { pointerId: 7, clientX: move.clientX, clientY: move.clientY } as PointerEvent
    );
  } finally {
    harness.restore();
  }
}

describe("StudioGraphSelectionController drag snapping", () => {
  it("snaps a dragged node into edge alignment with a nearby static node", () => {
    const project = createProject();
    const controller = new StudioGraphSelectionController(createHost(project));
    const node1El = createSizedNodeElement(200, 150);
    controller.registerNodeElement("node_1", node1El);
    controller.registerNodeElement("node_2", createSizedNodeElement(200, 150));

    // Raw drop would be (140, 50); node_2's top edge at y=47 is 3px away.
    dragNode(controller, node1El, { clientX: 200, clientY: 120 });

    expect(project.graph.nodes[0].position).toEqual({ x: 140, y: 47 });
  });

  it("freeballs placement while Ctrl is held", () => {
    const project = createProject();
    const controller = new StudioGraphSelectionController(createHost(project));
    const node1El = createSizedNodeElement(200, 150);
    controller.registerNodeElement("node_1", node1El);
    controller.registerNodeElement("node_2", createSizedNodeElement(200, 150));

    dragNode(controller, node1El, { clientX: 200, clientY: 120, ctrlKey: true });

    expect(project.graph.nodes[0].position).toEqual({ x: 140, y: 50 });
  });

  it("freeballs placement while Cmd is held", () => {
    const project = createProject();
    const controller = new StudioGraphSelectionController(createHost(project));
    const node1El = createSizedNodeElement(200, 150);
    controller.registerNodeElement("node_1", node1El);
    controller.registerNodeElement("node_2", createSizedNodeElement(200, 150));

    dragNode(controller, node1El, { clientX: 200, clientY: 120, metaKey: true });

    expect(project.graph.nodes[0].position).toEqual({ x: 140, y: 50 });
  });

  it("does not snap when the misalignment is outside the snap radius", () => {
    const project = createProject();
    project.graph.nodes[1].position = { x: 600, y: 30 }; // 20px off — too far.
    const controller = new StudioGraphSelectionController(createHost(project));
    const node1El = createSizedNodeElement(200, 150);
    controller.registerNodeElement("node_1", node1El);
    controller.registerNodeElement("node_2", createSizedNodeElement(200, 150));

    dragNode(controller, node1El, { clientX: 200, clientY: 120 });

    expect(project.graph.nodes[0].position).toEqual({ x: 140, y: 50 });
  });
});
