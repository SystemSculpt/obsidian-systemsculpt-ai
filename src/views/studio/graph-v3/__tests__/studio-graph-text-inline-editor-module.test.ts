/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import {
  isInlineTextNodeKind,
  renderTextNodeInlineEditor,
} from "../StudioGraphTextInlineEditor";

const IDLE_NODE_RUN_STATE: StudioNodeRunDisplayState = {
  status: "idle",
  message: "",
  updatedAt: null,
  outputs: null,
};

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

describe("StudioGraphTextInlineEditor module", () => {
  it("limits inline text support to text-like node kinds", () => {
    expect(isInlineTextNodeKind("studio.note")).toBe(true);
    expect(isInlineTextNodeKind("studio.text")).toBe(true);
    expect(isInlineTextNodeKind("studio.text_generation")).toBe(true);
    expect(isInlineTextNodeKind("studio.transcription")).toBe(true);
    expect(isInlineTextNodeKind("studio.json")).toBe(false);
  });

  it("returns false for non-text node kinds", () => {
    const rendered = renderTextNodeInlineEditor({
      nodeEl: document.createElement("div"),
      node: nodeFixture("studio.json"),
      nodeRunState: IDLE_NODE_RUN_STATE,
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    expect(rendered).toBe(false);
  });

  it("prefixes note preview blocks with path labels", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture("studio.note");
    const nodeRunState: StudioNodeRunDisplayState = {
      status: "succeeded",
      message: "Preview ready",
      updatedAt: "2026-01-01T00:00:00.000Z",
      outputs: {
        text: ["# One\nBody one", "# Two\nBody two"],
        path: ["Notes/One.md", "Notes/Two.md"],
      },
    };

    const rendered = renderTextNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState,
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const textarea = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-text-editor");
    expect(rendered).toBe(true);
    expect(textarea?.value).toContain("Path: Notes/One.md");
    expect(textarea?.value).toContain("Path: Notes/Two.md");
    expect(textarea?.value).toContain("---");
  });
});
