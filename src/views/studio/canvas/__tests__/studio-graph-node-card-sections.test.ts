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

  it("delegates connections through two listeners regardless of port count", () => {
    const add = jest.spyOn(HTMLElement.prototype, "addEventListener");
    const graphInteraction = createGraphInteractionStub();
    const nodeEl = document.createElement("div");
    try {
      renderNodePorts({
        nodeEl, node: createNode(), interactionLocked: false,
        definition: createDefinition({
          inputPorts: Array.from({ length: 8 }, (_, index) => ({ id: `input-${index}`, type: "text", required: false })),
          outputPorts: Array.from({ length: 8 }, (_, index) => ({ id: `output-${index}`, type: "text", required: false })),
        }),
        graphInteraction: graphInteraction as any,
      });
      const portListeners = add.mock.calls.filter((_call, index) => add.mock.contexts[index].classList.contains("ss-studio-port-pin"));
      expect(portListeners).toHaveLength(0);
      const delegated = add.mock.calls.filter((_call, index) => add.mock.contexts[index].classList.contains("ss-studio-node-ports"));
      expect(delegated.map(call => call[0]).sort()).toEqual(["click", "pointerdown"]);
      const output = nodeEl.querySelector<HTMLButtonElement>('[data-port-id="output-7"]')!;
      const child = output.createSpan();
      child.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(graphInteraction.startConnectionDrag).toHaveBeenCalledWith("node_terminal", "output-7", expect.any(Event), output);
      child.click();
      expect(graphInteraction.beginConnection).toHaveBeenCalledWith("node_terminal", "output-7");
      graphInteraction.consumeSuppressedOutputPortClick.mockReturnValueOnce(true);
      child.click();
      expect(graphInteraction.beginConnection).toHaveBeenCalledTimes(1);
      const input = nodeEl.querySelector<HTMLButtonElement>('[data-port-id="input-6"]')!;
      graphInteraction.getPendingConnection.mockReturnValue({} as any);
      input.click();
      expect(graphInteraction.completeConnection).toHaveBeenCalledWith("node_terminal", "input-6");
      output.disabled = true;
      child.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(graphInteraction.beginConnection).toHaveBeenCalledTimes(1);
    } finally { add.mockRestore(); }
  });

  it("keeps delegated ports usable after their card moves into a pop-out document", () => {
    const graphInteraction = createGraphInteractionStub();
    const nodeEl = document.createElement("div");
    renderNodePorts({
      nodeEl, node: createNode(), interactionLocked: false,
      definition: createDefinition({ inputPorts: [{ id: "input", type: "text" }], outputPorts: [{ id: "output", type: "text" }] }),
      graphInteraction: graphInteraction as any,
    });
    const output = nodeEl.querySelector<HTMLButtonElement>('[data-port-id="output"]')!;
    const child = output.createSpan();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    try {
      frame.contentDocument!.body.appendChild(frame.contentDocument!.adoptNode(nodeEl));
      child.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      child.click();
      graphInteraction.getPendingConnection.mockReturnValue({} as any);
      nodeEl.querySelector<HTMLButtonElement>('[data-port-id="input"]')!.click();
      expect(graphInteraction.startConnectionDrag).toHaveBeenCalledWith("node_terminal", "output", expect.any(Event), output);
      expect(graphInteraction.beginConnection).toHaveBeenCalledWith("node_terminal", "output");
      expect(graphInteraction.completeConnection).toHaveBeenCalledWith("node_terminal", "input");
    } finally { frame.remove(); }
  });

  it("renders only the populated port side without empty-state filler copy", () => {
    const graphInteraction = createGraphInteractionStub();
    graphInteraction.isPendingConnectionSource.mockReturnValue(true);
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
    const outputPin = nodeEl.querySelector<HTMLButtonElement>(".ss-studio-port-pin.is-output");
    expect(outputPin?.type).toBe("button");
    expect(outputPin?.getAttribute("aria-label")).toBe("text output (text)");
    expect(outputPin?.getAttribute("aria-pressed")).toBe("true");
    expect(graphInteraction.registerPortElement).toHaveBeenCalledWith(
      "node_terminal",
      "out",
      "text",
      expect.any(HTMLElement)
    );
  });
});
