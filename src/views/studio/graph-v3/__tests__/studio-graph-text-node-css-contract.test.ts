import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readStudioCss(): string {
  return readFileSync(
    resolve(process.cwd(), "src/css/views/studio/text-nodes.css"),
    "utf8"
  );
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

  it("neutralizes the native embed frame while keeping its editor behavior", () => {
    const css = readStudioCss();
    const nativeSurfaceRule = readRuleBody(
      css,
      /\.ss-studio-text-node-live-editor\.markdown-embed\s*\{(?<body>[^}]*)\}/s
    );
    const nativeContentRule = readRuleBody(
      css,
      /\.ss-studio-text-node-live-editor\s*>\s*\.markdown-embed-content\s*\{(?<body>[^}]*)\}/s
    );

    expect(nativeSurfaceRule).toMatch(/background(?:-color)?:\s*transparent;/);
    expect(nativeSurfaceRule).toMatch(/border:\s*0;/);
    expect(nativeSurfaceRule).toMatch(/font-style:\s*inherit;/);
    expect(nativeContentRule).toMatch(/height:\s*auto;/);
  });

  it("lets rendered markdown flow as normal blocks instead of pre-wrap source", () => {
    const css = readStudioCss();
    const markdownDisplayRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s*\{(?<body>[^}]*)\}/s
    );

    expect(markdownDisplayRule).toMatch(/white-space:\s*normal;/);
  });

  it("forces every nested CodeMirror layer onto the text node font contract", () => {
    const css = readStudioCss();

    expect(css).toMatch(
      /\.ss-studio-text-node-live-editor \.markdown-source-view,[\s\S]*?\.cm-content\s*\{[\s\S]*?font-size:\s*var\(--ss-studio-text-node-font-size, inherit\)\s*!important;[\s\S]*?line-height:\s*var\(--ss-leading-base\)\s*!important;/
    );
  });

  it("contains note-editor gutters and native table overflow inside Studio", () => {
    const css = readStudioCss();
    const gutterRule = readRuleBody(
      css,
      /\.ss-studio-text-node-live-editor\s+\.cm-gutters\s*\{(?<body>[^}]*)\}/s
    );
    const tableRule = readRuleBody(
      css,
      /\.ss-studio-text-node-live-editor\.ss-studio-text-node-live-editor[\s\S]*?\.cm-table-widget\s*\{(?<body>[^}]*)\}/s
    );

    expect(gutterRule).toMatch(/display:\s*none\s*!important;/);
    expect(tableRule).toMatch(/width:\s*100%\s*!important;/);
    expect(tableRule).toMatch(/margin:\s*0\s*!important;/);
    expect(tableRule).toMatch(/contain:\s*layout style\s*!important;/);
    expect(tableRule).toMatch(/position:\s*relative\s*!important;/);
    expect(tableRule).toMatch(/z-index:\s*2;/);
    expect(tableRule).toMatch(/overflow:\s*visible\s*!important;/);
    expect(css).toMatch(
      /\.ss-studio-text-node-display\.is-markdown table,[\s\S]*?\.cm-table-widget table\s*\{[\s\S]*?border-collapse:\s*collapse;/
    );
    expect(css).toMatch(
      /\.ss-studio-text-node-display\.is-markdown th,[\s\S]*?\.is-markdown td\s*\{[\s\S]*?border:\s*var\(--table-border-width\) solid var\(--table-border-color\);/
    );
    expect(css).toMatch(
      /\.cm-table-widget th,[\s\S]*?\.cm-table-widget td\s*\{[\s\S]*?padding:\s*0\s*!important;[\s\S]*?border:\s*var\(--table-border-width\) solid var\(--table-border-color\)\s*!important;/
    );
    expect(css).toMatch(
      /\.table-cell-wrapper\s*\{[\s\S]*?padding:\s*var\(--ss-text-studio-table-cell-block\)[\s\S]*?var\(--ss-text-studio-table-cell-inline\)\s*!important;/
    );
    expect(css).toMatch(
      /\.is-markdown td\s*\{[\s\S]*?white-space:\s*var\(--table-white-space\);[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/
    );
    expect(css).toMatch(
      /\.cm-content\.cm-lineWrapping\s*\{[\s\S]*?overflow-wrap:\s*anywhere\s*!important;[\s\S]*?word-break:\s*break-word\s*!important;/
    );
    expect(css).toMatch(
      /\.table-col-btn\s*\{[\s\S]*?z-index:\s*2;[\s\S]*?pointer-events:\s*none;/
    );
    expect(css).toMatch(
      /\.cm-table-widget:is\(:hover, :focus-within, \.has-focus\)[\s\S]*?:is\(\.table-row-btn, \.table-col-btn\)/
    );
    expect(css).toMatch(
      /\.cm-table-widget:is\([\s\S]*?\)[\s\S]*?\{[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?pointer-events:\s*auto\s*!important;/
    );
    expect(css).not.toMatch(/\.table-row-btn\s*\{\s*height:\s*1em/);
    expect(css).not.toMatch(/\.table-col-btn\s*\{\s*width:\s*1em/);
  });

  it("reconciles multiline Markdown blocks with rendered-preview rhythm", () => {
    const css = readStudioCss();

    expect(css).toMatch(
      /\.cm-line:not\(\[class\*="HyperMD-"\]\):has\(> br:only-child\)/
    );
    expect(css).toMatch(/\.HyperMD-header\s*\+\s*\.cm-line:has/);
    expect(css).toMatch(/\.HyperMD-codeblock\s*\{[\s\S]*?line-height:\s*max\(/);
    expect(css).toMatch(/\.HyperMD-list-line\s*\{[\s\S]*?line-height:/);
    expect(css).toMatch(
      /\.HyperMD-list-line:not\(\.HyperMD-task-line\)\s*\{[\s\S]*?padding-block:\s*0/
    );
    expect(css).toMatch(/\.HyperMD-task-line\s*\{[\s\S]*?padding-top:\s*max\(/);
  });

  it("uses one scalable code-row model in preview and edit mode", () => {
    const css = readStudioCss();
    const previewCodeTypographyRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s+code\s*\{(?<body>[^}]*)\}/s
    );
    const previewCodeRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s+pre\s*\{(?<body>[\s\S]*?)\n\}/
    );
    const previewCodeContentRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s+pre\s*>\s*code\s*\{(?<body>[^}]*)\}/s
    );
    const previewInlineCodeRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s+:not\(pre\)\s*>\s*code\s*\{(?<body>[^}]*)\}/s
    );
    const previewCopyButtonRule = readRuleBody(
      css,
      /\.ss-studio-text-node-display\.is-markdown\s+pre\s*>\s*\.copy-code-button\s*\{(?<body>[^}]*)\}/s
    );

    expect(previewCodeRule).toMatch(/--ss-studio-text-node-code-row:\s*max\(/);
    expect(previewCodeRule).toMatch(
      /padding-block:\s*var\(--ss-studio-text-node-code-row\);/
    );
    expect(previewCodeRule).toMatch(
      /font-size:\s*var\(--ss-text-studio-code-size\);/
    );
    expect(previewCodeRule).toMatch(
      /padding-inline-start:\s*var\(--size-4-4\);/
    );
    expect(previewCodeRule).toMatch(
      /background-color:\s*var\(--code-background\);/
    );
    expect(previewCodeRule).toMatch(
      /border-radius:\s*var\(--ss-radius-studio-code\);/
    );
    expect(previewCodeRule).toMatch(
      /box-shadow:\s*var\(--ss-text-studio-code-ring\);/
    );
    expect(previewCodeTypographyRule).toMatch(
      /font-family:\s*var\(--font-monospace\);/
    );
    expect(previewInlineCodeRule).toMatch(/padding:\s*0\.15em 0\.3em;/);
    expect(previewInlineCodeRule).toMatch(
      /background-color:\s*var\(--code-background\);/
    );
    expect(previewInlineCodeRule).toMatch(
      /border:\s*var\(--code-border-width\) solid var\(--code-border-color\);/
    );
    expect(previewInlineCodeRule).toMatch(
      /border-radius:\s*var\(--ss-radius-studio-code\);/
    );
    expect(previewInlineCodeRule).toMatch(
      /-webkit-box-decoration-break:\s*clone;/
    );
    expect(previewInlineCodeRule).toMatch(
      /white-space:\s*break-spaces\s*!important;/
    );
    expect(previewInlineCodeRule).toMatch(/overflow-wrap:\s*anywhere\s*!important;/);
    expect(previewInlineCodeRule).toMatch(/word-break:\s*break-word\s*!important;/);
    expect(previewInlineCodeRule).not.toMatch(/white-space:\s*nowrap;/);
    expect(css).toMatch(
      /\.HyperMD-codeblock\s*\{[\s\S]*?padding-inline-start:\s*var\(--size-4-4\)\s*!important;/
    );
    expect(previewCodeContentRule).toMatch(/display:\s*block;/);
    expect(previewCodeContentRule).toMatch(/white-space:\s*inherit;/);
    expect(css).toMatch(/pre\s*>\s*\.copy-code-button\s*\{[\s\S]*?position:\s*absolute;/);
    expect(previewCopyButtonRule).toMatch(/padding:\s*6px 8px;/);
    expect(previewCopyButtonRule).toMatch(/height:\s*auto;/);
    expect(previewCopyButtonRule).toMatch(/background-color:\s*transparent;/);
    expect(previewCopyButtonRule).toMatch(/box-shadow:\s*none;/);
    expect(previewCopyButtonRule).toMatch(/color:\s*var\(--text-muted\);/);
    expect(previewCopyButtonRule).toMatch(/font-size:\s*var\(--ss-text-xs\);/);
    expect(previewCopyButtonRule).toMatch(/font-family:\s*var\(--font-interface\);/);
    expect(css).toMatch(
      /\.copy-code-button:hover\s*\{[\s\S]*?background-color:\s*var\(--background-modifier-hover\);/
    );
    expect(css).toMatch(
      /\.ss-mobile-layout \.ss-studio-text-node-display\.is-markdown pre > \.copy-code-button/
    );
    expect(css).toMatch(
      /--ss-text-studio-code-size:\s*var\(--code-size, 0\.875em\);/
    );
    expect(css).toMatch(
      /:not\(pre\)\s*>\s*code\s*\{[\s\S]*?--ss-text-studio-code-size/
    );
  });
});
