/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import {
  STUDIO_GRAPH_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_NODE_MIN_WIDTH,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
} from "../../../../studio/StudioNodeGeometry";
import {
  mountStudioGraphNodeResizeFrame,
  resolveStudioGraphResizeZoneLayout,
  STUDIO_GRAPH_RESIZE_CORNER_HIT_PX,
  STUDIO_GRAPH_RESIZE_EDGE_HIT_PX,
  STUDIO_GRAPH_RESIZE_ZONES,
} from "../StudioGraphNodeResizeFrame";
import type { StudioGraphNodeResizePatch } from "../StudioGraphNodeCardTypes";

function createNode(
  kind = "studio.http_request",
  overrides: Partial<StudioNodeInstance> = {}
): StudioNodeInstance {
  return {
    id: "node_1",
    kind,
    version: "1.0.0",
    title: "Node",
    position: { x: 200, y: 150 },
    config: {},
    continueOnError: false,
    disabled: false,
    ...overrides,
  };
}

function createPointerEvent(
  type: string,
  options: {
    pointerId: number;
    clientX: number;
    clientY: number;
    button?: number;
    ctrlKey?: boolean;
  }
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
    button: options.button ?? 0,
    ctrlKey: options.ctrlKey ?? false,
  });
  Object.defineProperty(event, "pointerId", {
    value: options.pointerId,
    configurable: true,
  });
  return event as PointerEvent;
}

function queryZone(nodeEl: HTMLElement, zone: string): HTMLElement {
  const zoneEl = nodeEl.querySelector<HTMLElement>(`[data-resize-zone="${zone}"]`);
  if (!zoneEl) {
    throw new Error(`Expected resize zone ${zone}`);
  }
  return zoneEl;
}

function dragZone(
  nodeEl: HTMLElement,
  zone: string,
  options: {
    pointerId?: number;
    from?: { x: number; y: number };
    to: { x: number; y: number };
    release?: boolean;
  }
): void {
  const pointerId = options.pointerId ?? 7;
  const from = options.from ?? { x: 0, y: 0 };
  queryZone(nodeEl, zone).dispatchEvent(
    createPointerEvent("pointerdown", { pointerId, clientX: from.x, clientY: from.y })
  );
  window.dispatchEvent(
    createPointerEvent("pointermove", { pointerId, clientX: options.to.x, clientY: options.to.y })
  );
  if (options.release !== false) {
    window.dispatchEvent(
      createPointerEvent("pointerup", { pointerId, clientX: options.to.x, clientY: options.to.y })
    );
  }
}

