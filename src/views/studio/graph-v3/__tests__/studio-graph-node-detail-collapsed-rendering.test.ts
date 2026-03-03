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

function nodeFixture(kind: string, config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
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

function definitionFixture(kind: string): StudioNodeDefinition {
  if (kind === "studio.input") {
    return {
      kind,
      version: "1.0.0",
      capabilityClass: "local_cpu",
      cachePolicy: "never",
      inputPorts: [],
      outputPorts: [{ id: "value", type: "text" }],
      configDefaults: {},
      configSchema: {
        fields: [
          {
            key: "value",
            label: "Value",
            type: "text",
            description: "Helpful description",
          },
        ],
        allowUnknownKeys: true,
      },
      async execute() {
        return {
          outputs: {},
        };
      },
    };
  }

  if (kind === "studio.text_generation") {
    return {
      kind,
      version: "1.0.0",
      capabilityClass: "api",
      cachePolicy: "never",
      inputPorts: [],
      outputPorts: [{ id: "text", type: "text" }],
      configDefaults: {},
      configSchema: {
        fields: [
          {
            key: "sourceMode",
            label: "Source Mode",
            type: "select",
            selectPresentation: "button_group",
            options: [
              { value: "systemsculpt", label: "SystemSculpt" },
              { value: "local_pi", label: "Local" },
            ],
          },
          {
            key: "systemPrompt",
            label: "System Prompt",
            type: "textarea",
            description: "Prompt guidance",
          },
        ],
        allowUnknownKeys: true,
      },
      async execute() {
        return {
          outputs: {},
        };
      },
    };
  }

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

describe("Studio collapsed detail rendering", () => {
  it("hides inline text editor surface when text editor visibility is disabled", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text", { value: "hello" });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      showTextEditor: false,
    });

    expect(nodeEl.querySelector(".ss-studio-node-text-editor-wrap")).toBeNull();
  });

  it("hides system prompt field when collapsed visibility disables it", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.text_generation", {
      sourceMode: "systemsculpt",
      systemPrompt: "be concise",
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.text_generation"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      showSystemPromptField: false,
    });

    expect(nodeEl.textContent).not.toContain("SYSTEM PROMPT");
  });

  it("hides field help copy when field help visibility is disabled", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.input", { value: "seed" });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.input"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      showFieldHelp: false,
    });

    expect(nodeEl.textContent).not.toContain("Helpful description");
  });

  it("hides value output preview when output preview visibility is disabled", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.value", {});

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: {
        ...IDLE_NODE_RUN_STATE,
        outputs: {
          value: {
            key: "value",
          },
        },
      },
      definition: definitionFixture("studio.value"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      showOutputPreview: false,
    });

    expect(nodeEl.querySelector(".ss-studio-node-inline-output-preview")).toBeNull();
  });
});
