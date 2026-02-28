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
    kind: "studio.http_request",
    version: "1.0.0",
    capabilityClass: "api",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [{ id: "status", type: "number" }],
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

function nodeFixture(): StudioNodeInstance {
  return {
    id: "node_http_request",
    kind: "studio.http_request",
    version: "1.0.0",
    title: "HTTP",
    position: { x: 0, y: 0 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

describe("HTTP inline binding summary", () => {
  it("renders connected input bindings for recognized HTTP input ports", () => {
    const nodeEl = document.createElement("div");

    renderStudioNodeInlineEditor({
      nodeEl,
      node: nodeFixture(),
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      inboundEdges: [
        { fromNodeId: "node_a", fromPortId: "json", toPortId: "body_json" },
        { fromNodeId: "node_b", fromPortId: "text", toPortId: "body_text" },
        { fromNodeId: "node_c", fromPortId: "json", toPortId: "query" },
        { fromNodeId: "node_d", fromPortId: "text", toPortId: "unknown_port" },
      ],
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const summary = nodeEl.querySelector(".ss-studio-node-http-bindings");
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toContain("CONNECTED INPUTS");
    expect(summary?.textContent).toContain("Body JSON");
    expect(summary?.textContent).toContain("Body Text");
    expect(summary?.textContent).toContain("Query Params");
    expect(summary?.textContent).toContain("node_a.json");
    expect(summary?.textContent).toContain("node_b.text");
    expect(summary?.textContent).toContain("node_c.json");
    expect(summary?.textContent).not.toContain("unknown_port");
  });

  it("shows an empty-state hint when no inbound bindings are connected", () => {
    const nodeEl = document.createElement("div");

    renderStudioNodeInlineEditor({
      nodeEl,
      node: nodeFixture(),
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      inboundEdges: [],
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const emptyState = nodeEl.querySelector(".ss-studio-node-http-bindings-empty");
    expect(emptyState).toBeTruthy();
    expect(emptyState?.textContent).toContain("None.");
  });
});
