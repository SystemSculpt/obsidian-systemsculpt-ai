/** @jest-environment jsdom */

import { imageGenerationNode } from "../../../studio/nodes/imageGenerationNode";
import type { StudioNodeInstance } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { renderStudioGraphNodeCard } from "../graph-v3/StudioGraphNodeCardRenderer";

it("opens the model catalog from the form card and refreshes dependent selections while keeping the prompt", async () => {
  const root = document.body.createDiv();
  const node: StudioNodeInstance = {
    id: "image", kind: "studio.image_generation", version: "1.0.0",
    title: "Image", position: { x: 0, y: 0 },
    config: { model: "old", imageSize: "4K", quality: "high", aspectRatio: "16:9", count: 4 },
  };
  let teardown: (() => void) | undefined;
  const handleChange = (SystemSculptStudioView.prototype as any).handleNodeConfigValueChange;
  const context = {
    currentProject: { graph: { nodes: [node] } },
    findNode: () => node,
    cloneJsonValue: (value: unknown) => value,
    commitCurrentProjectMutation: (_reason: unknown, mutate: (project: unknown) => boolean) => mutate(context.currentProject),
    refreshNodeCardPreview: jest.fn(),
    render: () => {
      teardown?.();
      root.empty();
      renderStudioGraphNodeCard({
        layer: root, node, projectId: "image-settings-regression", busy: false, nodeDetailMode: "expanded",
        inboundEdges: [], nodeRunState: { status: "idle", message: "", updatedAt: null, outputs: null },
        graphInteraction: {
          isNodeSelected: () => false, registerNodeElement: jest.fn(), getGraphZoom: () => 1,
          registerPortElement: jest.fn(), isPendingConnectionSource: () => false,
        } as any,
        findNodeDefinition: () => imageGenerationNode, resolveAssetPreviewSrc: value => value,
        onRunNode: jest.fn(), onRemoveNode: jest.fn(), onNodeTitleInput: jest.fn(),
        onCopyTextGenerationPromptBundle: jest.fn(), onToggleTextGenerationOutputLock: jest.fn(),
        onNodeConfigMutated: jest.fn(), onNodeGeometryMutated: jest.fn(), onRevealPathInFinder: jest.fn(),
        onNodeSourceApply: jest.fn(), registerNodeTeardown: (_id, dispose) => { teardown = dispose; },
        onNodeConfigValueChange: (...args) => handleChange.call(context, ...args),
        resolveDynamicSelectOptions: async (source) => source === "image_models"
          ? [{ value: "old", label: "Old model" }, { value: "new", label: "New model", badge: "~9 credits/image" }]
          : [{ value: "", label: "Model default" }],
        // The model field opens the catalog modal; the host commits the chosen id back through the field.
        openMediaModelPicker: (_source, _node, _current, onValueChange) => { onValueChange("new", "New model"); },
      });
    },
  };
  const field = (key: string) => root.querySelector<HTMLElement>(`.ss-studio-node-inline-config-field--${key.toLowerCase()}`)!;
  const promptEl = () => root.querySelector<HTMLTextAreaElement>('.ss-studio-node-inline-config-field--prompt textarea')!;
  context.render();
  // The card is a form: no tabs, no source view, the prompt is a control on the card.
  expect(root.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(root.querySelector('.ss-studio-source-toolbar')).toBeNull();
  expect(root.querySelector('[data-testid="studio.source.edit.image"]')).toBeNull();
  expect(promptEl()).not.toBeNull();
  promptEl().value = "a lighthouse at dusk";
  promptEl().dispatchEvent(new Event("input", { bubbles: true }));
  expect(node.config.prompt).toBe("a lighthouse at dusk");
  expect(field("imageSize").textContent).toContain("4K");
  expect(field("count").querySelector<HTMLInputElement>("input")!.value).toBe("4");
  const trigger = () => field("model").querySelector<HTMLButtonElement>('[data-testid="studio.media-model-picker.trigger"]')!;
  expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
  expect(root.querySelectorAll('[role="listbox"]')).toHaveLength(3);
  trigger().click();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(trigger().textContent).toContain("New model");
  expect(trigger().textContent).toContain("~9 credits/image");
  expect(node.config).toMatchObject({ model: "new", imageSize: "", quality: "", aspectRatio: "", count: 1, prompt: "a lighthouse at dusk" });
  expect(field("count").querySelector<HTMLInputElement>("input")!.value).toBe("1");
  for (const [key, previous] of [["imageSize", "4K"], ["quality", "high"], ["aspectRatio", "16:9"]]) {
    expect(field(key).querySelector("button")!.textContent).not.toContain(previous);
  }
  // The prompt survives the model-driven re-render because it is committed on input.
  expect(promptEl().value).toBe("a lighthouse at dusk");
  teardown?.();
  root.remove();
});
