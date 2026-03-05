/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import { renderNodePorts } from "../StudioGraphNodeCardSections";

function createNode(): StudioNodeInstance {
  return {
    id: "node_terminal",
    kind: "studio.terminal",
    version: "1.0.0",
    title: "Terminal",
    position: { x: 0, y: 0 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

function createDefinition(options: {
  inputPorts: StudioNodeDefinition["inputPorts"];
  outputPorts: StudioNodeDefinition["outputPorts"];
}): StudioNodeDefinition {
  return {
    kind: "studio.terminal",
    version: "1.0.0",
    capabilityClass: "local_io",
    cachePolicy: "never",
    inputPorts: options.inputPorts,
    outputPorts: options.outputPorts,
    configDefaults: {},
    configSchema: {
      fields: [],
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function createGraphInteractionStub() {
  return {
    registerPortElement: jest.fn(),
    isPendingConnectionSource: jest.fn(() => false),
    getPendingConnection: jest.fn(() => null),
    completeConnection: jest.fn(),
    startConnectionDrag: jest.fn(),
    consumeSuppressedOutputPortClick: jest.fn(() => false),
    beginConnection: jest.fn(),
  };
}

describe("StudioGraphNodeCardSections renderNodePorts", () => {
  it("does not render the ports section when both input and output ports are empty", () => {
    const graphInteraction = createGraphInteractionStub();
    const nodeEl = document.createElement("div");

    renderNodePorts({
      nodeEl,
      node: createNode(),
      definition: createDefinition({ inputPorts: [], outputPorts: [] }),
      graphInteraction: graphInteraction as any,
      interactionLocked: false,
    });

    expect(nodeEl.querySelector(".ss-studio-node-ports")).toBeNull();
    expect(graphInteraction.registerPortElement).not.toHaveBeenCalled();
  });

  it("renders only the populated port side without empty-state filler copy", () => {
    const graphInteraction = createGraphInteractionStub();
    const nodeEl = document.createElement("div");

    renderNodePorts({
      nodeEl,
      node: createNode(),
      definition: createDefinition({
        inputPorts: [],
        outputPorts: [{ id: "text", type: "text", required: false }],
      }),
      graphInteraction: graphInteraction as any,
      interactionLocked: false,
    });

    const portsEl = nodeEl.querySelector(".ss-studio-node-ports");
    expect(portsEl).not.toBeNull();
    expect(portsEl?.classList.contains("is-single-col")).toBe(true);
    expect(nodeEl.textContent).not.toContain("No inputs");
    expect(nodeEl.textContent).not.toContain("No outputs");
    expect(nodeEl.querySelectorAll(".ss-studio-node-ports-col")).toHaveLength(1);
    expect(graphInteraction.registerPortElement).toHaveBeenCalledWith(
      "node_terminal",
      "out",
      "text",
      expect.any(HTMLElement)
    );
  });
});
