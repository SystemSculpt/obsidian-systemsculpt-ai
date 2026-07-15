/**
 * @jest-environment jsdom
 */
import {
  MANAGED_OUTPUT_PENDING_KEY,
  MANAGED_TEXT_OWNER,
  MANAGED_TEXT_OWNER_KEY,
} from "../../../studio/StudioManagedOutputNodes";
import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import type { StudioGraphNodeMutationOptions } from "../graph-v3/StudioGraphNodeCardTypes";
import {
  StudioGraphSelectionResizeController,
  type StudioGraphSelectionResizePatchEntry,
} from "../StudioGraphSelectionResizeController";

/**
 * Multi-select resize frame: one selection bounds box with the shared 8-zone
 * affordances that scales the whole selection as a group — atomic multi-patch
 * commits, first-frame-only history capture, and clean aborts.
 */

function createNode(
  id: string,
  kind: string,
  position: { x: number; y: number },
  config: Record<string, unknown> = {}
): StudioNodeInstance {
  return {
    id,
    kind,
    version: "1.0.0",
    title: id,
    position: { ...position },
    config: { ...config },
    continueOnError: false,
    disabled: false,
  } as StudioNodeInstance;
}

function createProject(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    graph: { nodes, edges: [], groups: [] },
  } as unknown as StudioProjectV1;
}

function createNodeElement(size: { width: number; height: number }): HTMLElement {
  const el = document.body.createDiv({ cls: "ss-studio-node-card" });
  Object.defineProperty(el, "offsetWidth", { value: size.width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: size.height, configurable: true });
  return el;
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
  Object.defineProperty(event, "pointerId", { value: options.pointerId, configurable: true });
  return event as PointerEvent;
}

type CommitCall = {
  patches: StudioGraphSelectionResizePatchEntry[];
  options?: StudioGraphNodeMutationOptions;
};

type Harness = {
  controller: StudioGraphSelectionResizeController;
  canvas: HTMLElement;
  project: StudioProjectV1;
  elements: Map<string, HTMLElement>;
  commits: CommitCall[];
  history: StudioProjectV1[];
  selection: string[];
  setBusy: (busy: boolean) => void;
};

function cloneGeometry(project: StudioProjectV1): StudioProjectV1 {
  return JSON.parse(JSON.stringify(project)) as StudioProjectV1;
}

function createHarness(options: {
  nodes: Array<{ node: StudioNodeInstance; size: { width: number; height: number } }>;
  selection: string[];
  zoom?: number;
}): Harness {
  const project = createProject(options.nodes.map((entry) => entry.node));
  const elements = new Map<string, HTMLElement>();
  for (const entry of options.nodes) {
    elements.set(entry.node.id, createNodeElement(entry.size));
  }
  const commits: CommitCall[] = [];
  const history: StudioProjectV1[] = [];
  let busy = false;
  const harness: Partial<Harness> = { selection: [...options.selection] };
  const controller = new StudioGraphSelectionResizeController({
    isBusy: () => busy,
    getCurrentProject: () => project,
    getGraphZoom: () => options.zoom ?? 1,
    getSelectedNodeIds: () => harness.selection ?? [],
    getNodeElement: (nodeId) => elements.get(nodeId) ?? null,
    onSelectionResize: (patches, commitOptions) => {
      if (commitOptions?.captureHistory) {
        history.push(cloneGeometry(project));
      }
      // Mirrors the view sink: apply every patch inside ONE project mutation.
      for (const { nodeId, patch } of patches) {
        const target = project.graph.nodes.find((node) => node.id === nodeId);
        if (!target) {
          continue;
        }
        if (patch.size) {
          target.size = {
            width: patch.size.width ?? target.size?.width ?? 0,
            ...(patch.size.height !== undefined
              ? { height: patch.size.height }
              : target.size?.height !== undefined
                ? { height: target.size.height }
                : {}),
          };
        }
        if (patch.position) {
          target.position.x = patch.position.x;
          target.position.y = patch.position.y;
        }
        if (patch.fontSize !== undefined) {
          target.config.fontSize = patch.fontSize;
        }
      }
      commits.push({ patches, options: commitOptions });
    },
  });
  const canvas = document.body.createDiv({ cls: "ss-studio-graph-canvas" });
  controller.registerCanvasElement(canvas);
  Object.assign(harness, {
    controller,
    canvas,
    project,
    elements,
    commits,
    history,
    setBusy: (next: boolean) => {
      busy = next;
    },
  });
  return harness as Harness;
}

