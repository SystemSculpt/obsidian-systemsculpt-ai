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

  it("keeps tool activity compact and removes raw transport disclosures", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-tool-header\s*\{[^}]*min-height:\s*var\(--ss-control-height-sm\)/s);
    expect(css).toMatch(/\.systemsculpt-agent-tool-support\s*\{[^}]*margin:/s);
    expect(css).not.toMatch(/\.systemsculpt-agent-tool-header\s*\{[^}]*min-height:\s*var\(--ss-control-height-lg\)/s);
    expect(css).not.toContain(".systemsculpt-agent-tool-details-body");
    expect(css).not.toContain(".systemsculpt-agent-tool-details-label");
  });

  it("keeps the ephemeral tail status compact and animation-safe", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status\s*\{[^}]*min-height:\s*var\(--ss-control-height-sm\)/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-label\s*\{[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(css).not.toContain(".systemsculpt-agent-activity");
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-icon\.is-animated svg[\s\S]*animation:\s*ss-spin 0\.9s linear infinite;/,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-workspace\.is-reduced-motion \*[\s\S]*animation-duration:\s*0\.01ms;/,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-reasoning-header\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*var\(--ss-control-height-sm\)/s,
    );
  });

  it("preserves whitespace only for the raw live-Markdown fallback", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-part\.is-text\.is-streaming\.is-live-markdown-fallback,\s*\.systemsculpt-agent-part\.is-reasoning\.is-streaming\s+\.systemsculpt-agent-reasoning-body\.is-live-markdown-fallback\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*pre-wrap;/s,
    );
    expect(css).not.toMatch(
      /\.systemsculpt-agent-part\.is-text\.is-streaming,\s*\.systemsculpt-agent-part\.is-reasoning\.is-streaming \.systemsculpt-agent-reasoning-body\s*\{/s,
    );
  });

  it("compacts adjacent tool-only history while keeping one stable live turn", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-history\s*\{[^}]*gap:\s*0;/s);
    expect(css).toMatch(
      /\.systemsculpt-agent-history\s*>\s*\.systemsculpt-agent-turn\s*\+\s*\.systemsculpt-agent-turn\s*\{[^}]*margin-top:\s*var\(--ss-space-5\)/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-history\s*>\s*\.systemsculpt-agent-turn\.is-tool-only\s*\+\s*\.systemsculpt-agent-turn\.is-tool-only\s*\{[^}]*margin-top:\s*var\(--ss-space-1\)/s,
    );
    expect(css).toMatch(/\.systemsculpt-agent-active-run\s*\{[^}]*gap:\s*0;/s);
    expect(css).toMatch(
      /\.systemsculpt-agent-turn\.is-assistant\s+\.systemsculpt-agent-turn-body\s*\{[^}]*gap:\s*var\(--ss-space-3\)/s,
    );
  });

  it("keeps the live-to-durable turn boundary visually stable", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(/\.systemsculpt-agent-conversation\s*\{[^}]*gap:\s*0;/s);
    expect(css).toMatch(
      /\.systemsculpt-agent-active-run:not\(:empty\)\s*\{[^}]*margin-top:\s*var\(--ss-space-5\)/s,
    );
  });

  it("containerizes code with a compact local copy-feedback control", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-conversation\s+\.systemsculpt-agent-code-block\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*auto;[^}]*border:\s*1px solid var\(--ss-line\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation\s+\.systemsculpt-agent-code-copy\s*\{[^}]*position:\s*absolute;[^}]*min-height:\s*var\(--ss-control-height-sm\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation\s+\.systemsculpt-agent-code-copy\.is-copied\s*\{[^}]*color:\s*var\(--ss-success\);/s,
    );
  });

  it("keeps response-copy feedback compact and motion-safe without layout shift", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-message-copy\s*\{[^}]*width:\s*var\(--ss-control-height\);[^}]*min-width:\s*var\(--ss-control-height\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-message-copy\.is-copied\s*\{[^}]*color:\s*var\(--ss-success\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-message-copy\.is-copy-failed\s*\{[^}]*color:\s*var\(--ss-danger\);/s,
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.systemsculpt-agent-message-copy\.is-copied/,
    );
  });

  it("keeps historical message editing stable and usable in narrow plugin panes", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-turn\.is-user\.is-editing\s*\{[^}]*width:\s*min\(100%, var\(--ss-agent-user-width\)\);[^}]*max-width:\s*100%;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-message-editor-input\s*\{[^}]*width:\s*100%;[^}]*resize:\s*vertical;/s,
    );
    expect(css).toMatch(
      /@container\s+ss-surface\s*\(max-width:\s*500px\)[\s\S]*\.systemsculpt-agent-message-editor-actions\s*\{[^}]*grid-template-columns:/s,
    );
  });

  it("keeps the composer textarea visually joined to its toolbar", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-prompt\s*>\s*\.systemsculpt-agent-prompt-input\s*\{[^}]*border:\s*0;[^}]*border-bottom:\s*0;[^}]*border-radius:\s*0;/s,
    );
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
