import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readStudioCss(): string {
  return readFileSync(resolve(process.cwd(), "src/css/views/studio.css"), "utf8");
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
});
