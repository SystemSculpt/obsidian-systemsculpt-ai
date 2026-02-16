import { JSDOM } from "jsdom";
import { CanvasFlowEnhancer } from "../CanvasFlowEnhancer";

describe("CanvasFlowEnhancer mutation filtering", () => {
  let dom: JSDOM;
  let enhancer: any;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;

    const app = {
      workspace: {
        on: jest.fn(() => ({ id: "event-ref" })),
        offref: jest.fn(),
        getLeavesOfType: jest.fn(() => []),
      },
    };
    const plugin = {
      settings: {
        canvasFlowEnabled: true,
        imageGenerationModelCatalogCache: null,
      },
      getSettingsManager: () => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };

    enhancer = new CanvasFlowEnhancer(app as any, plugin as any) as any;
  });

  it("ignores mutation records that only touch CanvasFlow-owned DOM", () => {
    const host = document.createElement("div");
    const controls = document.createElement("div");
    controls.className = "ss-canvasflow-controls";

    const ownedMutation = {
      type: "childList",
      target: host,
      addedNodes: [controls],
      removedNodes: [],
    } as any as MutationRecord;

    expect(enhancer.shouldScheduleUpdateFromMutations([ownedMutation])).toBe(false);
  });

  it("ignores non-canvas class mutations", () => {
    const unrelated = document.createElement("div");
    unrelated.className = "theme-dark";

    const unrelatedMutation = {
      type: "attributes",
      target: unrelated,
      attributeName: "class",
      oldValue: "theme-light",
    } as any as MutationRecord;

    expect(enhancer.shouldScheduleUpdateFromMutations([unrelatedMutation])).toBe(false);
  });

  it("schedules updates for canvas-node class mutations", () => {
    const canvasNode = document.createElement("div");
    canvasNode.className = "canvas-node is-selected";

    const selectionMutation = {
      type: "attributes",
      target: canvasNode,
      attributeName: "class",
      oldValue: "canvas-node",
    } as any as MutationRecord;

    expect(enhancer.shouldScheduleUpdateFromMutations([selectionMutation])).toBe(true);
  });

  it("schedules updates when canvas nodes are added to the DOM", () => {
    const canvasRoot = document.createElement("div");
    canvasRoot.className = "canvas-wrapper";
    const canvasNode = document.createElement("div");
    canvasNode.className = "canvas-node";

    const childMutation = {
      type: "childList",
      target: canvasRoot,
      addedNodes: [canvasNode],
      removedNodes: [],
    } as any as MutationRecord;

    expect(enhancer.shouldScheduleUpdateFromMutations([childMutation])).toBe(true);
  });
});
