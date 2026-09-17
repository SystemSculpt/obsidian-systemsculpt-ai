/** @jest-environment jsdom */
import { measureStudioTextGlyphExtent, resolveStudioTextAutoWidth } from "../StudioGraphTextNodeMeasure";

function stubRangeRects(byText: Record<string, Array<{ left: number; right: number; width: number }>>) {
  const original = document.createRange;
  document.createRange = () => {
    let text = "";
    return {
      selectNodeContents: (node: Node) => { text = String(node.textContent || ""); },
      getClientRects: () => (byText[text] || []) as unknown as DOMRectList,
    } as unknown as Range;
  };
  return () => { document.createRange = original; };
}

describe("measureStudioTextGlyphExtent", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("unions the glyph rects of every non-empty text node", () => {
    const root = document.body.createDiv();
    const p = root.createEl("p");
    p.appendText("holding a ");
    p.createEl("code", { text: "gpu" });
    p.appendText("   ");
    const restore = stubRangeRects({
      "holding a ": [{ left: 100, right: 160, width: 60 }],
      gpu: [{ left: 160, right: 190, width: 30 }],
    });
    try {
      expect(measureStudioTextGlyphExtent(root)).toEqual({ left: 100, right: 190, width: 90 });
    } finally {
      restore();
    }
  });

  it("returns null when nothing is laid out", () => {
    const root = document.body.createDiv();
    root.createEl("p", { text: "unmeasured" });
    const restore = stubRangeRects({});
    try {
      expect(measureStudioTextGlyphExtent(root)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("resolveStudioTextAutoWidth", () => {
  it("hugs the ink in world px with padding, borders, and one px of slack", () => {
    expect(resolveStudioTextAutoWidth({ glyphWidth: 300, zoom: 1, paddingInline: 16, borderInline: 2, minWidth: 24, maxWidth: 720 })).toBe(319);
    expect(resolveStudioTextAutoWidth({ glyphWidth: 150, zoom: 0.5, paddingInline: 16, borderInline: 2, minWidth: 24, maxWidth: 720 })).toBe(319);
  });

  it("clamps to the auto bounds and survives a bad zoom", () => {
    expect(resolveStudioTextAutoWidth({ glyphWidth: 5000, zoom: 1, paddingInline: 16, borderInline: 2, minWidth: 24, maxWidth: 720 })).toBe(720);
    expect(resolveStudioTextAutoWidth({ glyphWidth: 0, zoom: 0, paddingInline: 16, borderInline: 2, minWidth: 24, maxWidth: 720 })).toBe(24);
  });
});
