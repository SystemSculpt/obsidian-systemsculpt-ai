/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import {
  STUDIO_GRAPH_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_NODE_MIN_WIDTH,
} from "../StudioGraphNodeGeometry";
import { mountStudioGraphNodeResizeHandle } from "../StudioGraphNodeResizeHandle";

function createNode(kind = "studio.http_request"): StudioNodeInstance {
  return {
    id: "node_1",
    kind,
    version: "1.0.0",
    title: "Node",
    position: { x: 0, y: 0 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

function createPointerEvent(
  type: string,
  options: { pointerId: number; clientX: number; clientY: number; button?: number }
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
    button: options.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", {
    value: options.pointerId,
    configurable: true,
  });
  return event as PointerEvent;
}

describe("mountStudioGraphNodeResizeHandle", () => {
  beforeEach(() => {
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("applies zoom-aware resize deltas and commits config on pointer up", () => {
    const node = createNode();
    const nodeEl = document.body.createDiv();
    const onNodeConfigMutated = jest.fn();
    const onNodeGeometryMutated = jest.fn();

    mountStudioGraphNodeResizeHandle({
      node,
      nodeEl,
      title: "Resize node",
      ariaLabel: "Resize node",
      interactionLocked: false,
      getGraphZoom: () => 2,
      onNodeConfigMutated,
      onNodeGeometryMutated,
      applySize: ({ width, height }) => {
        nodeEl.style.width = `${width}px`;
        nodeEl.style.minHeight = `${height}px`;
      },
      readInitialSize: () => ({ width: 300, height: 200 }),
    });

    const handleEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-resize-handle");
    expect(handleEl).not.toBeNull();
    if (!handleEl) {
      return;
    }

    handleEl.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 7, clientX: 100, clientY: 100 }));
    window.dispatchEvent(createPointerEvent("pointermove", { pointerId: 7, clientX: 140, clientY: 180 }));

    expect(node.config.width).toBe(320);
    expect(node.config.height).toBe(240);
    expect(onNodeGeometryMutated).toHaveBeenCalled();

    window.dispatchEvent(createPointerEvent("pointerup", { pointerId: 7, clientX: 140, clientY: 180 }));
    expect(onNodeConfigMutated).toHaveBeenCalledTimes(1);
  });

  it("clamps resized dimensions to the node bounds", () => {
    const node = createNode();
    const nodeEl = document.body.createDiv();

    mountStudioGraphNodeResizeHandle({
      node,
      nodeEl,
      title: "Resize node",
      ariaLabel: "Resize node",
      interactionLocked: false,
      getGraphZoom: () => 1,
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      applySize: () => undefined,
      readInitialSize: () => ({ width: 300, height: 220 }),
    });

    const handleEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-resize-handle");
    expect(handleEl).not.toBeNull();
    if (!handleEl) {
      return;
    }

    handleEl.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 3, clientX: 200, clientY: 200 }));
    window.dispatchEvent(createPointerEvent("pointermove", { pointerId: 3, clientX: -999, clientY: -999 }));
    window.dispatchEvent(createPointerEvent("pointerup", { pointerId: 3, clientX: -999, clientY: -999 }));

    expect(node.config.width).toBe(STUDIO_GRAPH_NODE_MIN_WIDTH);
    expect(node.config.height).toBe(STUDIO_GRAPH_NODE_MIN_HEIGHT);
  });

  it("keeps a disabled resize handle non-interactive", () => {
    const node = createNode("studio.terminal");
    const nodeEl = document.body.createDiv();
    const onNodeConfigMutated = jest.fn();
    const onNodeGeometryMutated = jest.fn();

    mountStudioGraphNodeResizeHandle({
      node,
      nodeEl,
      title: "Resize terminal node",
      ariaLabel: "Resize terminal node",
      interactionLocked: true,
      getGraphZoom: () => 1,
      onNodeConfigMutated,
      onNodeGeometryMutated,
      applySize: () => undefined,
      readInitialSize: () => ({ width: 640, height: 420 }),
    });

    const handleEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-resize-handle");
    expect(handleEl?.classList.contains("is-disabled")).toBe(true);

    handleEl?.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 11, clientX: 0, clientY: 0 }));
    window.dispatchEvent(createPointerEvent("pointermove", { pointerId: 11, clientX: 120, clientY: 120 }));
    window.dispatchEvent(createPointerEvent("pointerup", { pointerId: 11, clientX: 120, clientY: 120 }));

    expect(onNodeConfigMutated).not.toHaveBeenCalled();
    expect(onNodeGeometryMutated).not.toHaveBeenCalled();
  });
});