describe("mountStudioGraphNodeResizeFrame", () => {
  beforeEach(() => {
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function mountFrame(
    node: StudioNodeInstance,
    overrides: Partial<Parameters<typeof mountStudioGraphNodeResizeFrame>[0]> = {}
  ) {
    const nodeEl = document.body.createDiv();
    const onNodeConfigMutated = jest.fn();
    const onNodeGeometryMutated = jest.fn();
    const applySize = jest.fn();
    const unmount = mountStudioGraphNodeResizeFrame({
      node,
      nodeEl,
      title: "Resize node",
      ariaLabel: "Resize node",
      interactionLocked: false,
      getGraphZoom: () => 1,
      onNodeConfigMutated,
      onNodeGeometryMutated,
      applySize,
      readInitialSize: () => ({ width: 300, height: 200 }),
      ...overrides,
    });
    return { nodeEl, onNodeConfigMutated, onNodeGeometryMutated, applySize, unmount };
  }

  describe("frame structure", () => {
    it("mounts all eight zones with edge/corner classes and carved edge layout", () => {
      const { nodeEl } = mountFrame(createNode());

      expect(nodeEl.classList.contains("has-resize-frame")).toBe(true);
      const zoneEls = Array.from(
        nodeEl.querySelectorAll<HTMLElement>(".ss-studio-node-resize-zone")
      );
      expect(zoneEls).toHaveLength(8);
      expect(new Set(zoneEls.map((el) => el.dataset.resizeZone))).toEqual(
        new Set([...STUDIO_GRAPH_RESIZE_ZONES])
      );

      for (const zone of ["n", "s", "e", "w"]) {
        expect(queryZone(nodeEl, zone).classList.contains("is-edge")).toBe(true);
      }
      for (const zone of ["nw", "ne", "sw", "se"]) {
        expect(queryZone(nodeEl, zone).classList.contains("is-corner")).toBe(true);
      }
      expect(queryZone(nodeEl, "se").classList.contains("is-zone-se")).toBe(true);

      // Corners take precedence over edges by construction: edge strips are
      // carved back by the corner hit size so the zones never overlap.
      const eastEl = queryZone(nodeEl, "e");
      expect(eastEl.style.top).toBe(`${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`);
      expect(eastEl.style.bottom).toBe(`${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`);
      const northEl = queryZone(nodeEl, "n");
      expect(northEl.style.left).toBe(`${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`);
      expect(northEl.style.right).toBe(`${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`);

      // Corners are mounted after edges so equal stacking resolves corner-first.
      const lastFour = zoneEls.slice(4).map((el) => el.dataset.resizeZone);
      expect(new Set(lastFour)).toEqual(new Set(["nw", "ne", "sw", "se"]));
    });

    it("declares the carved zone layout as data", () => {
      const edge = `${STUDIO_GRAPH_RESIZE_EDGE_HIT_PX}px`;
      const edgeOffset = `${-STUDIO_GRAPH_RESIZE_EDGE_HIT_PX / 2}px`;
      const corner = `${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`;

      expect(resolveStudioGraphResizeZoneLayout("e")).toEqual({
        top: corner,
        bottom: corner,
        right: edgeOffset,
        width: edge,
      });
      expect(resolveStudioGraphResizeZoneLayout("s")).toEqual({
        left: corner,
        right: corner,
        bottom: edgeOffset,
        height: edge,
      });
      expect(resolveStudioGraphResizeZoneLayout("nw")).toEqual({
        top: edgeOffset,
        left: edgeOffset,
        width: corner,
        height: corner,
      });
    });

    it("keeps a disabled frame non-interactive", () => {
      const node = createNode("studio.terminal");
      const { nodeEl, onNodeConfigMutated, onNodeGeometryMutated } = mountFrame(node, {
        interactionLocked: true,
        readInitialSize: () => ({ width: 640, height: 420 }),
      });

      for (const zoneEl of Array.from(
        nodeEl.querySelectorAll<HTMLElement>(".ss-studio-node-resize-zone")
      )) {
        expect(zoneEl.classList.contains("is-disabled")).toBe(true);
      }

      dragZone(nodeEl, "se", { to: { x: 120, y: 120 } });
      expect(onNodeConfigMutated).not.toHaveBeenCalled();
      expect(onNodeGeometryMutated).not.toHaveBeenCalled();
    });

    it("marks the active zone while pointer tracking is live", () => {
      const { nodeEl } = mountFrame(createNode("studio.text"), {
        readFontSize: () => 16,
      });
      const zoneEl = queryZone(nodeEl, "se");

      zoneEl.dispatchEvent(
        createPointerEvent("pointerdown", { pointerId: 13, clientX: 100, clientY: 100 })
      );
      expect(zoneEl.classList.contains("is-active")).toBe(true);

      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 13, clientX: 100, clientY: 100 })
      );
      expect(zoneEl.classList.contains("is-active")).toBe(false);
    });
  });

  describe("box semantics (terminal) across all eight zones under zoom", () => {
    // zoom 2: pointer travel (40, 80) becomes canvas delta (20, 40).
    const cases: Array<{
      zone: string;
      patch: StudioGraphNodeResizePatch;
    }> = [
      { zone: "e", patch: { size: { width: 660 } } },
      { zone: "w", patch: { size: { width: 620 }, position: { x: 220, y: 150 } } },
      { zone: "s", patch: { size: { height: 460 } } },
      { zone: "n", patch: { size: { height: 380 }, position: { x: 200, y: 190 } } },
      { zone: "se", patch: { size: { width: 660, height: 460 } } },
      { zone: "ne", patch: { size: { width: 660, height: 380 }, position: { x: 200, y: 190 } } },
      { zone: "sw", patch: { size: { width: 620, height: 460 }, position: { x: 220, y: 150 } } },
      {
        zone: "nw",
        patch: { size: { width: 620, height: 380 }, position: { x: 220, y: 190 } },
      },
    ];

    for (const testCase of cases) {
      it(`maps a ${testCase.zone} drag to an atomic geometry patch`, () => {
        const node = createNode("studio.terminal");
        const onNodeResize = jest.fn();
        const { nodeEl } = mountFrame(node, {
          getGraphZoom: () => 2,
          onNodeResize,
          readInitialSize: () => ({ width: 640, height: 420 }),
        });

        dragZone(nodeEl, testCase.zone, { to: { x: 40, y: 80 } });

        expect(onNodeResize).toHaveBeenNthCalledWith(
          1,
          node.id,
          testCase.patch,
          expect.objectContaining({ mode: "continuous", captureHistory: true })
        );
        expect(onNodeResize).toHaveBeenNthCalledWith(
          2,
          node.id,
          testCase.patch,
          expect.objectContaining({ mode: "discrete", captureHistory: false })
        );
      });
    }
  });

  describe("shared #284 hardening", () => {
    it("applies zoom-aware deltas on the direct-fallback path and commits config on release", () => {
      const node = createNode();
      const { nodeEl, onNodeConfigMutated, onNodeGeometryMutated } = mountFrame(node, {
        getGraphZoom: () => 2,
        applySize: ({ width, height }) => {
          nodeEl.style.width = `${width}px`;
          if (height !== null) {
            nodeEl.style.minHeight = `${height}px`;
          }
        },
      });

      dragZone(nodeEl, "se", {
        from: { x: 100, y: 100 },
        to: { x: 140, y: 180 },
        release: false,
      });

      expect(node.size).toEqual({ width: 320, height: 240 });
      expect(node.config.width).toBeUndefined();
      expect(node.config.height).toBeUndefined();
      expect(onNodeGeometryMutated).toHaveBeenCalled();

      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 7, clientX: 140, clientY: 180 })
      );
      expect(onNodeConfigMutated).toHaveBeenCalledTimes(1);
    });

    it("clamps resized dimensions to the node bounds", () => {
      const node = createNode();
      const { nodeEl } = mountFrame(node, {
        readInitialSize: () => ({ width: 300, height: 220 }),
      });

      dragZone(nodeEl, "se", {
        pointerId: 3,
        from: { x: 200, y: 200 },
        to: { x: -999, y: -999 },
      });

      expect(node.size).toEqual({
        width: STUDIO_GRAPH_NODE_MIN_WIDTH,
        height: STUDIO_GRAPH_NODE_MIN_HEIGHT,
      });
    });

    it("applies the DOM size before the resize callback and captures history once", () => {
      const node = createNode();
      const mutationOrder: string[] = [];
      const onNodeResize = jest.fn(
        (_nodeId: string, patch: StudioGraphNodeResizePatch) => {
          mutationOrder.push(`callback:${patch.size?.width}x${patch.size?.height}`);
        }
      );
      const { nodeEl, onNodeConfigMutated, onNodeGeometryMutated } = mountFrame(node, {
        onNodeResize,
        applySize: ({ width, height }) => {
          mutationOrder.push(`dom:${width}x${height}`);
        },
      });

      dragZone(nodeEl, "se", {
        pointerId: 21,
        from: { x: 100, y: 100 },
        to: { x: 140, y: 150 },
      });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 340, height: 250 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(onNodeResize).toHaveBeenNthCalledWith(
        2,
        node.id,
        { size: { width: 340, height: 250 } },
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
      expect(mutationOrder).toEqual([
        "dom:340x250",
        "callback:340x250",
        "callback:340x250",
      ]);
      expect(onNodeConfigMutated).not.toHaveBeenCalled();
      expect(onNodeGeometryMutated).not.toHaveBeenCalled();
    });

    it("captures history only on the first mutating frame of a drag", () => {
      const node = createNode();
      const onNodeResize = jest.fn();
      const { nodeEl } = mountFrame(node, { onNodeResize });

      queryZone(nodeEl, "se").dispatchEvent(
        createPointerEvent("pointerdown", { pointerId: 5, clientX: 0, clientY: 0 })
      );
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 5, clientX: 20, clientY: 20 })
      );
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 5, clientX: 40, clientY: 40 })
      );
      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 5, clientX: 40, clientY: 40 })
      );

      expect(onNodeResize.mock.calls.map((call) => call[2])).toEqual([
        expect.objectContaining({ mode: "continuous", captureHistory: true }),
        expect.objectContaining({ mode: "continuous", captureHistory: false }),
        expect.objectContaining({ mode: "discrete", captureHistory: false }),
      ]);
    });

    it("finalizes callback-driven resizes from the latest pending size when the stored size is stale", () => {
      const node = createNode("studio.text");
      node.size = { width: 300, height: 200 };
      const onNodeResize = jest.fn();
      const { nodeEl } = mountFrame(node, {
        onNodeResize,
        readFontSize: () => 16,
        readInitialSize: () => ({ width: 300, height: 200 }),
      });

      dragZone(nodeEl, "e", {
        pointerId: 23,
        from: { x: 100, y: 100 },
        to: { x: 140, y: 150 },
      });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 340 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(onNodeResize).toHaveBeenNthCalledWith(
        2,
        node.id,
        { size: { width: 340 } },
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
    });
  });

  describe("text semantics", () => {
    function mountTextFrame(
      overrides: Partial<Parameters<typeof mountStudioGraphNodeResizeFrame>[0]> = {}
    ) {
      const node = createNode("studio.text", { config: { value: "hello", fontSize: 16 } });
      const onNodeResize = jest.fn();
      const onNodeConfigValueChange = jest.fn();
      const applyFontSize = jest.fn();
      const applied: Array<{ width: number; height: number | null }> = [];
      const base = mountFrame(node, {
        onNodeResize,
        onNodeConfigValueChange,
        applyFontSize,
        applySize: (size: { width: number; height: number | null }) => {
          applied.push(size);
        },
        readFontSize: () => 16,
        readInitialSize: () => ({ width: 300, height: 200 }),
        ...overrides,
      });
      return { node, onNodeResize, onNodeConfigValueChange, applyFontSize, applied, ...base };
    }

    it("commits width only on a side drag — never a height write", () => {
      const { nodeEl, node, onNodeResize, onNodeConfigValueChange, applied } = mountTextFrame();

      dragZone(nodeEl, "e", { to: { x: 40, y: 25 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 340 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      const patches = onNodeResize.mock.calls.map((call) => call[1] as StudioGraphNodeResizePatch);
      for (const patch of patches) {
        expect(patch.size?.height).toBeUndefined();
        expect(patch.fontSize).toBeUndefined();
      }
      expect(onNodeConfigValueChange).not.toHaveBeenCalled();
      expect(applied).toEqual([{ width: 340, height: null }]);
      expect(nodeEl.style.height).toBe("");
    });

    it("anchors the right edge on a left drag with an atomic position+width patch", () => {
      const { nodeEl, node, onNodeResize } = mountTextFrame();

      dragZone(nodeEl, "w", { to: { x: -40, y: 0 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 340 }, position: { x: 160, y: 150 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
    });

    it("scales fontSize by the rendered-height ratio on a bottom drag", () => {
      const { nodeEl, node, onNodeResize, onNodeConfigValueChange, applyFontSize } =
        mountTextFrame();

      dragZone(nodeEl, "s", { to: { x: 0, y: 50 } });

      // (200 + 50) / 200 = 1.25 → 16 × 1.25 = 20.
      expect(onNodeConfigValueChange).toHaveBeenNthCalledWith(
        1,
        node.id,
        "fontSize",
        20,
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(onNodeConfigValueChange).toHaveBeenNthCalledWith(
        2,
        node.id,
        "fontSize",
        20,
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
      expect(applyFontSize).toHaveBeenCalledWith(20);
      expect(onNodeResize).not.toHaveBeenCalled();
      expect(nodeEl.style.height).toBe("");
    });

    it("clamps bottom-drag fontSize scaling to the module bounds", () => {
      const { nodeEl, node, onNodeConfigValueChange } = mountTextFrame();

      // Height factor (200 + 8000) / 200 = 41 → raw fontSize 656 clamps to 512.
      dragZone(nodeEl, "s", { to: { x: 0, y: 8000 } });

      expect(onNodeConfigValueChange).toHaveBeenNthCalledWith(
        1,
        node.id,
        "fontSize",
        STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
        expect.anything()
      );
    });

    it("scales fontSize and anchors the bottom edge on a top drag in one atomic patch", () => {
      const { nodeEl, node, onNodeResize, onNodeConfigValueChange } = mountTextFrame();

      dragZone(nodeEl, "n", { to: { x: 0, y: -50 } });

      // (200 + 50) / 200 = 1.25 → fontSize 20; predicted height 250 keeps the
      // bottom edge anchored: y = 150 + (200 - 250) = 100.
      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { fontSize: 20, position: { x: 200, y: 100 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(onNodeConfigValueChange).not.toHaveBeenCalled();
    });

    it("scales fontSize and width proportionally on a corner drag in one atomic patch", () => {
      const { nodeEl, node, onNodeResize, onNodeConfigValueChange, applyFontSize, applied } =
        mountTextFrame();

      dragZone(nodeEl, "se", { to: { x: 150, y: 0 } });

      // Dominant axis: width 300→450 = ×1.5 → fontSize 24, width 450.
      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 450 }, fontSize: 24 },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(onNodeResize).toHaveBeenNthCalledWith(
        2,
        node.id,
        { size: { width: 450 }, fontSize: 24 },
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
      expect(onNodeConfigValueChange).not.toHaveBeenCalled();
      expect(applyFontSize).toHaveBeenCalledWith(24);
      expect(applied).toEqual([{ width: 450, height: null }]);
    });

    it("scales fontSize unclamped well past the old 48px ceiling on corner drags", () => {
      const { nodeEl, node, onNodeResize } = mountTextFrame();

      // ×4 raw scale: fontSize 16 → 64 (no clamp now), width follows ×4.
      dragZone(nodeEl, "se", { to: { x: 900, y: 0 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 1200 }, fontSize: 64 },
        expect.anything()
      );
    });

    it("keeps width in lockstep with the clamped fontSize factor on corner drags", () => {
      const { nodeEl, node, onNodeResize } = mountTextFrame();

      // ×41 raw scale clamps fontSize at 512 (×32) — lockstep width 9600 then
      // clamps to the text width bound itself.
      dragZone(nodeEl, "se", { to: { x: 12000, y: 0 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 4000 }, fontSize: STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE },
        expect.anything()
      );
    });
  });

  describe("aspect-width semantics (image/video content)", () => {
    function mountAspectFrame() {
      const node = createNode("studio.media_ingest");
      const onNodeResize = jest.fn();
      const applied: Array<{ width: number; height: number | null }> = [];
      const base = mountFrame(node, {
        hasAspectMediaContent: true,
        onNodeResize,
        applySize: (size: { width: number; height: number | null }) => {
          applied.push(size);
        },
        readInitialSize: () => ({ width: 300, height: 150 }),
      });
      Object.defineProperty(base.nodeEl, "offsetWidth", { value: 300, configurable: true });
      Object.defineProperty(base.nodeEl, "offsetHeight", { value: 150, configurable: true });
      return { node, onNodeResize, applied, ...base };
    }

    it("converts a bottom drag into a width change via the rendered aspect ratio", () => {
      const { nodeEl, node, onNodeResize, applied } = mountAspectFrame();

      dragZone(nodeEl, "s", { to: { x: 0, y: 50 } });

      // aspect 2:1 → +50px height ≈ +100px width.
      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 400 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(applied).toEqual([{ width: 400, height: null }]);
    });

    it("anchors the bottom edge on a top drag via the implied height", () => {
      const { nodeEl, node, onNodeResize } = mountAspectFrame();

      dragZone(nodeEl, "n", { to: { x: 0, y: -30 } });

      // +30 height → +60 width → implied height 180 → y = 150 + (150 - 180).
      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 360 }, position: { x: 200, y: 120 } },
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
    });

    it("uses the dominant axis on corner drags", () => {
      const { nodeEl, node, onNodeResize } = mountAspectFrame();

      dragZone(nodeEl, "se", { to: { x: 10, y: 50 } });

      // dx→+10 width vs dy→+100 width: the vertical conversion dominates.
      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { width: 400 } },
        expect.anything()
      );
    });

    it("falls back to generic min-height semantics when the card cannot be measured", () => {
      const node = createNode("studio.media_ingest");
      const onNodeResize = jest.fn();
      const { nodeEl } = mountFrame(node, {
        hasAspectMediaContent: true,
        onNodeResize,
        readInitialSize: () => ({ width: 300, height: 150 }),
      });
      // jsdom: offsetWidth/offsetHeight stay 0 — no aspect available.

      dragZone(nodeEl, "s", { to: { x: 0, y: 50 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { height: 200 } },
        expect.anything()
      );
    });
  });

  describe("generic min-height semantics", () => {
    it("writes the min-height floor on a bottom drag while leaving explicit height alone", () => {
      const node = createNode();
      const onNodeResize = jest.fn();
      const nodeEl = document.body.createDiv();
      mountStudioGraphNodeResizeFrame({
        node,
        nodeEl,
        title: "Resize node",
        ariaLabel: "Resize node",
        interactionLocked: false,
        getGraphZoom: () => 1,
        onNodeConfigMutated: jest.fn(),
        onNodeResize,
        onNodeGeometryMutated: jest.fn(),
        applySize: ({ width, height }) => {
          nodeEl.style.width = `${width}px`;
          if (height !== null) {
            nodeEl.style.minHeight = `${height}px`;
          }
        },
        readInitialSize: () => ({ width: 300, height: 200 }),
      });

      dragZone(nodeEl, "s", { to: { x: 0, y: 50 } });

      expect(onNodeResize).toHaveBeenNthCalledWith(
        1,
        node.id,
        { size: { height: 250 } },
        expect.anything()
      );
      // Container reflow semantics: the card keeps a min-height floor so
      // content can still overflow-grow past it.
      expect(nodeEl.style.minHeight).toBe("250px");
      expect(nodeEl.style.height).toBe("");
    });
  });

  describe("smart-guide snapping", () => {
    it("feeds the dragged-edge candidate rect to resolveResizeSnap and commits the adjusted size", () => {
      const node = createNode();
      const resolveResizeSnap = jest.fn(() => ({ deltaX: 5, deltaY: 0 }));
      const onResizeSnapEnd = jest.fn();
      const { nodeEl, onNodeConfigMutated } = mountFrame(node, {
        resolveResizeSnap,
        onResizeSnapEnd,
      });

      dragZone(nodeEl, "e", { from: { x: 100, y: 100 }, to: { x: 140, y: 100 }, release: false });

      // node at (200,150), initial 300x200, raw east delta +40 → the candidate
      // rect moves ONLY the dragged (right) edge; the anchored edges stay put.
      expect(resolveResizeSnap).toHaveBeenCalledWith(
        { left: 200, right: 540, top: 150, bottom: 350 },
        { x: 1, y: 0 }
      );
      // Snap adjustment (+5) lands on top of the raw delta: 300 + 40 + 5.
      expect(node.size?.width).toBe(345);

      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 7, clientX: 140, clientY: 100 })
      );
      expect(node.size?.width).toBe(345);
      expect(onNodeConfigMutated).toHaveBeenCalledTimes(1);
      // Release always clears the host's guide lines.
      expect(onResizeSnapEnd).toHaveBeenCalled();
    });

    it("bypasses snapping while Ctrl is held and clears live guides immediately", () => {
      const node = createNode();
      const resolveResizeSnap = jest.fn(() => ({ deltaX: 5, deltaY: 0 }));
      const onResizeSnapEnd = jest.fn();
      const { nodeEl } = mountFrame(node, { resolveResizeSnap, onResizeSnapEnd });

      queryZone(nodeEl, "e").dispatchEvent(
        createPointerEvent("pointerdown", { pointerId: 9, clientX: 100, clientY: 100 })
      );
      window.dispatchEvent(
        createPointerEvent("pointermove", {
          pointerId: 9,
          clientX: 140,
          clientY: 100,
          ctrlKey: true,
        })
      );

      expect(resolveResizeSnap).not.toHaveBeenCalled();
      // Guides from any earlier snapped frame are cleared as soon as the
      // bypass modifier goes down, not only on release.
      expect(onResizeSnapEnd).toHaveBeenCalled();
      expect(node.size?.width).toBe(340);

      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 9, clientX: 140, clientY: 100 })
      );
      expect(node.size?.width).toBe(340);
    });
  });
});