function createTwoNodeHarness(zoom = 1): Harness {
  return createHarness({
    nodes: [
      {
        node: createNode("terminal", "studio.terminal", { x: 100, y: 100 }),
        size: { width: 400, height: 400 },
      },
      {
        node: createNode("generic", "studio.http_request", { x: 700, y: 300 }),
        size: { width: 300, height: 200 },
      },
    ],
    selection: ["terminal", "generic"],
    zoom,
  });
}

function queryFrame(canvas: HTMLElement): HTMLElement {
  const frame = canvas.querySelector<HTMLElement>(".ss-studio-selection-resize-frame");
  if (!frame) {
    throw new Error("Expected selection resize frame");
  }
  return frame;
}

function queryZone(canvas: HTMLElement, zone: string): HTMLElement {
  const zoneEl = queryFrame(canvas).querySelector<HTMLElement>(
    `[data-resize-zone="${zone}"]`
  );
  if (!zoneEl) {
    throw new Error(`Expected selection resize zone ${zone}`);
  }
  return zoneEl;
}

function dragZone(
  canvas: HTMLElement,
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
  queryZone(canvas, zone).dispatchEvent(
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

describe("StudioGraphSelectionResizeController", () => {
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

  describe("frame visibility", () => {
    it("shows one bounds frame with the shared 8 zones when 2+ nodes are selected", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();

      const frame = queryFrame(harness.canvas);
      expect(frame.classList.contains("is-visible")).toBe(true);
      expect(frame.style.left).toBe("100px");
      expect(frame.style.top).toBe("100px");
      expect(frame.style.width).toBe("900px");
      expect(frame.style.height).toBe("400px");

      const zones = Array.from(
        frame.querySelectorAll<HTMLElement>(".ss-studio-selection-resize-zone")
      );
      expect(zones).toHaveLength(8);
      expect(new Set(zones.map((el) => el.dataset.resizeZone))).toEqual(
        new Set(["n", "s", "e", "w", "nw", "ne", "sw", "se"])
      );
      for (const zone of ["nw", "ne", "sw", "se"]) {
        expect(queryZone(harness.canvas, zone).classList.contains("is-corner")).toBe(true);
      }
      // Per-node resize affordances yield to the group frame via this class.
      expect(harness.canvas.classList.contains("is-multi-select-active")).toBe(true);
    });

    it("hides the frame for single selection and releases the per-node frames", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();
      expect(queryFrame(harness.canvas).classList.contains("is-visible")).toBe(true);

      harness.selection.splice(0, harness.selection.length, "terminal");
      harness.controller.refreshSelectionFrame();

      expect(queryFrame(harness.canvas).classList.contains("is-visible")).toBe(false);
      expect(harness.canvas.classList.contains("is-multi-select-active")).toBe(false);
    });

    it("hides the frame while the view is busy", () => {
      const harness = createTwoNodeHarness();
      harness.setBusy(true);
      harness.controller.refreshSelectionFrame();

      expect(queryFrame(harness.canvas).classList.contains("is-visible")).toBe(false);
      expect(harness.canvas.classList.contains("is-multi-select-active")).toBe(false);
    });
  });

  describe("group resize gesture", () => {
    it("commits one atomic multi-patch per flush and applies the transform to node DOM", () => {
      const harness = createTwoNodeHarness(2);
      harness.controller.refreshSelectionFrame();

      // zoom 2: pointer travel (180, 200) is canvas delta (90, 100).
      dragZone(harness.canvas, "se", { to: { x: 180, y: 200 }, release: false });

      expect(harness.commits).toHaveLength(1);
      const [first] = harness.commits;
      expect(first.options).toEqual(
        expect.objectContaining({ mode: "continuous", captureHistory: true })
      );
      expect(first.patches).toEqual([
        {
          nodeId: "terminal",
          patch: { size: { width: 440, height: 500 }, position: { x: 100, y: 100 } },
        },
        {
          nodeId: "generic",
          patch: { size: { width: 330, height: 250 }, position: { x: 760, y: 350 } },
        },
      ]);

      // DOM applied per node semantics: explicit height for the terminal,
      // min-height floor for the generic card, transform for positions.
      const terminalEl = harness.elements.get("terminal") as HTMLElement;
      const genericEl = harness.elements.get("generic") as HTMLElement;
      expect(terminalEl.style.width).toBe("440px");
      expect(terminalEl.style.height).toBe("500px");
      expect(genericEl.style.width).toBe("330px");
      expect(genericEl.style.minHeight).toBe("250px");
      expect(genericEl.style.transform).toBe("translate(760px, 350px)");

      // The frame tracks the live group bounds during the gesture.
      const frame = queryFrame(harness.canvas);
      expect(frame.style.width).toBe("990px");
      expect(frame.style.height).toBe("500px");

      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 7, clientX: 180, clientY: 200 })
      );
    });

    it("previews text scaling on the live Markdown editor during group resize", () => {
      const harness = createHarness({
        nodes: [
          {
            node: createNode("text", "studio.text", { x: 100, y: 100 }, { fontSize: 16 }),
            size: { width: 300, height: 200 },
          },
          {
            node: createNode("generic", "studio.http_request", { x: 500, y: 100 }),
            size: { width: 300, height: 200 },
          },
        ],
        selection: ["text", "generic"],
      });
      const liveEditor = harness.elements
        .get("text")!
        .createDiv({ cls: "ss-studio-text-node-live-editor" });
      harness.controller.refreshSelectionFrame();

      // Group height 200 -> 300, so the text font previews at 16 * 1.5.
      dragZone(harness.canvas, "s", { to: { x: 0, y: 100 }, release: false });

      expect(liveEditor.style.getPropertyValue("--ss-studio-text-node-font-size")).toBe(
        "24px"
      );
      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 7, clientX: 0, clientY: 100 })
      );
    });

    it("captures history on the first mutating frame only and commits discrete on release", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();

      queryZone(harness.canvas, "e").dispatchEvent(
        createPointerEvent("pointerdown", { pointerId: 5, clientX: 0, clientY: 0 })
      );
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 5, clientX: 45, clientY: 0 })
      );
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 5, clientX: 90, clientY: 0 })
      );
      // A repeated identical move must not produce an extra commit.
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 5, clientX: 90, clientY: 0 })
      );
      window.dispatchEvent(
        createPointerEvent("pointerup", { pointerId: 5, clientX: 90, clientY: 0 })
      );

      expect(harness.commits.map((call) => call.options)).toEqual([
        expect.objectContaining({ mode: "continuous", captureHistory: true }),
        expect.objectContaining({ mode: "continuous", captureHistory: false }),
        expect.objectContaining({ mode: "discrete", captureHistory: false }),
      ]);
      expect(harness.history).toHaveLength(1);
    });

    it("restores the whole pre-gesture layout from the single history checkpoint", () => {
      const harness = createTwoNodeHarness();
      const before = cloneGeometry(harness.project);
      harness.controller.refreshSelectionFrame();

      dragZone(harness.canvas, "se", { to: { x: 90, y: 100 } });

      expect(harness.project.graph.nodes[0].position).toEqual({ x: 100, y: 100 });
      expect(harness.project.graph.nodes[1].position).toEqual({ x: 760, y: 350 });
      expect(harness.history).toHaveLength(1);
      // One undo step: the single checkpoint IS the full pre-gesture layout.
      expect(harness.history[0].graph.nodes.map((node) => node.position)).toEqual(
        before.graph.nodes.map((node) => node.position)
      );
      expect(harness.history[0].graph.nodes.map((node) => node.size)).toEqual(
        before.graph.nodes.map((node) => node.size)
      );
    });

    it("keeps interaction-locked nodes inside the bounds but out of the transform", () => {
      const harness = createHarness({
        nodes: [
          {
            node: createNode("terminal", "studio.terminal", { x: 100, y: 100 }),
            size: { width: 400, height: 400 },
          },
          {
            node: createNode("generic", "studio.http_request", { x: 700, y: 300 }),
            size: { width: 300, height: 200 },
          },
          {
            node: createNode(
              "pending",
              "studio.text_output",
              { x: 1100, y: 100 },
              {
                [MANAGED_OUTPUT_PENDING_KEY]: true,
                [MANAGED_TEXT_OWNER_KEY]: MANAGED_TEXT_OWNER,
              }
            ),
            size: { width: 300, height: 200 },
          },
        ],
        selection: ["terminal", "generic", "pending"],
      });
      harness.controller.refreshSelectionFrame();

      // Bounds span all three nodes, including the locked placeholder.
      const frame = queryFrame(harness.canvas);
      expect(frame.style.width).toBe("1300px");

      dragZone(harness.canvas, "e", { to: { x: 130, y: 0 } });

      for (const call of harness.commits) {
        expect(call.patches.map((entry) => entry.nodeId)).toEqual(["terminal", "generic"]);
      }
      expect(harness.project.graph.nodes[2].position).toEqual({ x: 1100, y: 100 });
    });
  });

  describe("gesture teardown", () => {
    it("aborts on Escape: reverts DOM and commits the pre-gesture geometry", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();

      dragZone(harness.canvas, "se", { to: { x: 90, y: 100 }, release: false });
      expect(harness.commits).toHaveLength(1);

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      const last = harness.commits[harness.commits.length - 1];
      expect(last.options).toEqual(
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
      expect(last.patches).toEqual([
        {
          nodeId: "terminal",
          patch: { size: { width: 400, height: 400 }, position: { x: 100, y: 100 } },
        },
        {
          nodeId: "generic",
          patch: { size: { width: 300, height: 200 }, position: { x: 700, y: 300 } },
        },
      ]);
      const terminalEl = harness.elements.get("terminal") as HTMLElement;
      const genericEl = harness.elements.get("generic") as HTMLElement;
      expect(terminalEl.style.width).toBe("400px");
      expect(terminalEl.style.height).toBe("400px");
      expect(genericEl.style.transform).toBe("translate(700px, 300px)");
      expect(harness.project.graph.nodes[1].position).toEqual({ x: 700, y: 300 });

      // Frame is back at the pre-gesture bounds and stays visible.
      const frame = queryFrame(harness.canvas);
      expect(frame.style.width).toBe("900px");
      expect(frame.style.height).toBe("400px");

      // The gesture is fully torn down: further moves commit nothing.
      const commitCount = harness.commits.length;
      window.dispatchEvent(
        createPointerEvent("pointermove", { pointerId: 7, clientX: 400, clientY: 400 })
      );
      expect(harness.commits).toHaveLength(commitCount);
    });

    it("finalizes on pointercancel exactly like release", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();

      dragZone(harness.canvas, "e", { to: { x: 90, y: 0 }, release: false });
      window.dispatchEvent(
        createPointerEvent("pointercancel", { pointerId: 7, clientX: 90, clientY: 0 })
      );

      const last = harness.commits[harness.commits.length - 1];
      expect(last.options).toEqual(
        expect.objectContaining({ mode: "discrete", captureHistory: false })
      );
      expect(last.patches[0].patch.size?.width).toBe(440);
    });

    it("ignores drags when fewer than two nodes are selected", () => {
      const harness = createTwoNodeHarness();
      harness.controller.refreshSelectionFrame();
      harness.selection.splice(0, harness.selection.length, "terminal");

      dragZone(harness.canvas, "se", { to: { x: 90, y: 100 } });

      expect(harness.commits).toHaveLength(0);
    });
  });
});
