import {
  estimateStudioFillTextMeasure,
  layoutStudioFillText,
  studioFillTextBoxAt,
  studioFillTextDisplay,
  studioFillTextFont,
} from "../StudioFillText";

describe("fill text layout", () => {
  const measure = estimateStudioFillTextMeasure(0.5);

  it("fills the box: width limits a long line, height limits a short one", () => {
    const long = layoutStudioFillText(measure, { text: "a long caption line", style: "outline" }, 1000, 400);
    const short = layoutStudioFillText(measure, { text: "hi", style: "outline" }, 1000, 100);

    // 19 characters at half an em each, plus padding on both sides, across 1000px.
    expect(long.fontPx).toBeCloseTo(1000 / (9.5 + 0.28), 4);
    expect(short.fontPx).toBeCloseTo(100 / (1.12 + 0.14), 4);
  });

  it("breaks lines only where the author did, and shrinks to fit them all", () => {
    const one = layoutStudioFillText(measure, { text: "top", style: "meme" }, 4000, 300);
    const two = layoutStudioFillText(measure, { text: "top\ntext", style: "meme" }, 4000, 300);

    expect(two.lines).toEqual(["TOP", "TEXT"]);
    expect(two.fontPx).toBeLessThan(one.fontPx);
    expect(two.lines.length * two.lineHeightPx).toBeLessThanOrEqual(300);
  });

  it("gives the meme style capitals, Impact, and an outline", () => {
    const meme = layoutStudioFillText(measure, { text: "Hello", style: "meme" }, 800, 200);
    const shadow = layoutStudioFillText(measure, { text: "Hello", style: "shadow" }, 800, 200);

    expect(meme.lines).toEqual(["HELLO"]);
    expect(meme.font).toContain("Impact");
    expect(meme.strokePx).toBeGreaterThan(0);
    expect(shadow.lines).toEqual(["Hello"]);
    expect(shadow.strokePx).toBe(0);
  });

  it("sets plain canvas text in a quieter weight with no outline", () => {
    const plain = layoutStudioFillText(measure, { text: "Hello", style: "plain" }, 800, 200);

    expect(plain.lines).toEqual(["Hello"]);
    expect(plain.font).toMatch(/^600 /);
    expect(plain.strokePx).toBe(0);
    expect(studioFillTextFont("outline", 20)).toMatch(/^700 20px /);
    expect(studioFillTextDisplay("Hello", "plain")).toBe("Hello");
    expect(studioFillTextDisplay("Hello", "meme")).toBe("HELLO");
  });
});

describe("fill text in a font that changes shape with size", () => {
  // Like an optically sized font: wider at text sizes, settling by 32px.
  const measure = (font: string, text: string): number => {
    const sizePx = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]);
    const emPerCharacter = 0.5 + 0.1 * Math.max(0, Math.min(1, (32 - sizePx) / 18));
    return text.length * sizePx * emPerCharacter;
  };

  it("settles on a size at which the line still fits, measured at that size", () => {
    const text = "a line that lands well under display size";
    const layout = layoutStudioFillText(measure, { text, style: "plain" }, 320, 400);

    const needed = measure(layout.font, text) + layout.padPx * 2;
    expect(layout.fontPx).toBeLessThan(20);
    expect(needed).toBeLessThanOrEqual(320 + 0.05);
    // And it is not timid about it: the line fills the width it was given.
    expect(needed).toBeGreaterThan(319);
    // Scaling from a large reference size would have set it too big.
    expect(layout.fontPx).toBeLessThan(320 / (text.length * 0.5 + 0.24));
  });

  it("draws the box for a size from the width at that size", () => {
    const box = studioFillTextBoxAt(measure, { text: "label", style: "plain" }, 14);

    expect(box.width).toBeCloseTo((5 * 0.6 + 0.24) * 14, 6);
    expect(layoutStudioFillText(measure, { text: "label", style: "plain" }, box.width, box.height).fontPx)
      .toBeCloseTo(14, 1);
  });
});

describe("fill text box for a size", () => {
  const measure = estimateStudioFillTextMeasure(0.5);

  it("estimates a share of the font size for every character", () => {
    expect(measure("600 20px Inter", "abcd")).toBe(40);
    expect(estimateStudioFillTextMeasure(0.6)("100px Impact", "ab")).toBe(120);
  });

  it.each([
    ["plain", "Hello"],
    ["meme", "top text\nbottom"],
    ["banner", "a\nlonger second line\nc"],
  ] as const)("is the layout run backwards for %s text", (style, text) => {
    const box = studioFillTextBoxAt(measure, { text, style }, 24);
    const layout = layoutStudioFillText(measure, { text, style }, box.width, box.height);

    // Both sides are filled exactly: neither has room to spare at this size.
    expect(layout.fontPx).toBeCloseTo(24, 6);
    expect(layoutStudioFillText(measure, { text, style }, box.width - 1, box.height).fontPx).toBeLessThan(24);
    expect(layoutStudioFillText(measure, { text, style }, box.width, box.height - 1).fontPx).toBeLessThan(24);
  });
});
