import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readStudioCss(): string {
  return readFileSync(resolve(process.cwd(), "src/css/views/studio/groups.css"), "utf8");
}

function readRuleBody(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  return match?.groups?.body ?? "";
}

describe("Studio group CSS contract", () => {
  it("renders the group accent on the RESTING frame, not only the drop-target state", () => {
    // Regression guard: the frame once hardcoded a gray dashed border and
    // consumed --ss-studio-group-accent only in .is-drop-target, so picking
    // a group color changed nothing but the 14px picker chip.
    const css = readStudioCss();
    const restingFrameRule = readRuleBody(
      css,
      /\.ss-studio-group-frame\s*\{(?<body>[^}]*)\}/s
    );

    expect(restingFrameRule).toMatch(
      /border:[^;]*var\(--ss-studio-group-accent\)[^;]*;/
    );
    expect(restingFrameRule).toMatch(
      /background-color:[^;]*var\(--ss-studio-group-accent\)[^;]*;/
    );
  });

  it("keeps swatch/tag button styling at two-class specificity to beat Obsidian's button rule", () => {
    // Obsidian's app stylesheet ships `button:not(.clickable-icon)` at
    // (0,1,1) specificity, which silently overrides any single-class
    // background/box-shadow/color in plugin CSS. The color-picker swatches
    // rendered as gray pills because of exactly this. Every swatch rule must
    // stay scoped under .ss-studio-group-tag (0,2,0).
    const css = readStudioCss();

    const scopedSwatchRule = readRuleBody(
      css,
      /\.ss-studio-group-tag \.ss-studio-group-color-swatch\s*\{(?<body>[^}]*)\}/s
    );
    expect(scopedSwatchRule).toMatch(/background:[^;]*var\(--ss-studio-swatch-color\)?/);

    // No bare single-class swatch rule may reintroduce the losing selector.
    expect(css).not.toMatch(/(^|[^ \w-])\.ss-studio-group-color-swatch\s*\{/m);
  });
});
