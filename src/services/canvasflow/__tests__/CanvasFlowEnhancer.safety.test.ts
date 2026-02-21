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

  it("ignores mutations from lightweight node cards and inspector UI", () => {
    const nodeCard = document.createElement("div");
    nodeCard.className = "ss-canvasflow-node-card";
    const inspector = document.createElement("div");
    inspector.className = "ss-canvasflow-inspector";

    const cardMutation = {
      type: "childList",
      target: nodeCard,
      addedNodes: [],
      removedNodes: [],
    } as any as MutationRecord;
    const inspectorMutation = {
      type: "attributes",
      target: inspector,
      attributeName: "class",
      oldValue: "ss-canvasflow-inspector old",
    } as any as MutationRecord;

    expect(enhancer.shouldScheduleUpdateFromMutations([cardMutation])).toBe(false);
    expect(enhancer.shouldScheduleUpdateFromMutations([inspectorMutation])).toBe(false);
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

  it("marks pending when canvas node host is itself a markdown embed", () => {
    const root = document.createElement("div");
    const node = document.createElement("div");
    node.className = "canvas-node";
    const host = document.createElement("div");
    host.className = "canvas-node-content markdown-embed";
    node.appendChild(host);
    root.appendChild(node);

    enhancer.maskMarkdownEmbedNodes(root);

    expect(node.classList.contains("ss-canvasflow-prompt-node-pending")).toBe(true);
  });

  it("hides unsupported models from picker groups and exposes saved unsupported model as legacy chip", () => {
    enhancer.plugin.settings.imageGenerationModelCatalogCache = {
      models: [
        {
          id: "openai/gpt-5-image-mini",
          name: "OpenAI GPT-5 Image Mini",
          provider: "OpenAI",
          supports_generation: true,
          estimated_cost_per_image_usd: 0.02,
        },
        {
          id: "openrouter/legacy-image-model",
          name: "Legacy Image Model",
          provider: "OpenRouter",
          supports_generation: false,
          estimated_cost_per_image_usd: 0.05,
        },
      ],
    };

    const layout = enhancer.getInspectorModelButtonLayout({
      settingsModelSlug: "openai/gpt-5-image-mini",
      modelFromNote: "openrouter/legacy-image-model",
      selectedValue: "openrouter/legacy-image-model",
    });
    const renderedIds = layout.groups.flatMap((group: any) => group.models.map((model: any) => model.id));

    expect(renderedIds).toContain("openai/gpt-5-image-mini");
    expect(renderedIds).not.toContain("openrouter/legacy-image-model");
    expect(layout.legacyUnsupported?.id).toBe("openrouter/legacy-image-model");
  });

  it("does not expose a legacy chip when selected model is runnable", () => {
    enhancer.plugin.settings.imageGenerationModelCatalogCache = {
      models: [
        {
          id: "openai/gpt-5-image-mini",
          name: "OpenAI GPT-5 Image Mini",
          provider: "OpenAI",
          supports_generation: true,
          estimated_cost_per_image_usd: 0.02,
        },
      ],
    };

    const layout = enhancer.getInspectorModelButtonLayout({
      settingsModelSlug: "openai/gpt-5-image-mini",
      modelFromNote: "openai/gpt-5-image-mini",
      selectedValue: "openai/gpt-5-image-mini",
    });

    expect(layout.legacyUnsupported).toBeNull();
  });

  it("suppresses inspector rebind when unchanged or while interaction lock is active", () => {
    const inspector = {
      lastBoundFingerprint: "same",
      interactionLockUntilMs: 0,
    } as any;

    expect(enhancer.shouldRebindInspector(inspector, "same")).toBe(false);
    expect(enhancer.shouldRebindInspector(inspector, "next")).toBe(true);

    inspector.interactionLockUntilMs = Date.now() + 500;
    expect(enhancer.shouldRebindInspector(inspector, "another")).toBe(false);
  });
});
