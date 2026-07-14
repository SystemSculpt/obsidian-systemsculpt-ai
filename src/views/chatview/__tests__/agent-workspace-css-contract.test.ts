import fs from "node:fs";
import path from "node:path";

const AGENT_WORKSPACE_CSS_MODULES = [
  "shell.css",
  "conversation.css",
  "reasoning.css",
  "tools.css",
  "states.css",
  "composer.css",
];

function readAgentWorkspaceCss() {
  const basePath = path.resolve(process.cwd(), "src/css/views/agent-workspace");
  return AGENT_WORKSPACE_CSS_MODULES
    .map((file) => fs.readFileSync(path.join(basePath, file), "utf8"))
    .join("\n");
}

describe("agent workspace CSS contract", () => {
  it("keeps hidden controls hidden after Obsidian component styles apply", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-workspace\s+\[hidden\]\s*\{[^}]*display:\s*none;/s);
  });

  it("keeps completed tool calls to a compact disclosure row", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-tool-header\s*\{[^}]*min-height:\s*var\(--ss-control-height-sm\)/s);
    expect(css).toMatch(/\.systemsculpt-agent-tool-details-body\s*\{[^}]*margin:/s);
    expect(css).not.toMatch(/\.systemsculpt-agent-tool-header\s*\{[^}]*min-height:\s*var\(--ss-control-height-lg\)/s);
  });

  it("compacts only adjacent tool-only history turns", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-history\s*\{[^}]*gap:\s*0;/s);
    expect(css).toMatch(
      /\.systemsculpt-agent-history\s*>\s*\.systemsculpt-agent-turn\s*\+\s*\.systemsculpt-agent-turn\s*\{[^}]*margin-top:\s*var\(--ss-space-5\)/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-history\s*>\s*\.systemsculpt-agent-turn\.is-tool-only\s*\+\s*\.systemsculpt-agent-turn\.is-tool-only\s*\{[^}]*margin-top:\s*var\(--ss-space-1\)/s,
    );
    expect(css).toMatch(/\.systemsculpt-agent-active-run\s*\{[^}]*gap:\s*var\(--ss-space-5\)/s);
  });

  it("overlays the empty state without pushing the live conversation below the viewport", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-viewport\s*\{[^}]*position:\s*relative;/s);
    expect(css).toMatch(
      /\.systemsculpt-agent-empty\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(css).not.toMatch(/\.systemsculpt-agent-empty\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
  });

  it("adapts to the mounted Plugin surface instead of the application viewport", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/@container\s+ss-surface\s*\(max-width:\s*500px\)/);
    expect(css).toMatch(/@container\s+ss-surface\s*\(max-width:\s*360px\)/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*500px\)/);
    expect(css).toMatch(/\.systemsculpt-agent-empty\s*\{[^}]*z-index:\s*var\(--ss-z-raised\)/s);
    expect(css).not.toContain("--ss-z-base");
  });
});
