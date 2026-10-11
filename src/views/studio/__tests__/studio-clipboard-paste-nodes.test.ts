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

const PASSAGE = "A passage long enough that it has to wrap to be read, which a label never does.";

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

  describe("a label: a few short lines", () => {
    it("pastes as text that fills a box drawn around it", () => {
      const node = buildNode({ text: "hello world" });

      expect(node.config.layout).toBe("fill");
      // 11 characters at a generous 0.6em, plus the padding, set at 24px.
      expect(node.size).toEqual({
        width: Math.ceil((11 * 0.6 + 0.24) * 24),
        height: Math.ceil((1.12 + 0.12) * 24),
      });
    });

    it("grows the box by a line for every line pasted", () => {
      const one = buildNode({ text: "one" });
      const three = buildNode({ text: "one\ntwo\nthree" });

      expect(three.config.layout).toBe("fill");
      expect(three.size?.height).toBe(Math.ceil((3 * 1.12 + 0.12) * 24));
      expect(three.size?.height).toBeGreaterThan(one.size?.height ?? 0);
    });

    it("drops the blank lines and carriage returns a copy drags along", () => {
      const node = buildNode({ text: "\n\nfirst\r\nsecond\n\n" });

      expect(node.config.layout).toBe("fill");
      expect(node.config.value).toBe("first\nsecond");
    });
  });

  describe("a passage or Markdown", () => {
    it.each([
      ["a line too long to be a label", PASSAGE],
      ["more lines than a label has", "a\nb\nc\nd\ne\nf\ng"],
      ["a heading", "# Title"],
      ["a list", "- one\n- two"],
      ["a numbered list", "1. one\n2. two"],
      ["a quote", "> said"],
      ["a code fence", "```\ncode\n```"],
      ["a table", "| a | b |\n| - | - |"],
      ["nothing but whitespace", "  \n "],
    ])("stays a Markdown text card for %s", (_name, text) => {
      const node = buildNode({ text });

      expect(node.config.layout).toBeUndefined();
      expect(node.config.value).toBe(text);
      // Width only: a Markdown card's height comes from its content.
      expect(node.size).toEqual({ width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH });
      expect(node.config.width).toBeUndefined();
      expect(node.config.height).toBeUndefined();
    });

    it("stays width-only for large multi-line pastes", () => {
      const node = buildNode({
        text: Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"),
      });

      expect(node.size).toEqual({ width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH });
    });
  });

  it("keeps the remaining label config defaults intact", () => {
    const node = buildNode({ text: "styled" });

    expect(node.config.fontSize).toBe(textNode.configDefaults.fontSize);
  });
});
