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

function definitionFixture(): StudioNodeDefinition {
  return {
    kind: "studio.json",
    version: "1.0.0",
    capabilityClass: "local_cpu",
    cachePolicy: "by_inputs",
    inputPorts: [],
    outputPorts: [{ id: "json", type: "json" }],
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

function nodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "node_json",
    kind: "studio.json",
    version: "1.0.0",
    title: "JSON",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectValue(element: HTMLSelectElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function findButtonByText(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === label
  );
}

describe("StudioGraphNodeInlineEditors JSON composer", () => {
  it("defaults to composer mode and updates config.value from rows", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();
    const onNodeConfigMutated = jest.fn();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated,
    });

    const addButton = findButtonByText(nodeEl, "Add Field");
    expect(addButton).toBeDefined();
    click(addButton!);

    const keyInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-key");
    const valueInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-value");
    expect(keyInput).toBeDefined();
    expect(valueInput).toBeDefined();

    typeValue(keyInput!, "subject");
    typeValue(valueInput!, "Stripe payout ready");

    expect(node.config.value).toEqual({
      subject: "Stripe payout ready",
    });
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("hydrates the editor from latest json output when config.value is unset", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: {
        status: "success",
        message: "",
        updatedAt: "2026-03-01T00:00:00Z",
        outputs: {
          json: {
            subject: "Generated payload",
            to: ["mike@example.com"],
          },
        },
      },
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const keyInputs = nodeEl.querySelectorAll<HTMLInputElement>(".ss-studio-node-json-row-key");
    expect(keyInputs.length).toBeGreaterThan(0);
    expect(Array.from(keyInputs).some((entry) => entry.value === "subject")).toBe(true);

    const rawEditor = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-json-raw-editor");
    expect(rawEditor).toBeDefined();
    expect(rawEditor?.value).toContain("Generated payload");

    const sourceBadge = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-source-badge");
    expect(sourceBadge?.textContent?.trim()).toBe("Runtime");
  });

  it("starts in raw mode when preference says raw and parses JSON input", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();
    const onNodeConfigMutated = jest.fn();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated,
      getJsonEditorPreferredMode: () => "raw",
    });

    const rawButton = findButtonByText(nodeEl, "Raw");
    const composerSurface = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-composer-surface");
    const rawEditor = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-json-raw-editor");

    expect(rawButton?.classList.contains("is-active")).toBe(true);
    expect(composerSurface?.classList.contains("is-hidden")).toBe(true);
    expect(rawEditor).toBeDefined();

    typeValue(rawEditor!, '{"to":"first@example.com","count":2}');

    expect(node.config.value).toEqual({
      to: "first@example.com",
      count: 2,
    });
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("calls mode preference callback when switching between Composer and Raw", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();
    const onModeChange = jest.fn();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      onJsonEditorPreferredModeChange: onModeChange,
    });

    const rawButton = findButtonByText(nodeEl, "Raw");
    const composerButton = findButtonByText(nodeEl, "Composer");
    expect(rawButton).toBeDefined();
    expect(composerButton).toBeDefined();

    click(rawButton!);
    click(composerButton!);

    expect(onModeChange).toHaveBeenNthCalledWith(1, "raw");
    expect(onModeChange).toHaveBeenNthCalledWith(2, "composer");
  });

  it("shows raw parse errors without mutating config", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      value: {
        from: "mike@systemsculpt.com",
      },
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      getJsonEditorPreferredMode: () => "raw",
    });

    const rawEditor = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-json-raw-editor");
    expect(rawEditor).toBeDefined();

    typeValue(rawEditor!, "{");

    const errorEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-raw-error");
    expect(errorEl?.classList.contains("is-hidden")).toBe(false);
    expect(node.config.value).toEqual({
      from: "mike@systemsculpt.com",
    });
  });

  it("lets composer reset non-object values back to an empty object", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      value: ["a", "b"],
    });
    const onNodeConfigMutated = jest.fn();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated,
    });

    expect(nodeEl.textContent).toContain("Composer supports top-level JSON objects only.");
    const resetButton = findButtonByText(nodeEl, "Reset to {}");
    expect(resetButton).toBeDefined();

    click(resetButton!);

    expect(node.config.value).toEqual({});
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("supports typed composer values through the row type affordance", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const addButton = findButtonByText(nodeEl, "Add Field");
    expect(addButton).toBeDefined();
    click(addButton!);

    const keyInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-key");
    const typeSelect = nodeEl.querySelector<HTMLSelectElement>(".ss-studio-node-json-row-type");
    const valueInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-value");
    expect(keyInput).toBeDefined();
    expect(typeSelect).toBeDefined();
    expect(valueInput).toBeDefined();

    typeValue(keyInput!, "count");
    typeValue(valueInput!, "5");
    selectValue(typeSelect!, "number");

    expect(node.config.value).toEqual({
      count: 5,
    });
  });

  it("supports HTML row type with source and sanitized preview", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      value: {
        html: "<p>Hello</p><script>alert(1)</script>",
      },
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const typeSelect = nodeEl.querySelector<HTMLSelectElement>(".ss-studio-node-json-row-type");
    expect(typeSelect?.value).toBe("html");

    const previewButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-json-row-html-mode-button")
    ).find((button) => button.textContent?.trim() === "Preview");
    expect(previewButton).toBeDefined();
    click(previewButton!);

    const iframe = nodeEl.querySelector<HTMLIFrameElement>(".ss-studio-node-json-row-html-preview-frame");
    expect(iframe).toBeDefined();
    expect(iframe?.getAttribute("srcdoc")).toContain("<p>Hello</p>");
    expect(iframe?.getAttribute("srcdoc")).not.toContain("<script");
  });

  it("shows inline key validation when duplicate keys are entered", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const addButton = findButtonByText(nodeEl, "Add Field");
    expect(addButton).toBeDefined();
    click(addButton!);
    click(addButton!);

    const keyInputs = nodeEl.querySelectorAll<HTMLInputElement>(".ss-studio-node-json-row-key");
    expect(keyInputs.length).toBe(2);
    typeValue(keyInputs[0], "to");
    typeValue(keyInputs[1], "to");

    const duplicateNotice = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-composer-duplicates");
    expect(duplicateNotice?.classList.contains("is-hidden")).toBe(false);
    expect(duplicateNotice?.textContent).toContain("Duplicate keys detected");
    expect(nodeEl.querySelectorAll(".ss-studio-node-json-row.is-key-invalid").length).toBeGreaterThanOrEqual(2);
  });

  it("applies quick email preset scaffolding", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const presetButton = findButtonByText(nodeEl, "Email Preset");
    expect(presetButton).toBeDefined();
    click(presetButton!);

    expect(node.config.value).toEqual({
      from: "",
      to: [],
      reply_to: "",
      subject: "",
      text: "",
      html: "",
    });
  });

  it("shows effective payload and source badge updates after config edits", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: {
        status: "success",
        message: "",
        updatedAt: "2026-03-01T00:00:00Z",
        outputs: {
          json: {
            subject: "Runtime payload",
          },
        },
      },
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      getJsonEditorPreferredMode: () => "raw",
    });

    const sourceBadge = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-source-badge");
    const effectiveEditor = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-json-effective-editor");
    const rawEditor = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-json-raw-editor");
    expect(sourceBadge?.textContent?.trim()).toBe("Runtime");
    expect(effectiveEditor?.value).toContain("Runtime payload");
    expect(rawEditor).toBeDefined();

    typeValue(rawEditor!, '{"subject":"Config payload"}');

    expect(sourceBadge?.textContent?.trim()).toBe("Config");
    expect(effectiveEditor?.value).toContain("Config payload");
  });

  it("collapses latest output preview by default and expands on demand", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      value: {
        from: "test@example.com",
      },
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const toggleButton = Array.from(
      nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-json-output-toggle")
    ).find((button) => button.textContent?.includes("Latest Output"));
    const outputBody = nodeEl.querySelector<HTMLElement>(".ss-studio-node-json-output-body");
    expect(toggleButton).toBeDefined();
    expect(outputBody?.classList.contains("is-hidden")).toBe(true);

    click(toggleButton!);
    expect(outputBody?.classList.contains("is-hidden")).toBe(false);
  });
});
