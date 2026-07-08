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
  it("keeps long text constrained inside the text-node resize frame", () => {
    const css = readStudioCss();
    const sharedTextSurfaceRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display,\s*\.ss-studio-text-node-editor\s*\{(?<body>[^}]*)\}/s
    );

    expect(sharedTextSurfaceRule).toMatch(/box-sizing:\s*border-box;/);
    expect(sharedTextSurfaceRule).toMatch(/max-width:\s*100%;/);
    expect(sharedTextSurfaceRule).toMatch(/min-width:\s*0;/);
    expect(sharedTextSurfaceRule).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(sharedTextSurfaceRule).toMatch(/word-break:\s*break-word;/);
  });

  it("constrains the live-preview editor host inside the text-node frame", () => {
    const css = readStudioCss();
    const liveEditorRule = readRuleBody(
      css,
      /\.ss-studio-text-node-live-editor\s*\{(?<body>[^}]*)\}/s
    );

    expect(liveEditorRule).toMatch(/box-sizing:\s*border-box;/);
    expect(liveEditorRule).toMatch(/max-width:\s*100%;/);
    expect(liveEditorRule).toMatch(/min-width:\s*0;/);
    expect(liveEditorRule).toMatch(
      /font-size:\s*var\(--ss-studio-text-node-font-size, inherit\);/
    );
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
