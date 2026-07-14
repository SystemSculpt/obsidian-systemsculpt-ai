import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STUDIO_CANVAS_MODULES = [
  "theme",
  "workspace",
  "connections",
  "node-chrome",
  "media-nodes",
  "node-runtime",
  "groups",
  "text-nodes",
  "menus",
] as const;

const STUDIO_EDITOR_MODULES = [
  "editor-preview",
  "editor-text",
  "editor-json",
  "editor-notes",
  "editor-dropdowns",
  "editor-media",
  "caption-board",
  "editor-responsive",
  "inline-config",
  "node-details",
] as const;

function readStudioModules(modules: readonly string[]): string {
  return modules
    .map((module) =>
      readFileSync(resolve(process.cwd(), `src/css/views/studio/${module}.css`), "utf8")
    )
    .join("\n");
}

function readStudioCss(): string {
  return readStudioModules(STUDIO_CANVAS_MODULES);
}

function readStudioEditorsCss(): string {
  return readStudioModules(STUDIO_EDITOR_MODULES);
}

function readRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "s").exec(css)?.groups?.body ?? "";
}

describe("Studio Plugin surface CSS contract", () => {
  it("adapts floating chrome to the leaf container with semantic theme colors", () => {
    const css = readStudioCss();
    const editorCss = readStudioEditorsCss();

    expect(css).toContain("@container ss-surface (max-width: 720px)");
    expect(css).toContain("@container ss-surface (max-width: 420px)");
    expect(editorCss).toContain("@container ss-surface (max-width: 1080px)");
    expect(editorCss).toContain("@container ss-surface (max-width: 640px)");
    expect(editorCss).not.toMatch(/@media\s*\(max-width:/);
    expect(css).not.toMatch(/color-mix\([^;\n]*(?:,\s*white|,\s*black)\b/);
    expect(css).toContain("var(--ss-ink-on-accent)");
  });

  it("keeps the graph coordinate origin and SVG layer tiers stable", () => {
    const css = readStudioCss();
    const canvasRule = /(?<!,\n)\.ss-studio-graph-canvas\s*\{(?<body>[^}]*)\}/s.exec(css)
      ?.groups?.body ?? "";

    expect(canvasRule).toMatch(/transform-origin:\s*0 0;/);
    expect(readRuleBody(css, ".ss-studio-groups-layer")).toMatch(/z-index:\s*0;/);
    expect(readRuleBody(css, ".ss-studio-edges-layer")).toMatch(/z-index:\s*1;/);
    expect(readRuleBody(css, ".ss-studio-nodes-layer")).toMatch(/z-index:\s*2;/);
    expect(readRuleBody(css, ".ss-studio-group-tags-layer")).toMatch(/z-index:\s*3;/);
  });

  it("uses the canonical selected-state grammar for ordinary Studio actions", () => {
    const css = `${readStudioCss()}\n${readStudioEditorsCss()}`;
    const actionSelectors = [
      ".ss-studio-node-lock-output",
      ".ss-studio-node-collapsed-visibility-button",
      ".ss-studio-node-text-display-mode-button",
      ".ss-studio-node-json-row-html-mode-button",
      ".ss-studio-node-json-output-toggle",
      ".ss-studio-caption-board__toggle",
      ".ss-studio-node-inline-config-select-button",
    ];

    for (const selector of actionSelectors) {
      expect(css).toContain(`${selector}.is-selected`);
      expect(css).not.toContain(`${selector}.is-active`);
    }
  });
});
