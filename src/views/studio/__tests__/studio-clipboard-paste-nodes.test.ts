/** @jest-environment jsdom */

import { textNode } from "../../../studio/nodes/textNode";
import type { StudioNodeInstance } from "../../../studio/types";
import { STUDIO_GRAPH_DEFAULT_NODE_WIDTH } from "../../../studio/StudioNodeGeometry";
import { cloneConfigDefaults, prettifyNodeKind } from "../StudioViewHelpers";
import { buildPastedTextNode } from "../systemsculpt-studio-view/StudioClipboardPasteNodes";

function buildNode(options: {
  text: string;
  position?: { x: number; y: number };
}): StudioNodeInstance {
  return buildPastedTextNode({
    textNodeDefinition: textNode,
    text: options.text,
    position: options.position ?? { x: 40, y: 60 },
    nextNodeId: () => "node_paste_1",
    prettifyNodeKind,
    cloneConfigDefaults,
    normalizeNodePosition: (position) => ({
      x: Math.round(position.x),
      y: Math.round(position.y),
    }),
  });
}

describe("buildPastedTextNode", () => {
  it("creates a studio.text node carrying the pasted text", () => {
    const node = buildNode({ text: "hello world", position: { x: 10.4, y: 20.6 } });

    expect(node.kind).toBe("studio.text");
    expect(node.id).toBe("node_paste_1");
    expect(node.title).toBe("Text");
    expect(node.config.value).toBe("hello world");
    expect(node.position).toEqual({ x: 10, y: 21 });
    expect(node.disabled).toBe(false);
    expect(node.continueOnError).toBe(false);
  });

  it("keeps the default text-node width and never persists a height", () => {
    const node = buildNode({ text: "one line" });

    expect(node.size?.width).toBe(STUDIO_GRAPH_DEFAULT_NODE_WIDTH);
    expect(node.size?.height).toBeUndefined();
    expect(node.config.width).toBeUndefined();
    expect(node.config.height).toBeUndefined();
  });

  it("stays width-only for large multi-line pastes", () => {
    const node = buildNode({
      text: Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"),
    });

    expect(node.size).toEqual({ width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH });
  });

  it("keeps the remaining label config defaults intact", () => {
    const node = buildNode({ text: "styled" });

    expect(node.config.fontSize).toBe(textNode.configDefaults.fontSize);
  });
});
