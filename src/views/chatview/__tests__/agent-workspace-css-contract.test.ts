import fs from "node:fs";
import path from "node:path";

const AGENT_WORKSPACE_CSS_MODULES = [
  "shell.css",
  "conversation.css",
  "activity.css",
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

  it("renders one compact Working timer with three quiet dots", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status\s*\{[^}]*min-height:\s*var\(--ss-control-height-sm\);[^}]*font-variant-numeric:\s*tabular-nums;[^}]*line-height:\s*20px;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-label\s*\{[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-icon\.is-animated\s*\{[^}]*width:\s*4px;[^}]*margin-inline:\s*7px;[^}]*animation:\s*ss-agent-working-dot 1\.2s var\(--ss-ease\) 200ms infinite;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-icon\.is-animated::before,\s*\.systemsculpt-agent-tail-status-icon\.is-animated::after\s*\{[^}]*animation:\s*ss-agent-working-dot 1\.2s var\(--ss-ease\) infinite;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-icon\.is-animated::after\s*\{[^}]*animation-delay:\s*400ms;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-tail-status-icon\.is-animated svg\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-workspace\.is-reduced-motion \*[\s\S]*animation-duration:\s*0\.01ms;/,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-reasoning-header\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*var\(--ss-control-height-sm\)/s,
    );
  });

  it("uses one compact closed Worked fold for completed turn activity", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /details\.systemsculpt-agent-activity\s*\{[^}]*font-size:\s*var\(--ss-text-sm\);[^}]*line-height:\s*20px;/s,
    );
    expect(css).toMatch(
      /summary\.systemsculpt-agent-activity-header,\s*button\.systemsculpt-agent-activity-overflow-header\s*\{[^}]*gap:\s*var\(--ss-space-1\);[^}]*min-height:\s*var\(--ss-control-height-sm\);[^}]*font-size:\s*var\(--ss-text-sm\);[^}]*line-height:\s*20px;[^}]*list-style:\s*none;/s,
    );
    expect(css).toMatch(
      /summary\.systemsculpt-agent-activity-header\s*\{[^}]*width:\s*100%;[^}]*border-bottom:\s*1px solid var\(--ss-line\);/s,
    );
    expect(css).toMatch(
      /strong\.systemsculpt-agent-activity-label,\s*strong\.systemsculpt-agent-activity-overflow-label\s*\{[^}]*font-weight:\s*400;/s,
    );
    expect(css).toMatch(
      /details\.systemsculpt-agent-activity:not\(\[open\]\)\s*>\s*\.systemsculpt-agent-activity-body\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).not.toContain(".systemsculpt-agent-activity-icon");
    expect(css).toMatch(
      /details\.systemsculpt-agent-activity\[open\][\s\S]*\.systemsculpt-agent-activity-disclosure[\s\S]*transform:\s*rotate\(90deg\);/,
    );
  });

  it("uses one summary drawer for each adjacent activity group", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-activity-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-activity-overflow-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-activity-overflow-body\s*\{[^}]*margin:\s*var\(--ss-space-0\) 0 var\(--ss-space-0\) var\(--ss-space-2\);[^}]*padding-left:\s*var\(--ss-space-1\);[^}]*border-left:\s*1px solid var\(--ss-line\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-activity-overflow-body\[hidden\]\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /button\.systemsculpt-agent-activity-overflow\s*\{[^}]*font-size:\s*var\(--ss-text-sm\);[^}]*line-height:\s*20px;/s,
    );
    expect(css).toMatch(
      /button\.systemsculpt-agent-activity-overflow-header\s*\{[^}]*gap:\s*6px;[^}]*padding:\s*0 var\(--ss-space-0\);[^}]*border:\s*0;[^}]*border-radius:\s*var\(--ss-radius-sm\);[^}]*justify-content:\s*flex-start;[^}]*text-align:\s*left;[^}]*appearance:\s*none;/s,
    );
    expect(css).toMatch(
      /button\.systemsculpt-agent-activity-overflow\[aria-expanded="true"\][\s\S]*\.systemsculpt-agent-activity-overflow-disclosure[\s\S]*transform:\s*rotate\(90deg\);/,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-activity-overflow-disclosure\s*\{[^}]*margin-left:\s*auto;/s,
    );
  });

  it("keeps reasoning and tool details compact, closed, and on one faint rail", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-reasoning-details:not\(\[open\]\)\s*>\s*\.systemsculpt-agent-reasoning-body\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-reasoning-body\s*\{[^}]*margin:\s*var\(--ss-space-0\) 0 var\(--ss-space-1\) var\(--ss-space-2\);[^}]*padding:\s*var\(--ss-space-0\) var\(--ss-space-3\) var\(--ss-space-0\) var\(--ss-space-2\);[^}]*border-left:\s*1px solid var\(--ss-line\);/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-tool-support\s*\{[^}]*margin:\s*var\(--ss-space-0\) 0 var\(--ss-space-1\) var\(--ss-space-2\);[^}]*padding-left:\s*var\(--ss-space-2\);[^}]*border-left:\s*1px solid var\(--ss-line\);[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(
      /details\.systemsculpt-agent-tool:not\(\[open\]\)\s*>\s*\.systemsculpt-agent-tool-support\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-tool-details\s*\{[^}]*font-family:\s*var\(--ss-font-mono\);[^}]*font-size:\s*var\(--ss-text-xs\);[^}]*user-select:\s*text;[^}]*white-space:\s*pre-wrap;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-tool-detail\s*\{[^}]*display:\s*block;/s,
    );
    expect(css).not.toContain(".systemsculpt-agent-reasoning-preview");
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-tool-copy\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-tool-controls\s*\{[^}]*flex:\s*0 0 auto;[^}]*margin-left:\s*auto;/s,
    );
    expect(css).not.toContain(".systemsculpt-agent-tool-state-icon.is-animated");
  });

  it("keeps completed tool rows neutral and reserves color for attention", () => {
    const css = readAgentWorkspaceCss();

    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-part\.is-tool\.is-succeeded \.systemsculpt-agent-tool-icon\s*\{[^}]*color:\s*var\(--ss-ink-faint\);/s,
    );
    expect(css).not.toContain(".systemsculpt-agent-tool-state {");
    expect(css).toMatch(
      /\.systemsculpt-agent-conversation \.systemsculpt-agent-part\.is-tool\.is-failed \.systemsculpt-agent-tool-state-icon,[\s\S]*color:\s*var\(--ss-danger\);/,
    );
    expect(css).toMatch(
      /\.systemsculpt-agent-activity-disclosure,[\s\S]*transition:[^}]*opacity var\(--ss-dur-fast\)[^}]*transform var\(--ss-dur-fast\)/,
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
    expect(css).toMatch(/\.systemsculpt-agent-viewport\s*\{[^}]*overflow-anchor:\s*none;/s);
    expect(css).toMatch(/\.systemsculpt-agent-viewport\s*\{[^}]*scrollbar-gutter:\s*stable both-edges;/s);
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
