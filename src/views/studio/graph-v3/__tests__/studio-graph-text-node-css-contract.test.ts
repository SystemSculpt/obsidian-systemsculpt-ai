import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readStudioCss(): string {
  return readFileSync(resolve(process.cwd(), "src/css/views/studio.css"), "utf8");
}

function readRuleBody(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  return match?.groups?.body ?? "";
}

describe("Studio text-node CSS contract", () => {
  it("keeps every text surface constrained by ONE shared box rule — display, textarea, and live editor", () => {
    const css = readStudioCss();
    const sharedTextSurfaceRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display,\s*\.ss-studio-text-node-editor,\s*\.ss-studio-text-node-live-editor\s*\{(?<body>[^}]*)\}/s
    );

    expect(sharedTextSurfaceRule).toMatch(/box-sizing:\s*border-box;/);
    expect(sharedTextSurfaceRule).toMatch(/max-width:\s*100%;/);
    expect(sharedTextSurfaceRule).toMatch(/min-width:\s*0;/);
    expect(sharedTextSurfaceRule).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(sharedTextSurfaceRule).toMatch(/word-break:\s*break-word;/);
    expect(sharedTextSurfaceRule).toMatch(
      /font-size:\s*var\(--ss-studio-text-node-font-size, inherit\);/
    );
  });

  it("keeps the live-editor-only rule down to its unique declarations", () => {
    const css = readStudioCss();
    // (?<!,\n) skips the shared rule, whose selector list ends with this
    // same class on a comma-continued line.
    const liveEditorRule = readRuleBody(
      css,
      /(?<!,\n)\.ss-studio-text-node-live-editor\s*\{(?<body>[^}]*)\}/s
    );

    expect(liveEditorRule).toMatch(/cursor:\s*text;/);
    // The box contract lives in the shared rule; a duplicate here would
    // silently drift from it.
    expect(liveEditorRule).not.toMatch(/box-sizing/);
    expect(liveEditorRule).not.toMatch(/max-width/);
  });

  it("lets rendered markdown flow as normal blocks instead of pre-wrap source", () => {
    const css = readStudioCss();
    const markdownDisplayRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s*\{(?<body>[^}]*)\}/s
    );

    expect(markdownDisplayRule).toMatch(/white-space:\s*normal;/);
  });
});
