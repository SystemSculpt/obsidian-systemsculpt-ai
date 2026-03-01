/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { renderStudioNodeInlineEditor } from "../StudioGraphNodeInlineEditors";

const IDLE_NODE_RUN_STATE: StudioNodeRunDisplayState = {
  status: "idle",
  message: "",
  updatedAt: null,
  outputs: null,
};

function definitionFixture(kind: string): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    capabilityClass: "local_cpu",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [{ id: "text", type: "text" }],
    configDefaults: {},
    configSchema: {
      fields: [],
      allowUnknownKeys: true,
    },
    async execute() {
      return {
        outputs: {},
      };
    },
  };
}

function nodeFixture(
  kind: string,
  config: StudioNodeInstance["config"] = {}
): StudioNodeInstance {
  return {
    id: `node_${kind.replace(/[^\w]+/g, "_")}`,
    kind,
    version: "1.0.0",
    title: "Node",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("StudioGraphNodeInlineEditors text display mode", () => {
  it("defaults to rendered mode when display mode is missing", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text", { value: "# Hello" });

    const rendered = renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    expect(rendered).toBe(true);
    const buttons = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    );
    const rawButton = buttons.find((button) => button.textContent?.trim() === "Raw");
    const renderedButton = buttons.find((button) => button.textContent?.trim() === "Rendered");
    const renderedPanel = nodeEl.querySelector<HTMLElement>(".ss-studio-node-text-rendered");
    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");

    expect(rawButton?.classList.contains("is-active")).toBe(false);
    expect(renderedButton?.classList.contains("is-active")).toBe(true);
    expect(renderedPanel?.classList.contains("is-hidden")).toBe(false);
    expect(textarea?.readOnly).toBe(true);
  });

  it("keeps note nodes in read-only raw mode and hides the display toggle", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.note", {
      notes: {
        items: [{ path: "Notes/Campaign.md", enabled: true }],
      },
    });
    const onNodeConfigMutated = jest.fn();
    const onNodePresentationMutated = jest.fn();
    const nodeRunState: StudioNodeRunDisplayState = {
      status: "succeeded",
      message: "Preview ready",
      updatedAt: "2026-01-01T00:00:00.000Z",
      outputs: { text: "# Hello" },
    };

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState,
      definition: definitionFixture("studio.note"),
      interactionLocked: false,
      onNodeConfigMutated,
      onNodePresentationMutated,
    });

    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");
    const modeToggle = nodeEl.querySelector<HTMLElement>(".ss-studio-node-text-display-mode");
    const buttons = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    );
    expect(textarea?.readOnly).toBe(true);
    expect(modeToggle?.classList.contains("is-hidden")).toBe(true);
    expect(buttons).toHaveLength(2);
    expect(node.config.textDisplayMode).toBeUndefined();
    expect(onNodePresentationMutated).not.toHaveBeenCalled();
    expect(onNodeConfigMutated).not.toHaveBeenCalled();
  });

  it("prefixes each note block with its path in the note preview text", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.note", {
      notes: {
        items: [
          { path: "Notes/One.md", enabled: true },
          { path: "Notes/Two.md", enabled: true },
        ],
      },
    });
    const nodeRunState: StudioNodeRunDisplayState = {
      status: "succeeded",
      message: "Preview ready",
      updatedAt: "2026-01-01T00:00:00.000Z",
      outputs: {
        text: ["# One\nBody one", "# Two\nBody two"],
        path: ["Notes/One.md", "Notes/Two.md"],
      },
    };

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState,
      definition: definitionFixture("studio.note"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");
    expect(textarea?.value).toContain("Path: Notes/One.md");
    expect(textarea?.value).toContain("Path: Notes/Two.md");
    expect(textarea?.value).toContain("---");
  });

  it("keeps rendered surface height aligned with the raw editor when toggled", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text", { value: "# Hello" });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      renderMarkdownPreview: jest.fn().mockResolvedValue(undefined),
    });

    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");
    const renderedPanel = nodeEl.querySelector<HTMLElement>(".ss-studio-node-text-rendered");
    const renderedButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    ).find((button) => button.textContent?.trim() === "Rendered");
    const rawButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    ).find((button) => button.textContent?.trim() === "Raw");

    expect(textarea).toBeDefined();
    expect(renderedPanel).toBeDefined();
    expect(rawButton).toBeDefined();
    expect(renderedButton).toBeDefined();

    const boundsSpy = jest.spyOn(textarea!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 320,
      height: 268,
      top: 0,
      right: 320,
      bottom: 268,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect);

    click(rawButton!);
    click(renderedButton!);

    expect(renderedPanel?.style.height).toBe("268px");
    boundsSpy.mockRestore();
  });

  it("lets rendered surface wheel events bubble to the graph container", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text", {
      value: "# Hello",
      textDisplayMode: "rendered",
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      renderMarkdownPreview: jest.fn().mockResolvedValue(undefined),
    });

    const containerWheelSpy = jest.fn();
    nodeEl.addEventListener("wheel", containerWheelSpy);
    const renderedPanel = nodeEl.querySelector<HTMLElement>(".ss-studio-node-text-rendered");

    expect(renderedPanel).toBeDefined();
    renderedPanel?.dispatchEvent(new Event("wheel", { bubbles: true }));

    expect(containerWheelSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps raw editor disabled for locked text-generation nodes while still rendering markdown preview", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text_generation", {
      value: "## Locked output",
      lockOutput: true,
      textDisplayMode: "rendered",
    });
    const renderMarkdownPreview = jest.fn().mockResolvedValue(undefined);

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text_generation"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      renderMarkdownPreview,
    });

    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");
    const renderedPanel = nodeEl.querySelector<HTMLElement>(".ss-studio-node-text-rendered");
    const rawButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    ).find((button) => button.textContent?.trim() === "Raw");

    expect(textarea?.readOnly).toBe(true);
    expect(renderedPanel?.classList.contains("is-hidden")).toBe(false);
    expect(rawButton?.classList.contains("is-active")).toBe(false);
    expect(renderMarkdownPreview).toHaveBeenCalledTimes(1);
  });

  it("treats invalid display mode values as rendered", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text", {
      value: "content",
      textDisplayMode: "unknown-mode",
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const rawButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    ).find((button) => button.textContent?.trim() === "Raw");
    const renderedButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-text-display-mode-button")
    ).find((button) => button.textContent?.trim() === "Rendered");

    expect(rawButton?.classList.contains("is-active")).toBe(false);
    expect(renderedButton?.classList.contains("is-active")).toBe(true);
  });
});
