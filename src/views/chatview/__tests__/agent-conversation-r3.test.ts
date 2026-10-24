/** @jest-environment jsdom */
import { App } from "obsidian";
import type { AgentConversationSnapshot, AgentToolPart } from "../../../chat/ChatConversation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation, presentAgentError } from "../AgentConversationPresentation";

function tool(overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return { kind: "tool", id: "tool-1", callId: "call-1", messageId: "answer", order: 0,
    name: "read", input: { paths: ["Notes/Plan.md"] }, state: "running", location: "vault", ...overrides };
}
function snapshot(parts: AgentConversationSnapshot["parts"], status: AgentConversationSnapshot["status"] = "running"): AgentConversationSnapshot {
  return { runId: "run", turnId: "turn", elapsedMs: 2_000, status, messages: [], parts };
}
function setup() {
  const onAnnounce = jest.fn();
  const onRetryFailedTurn = jest.fn();
  const onDetectAgain = jest.fn();
  const parent = document.body.createDiv();
  const renderer = new AgentConversationRenderer(parent, { app: new App(), sourcePath: () => "",
    backendName: () => "Claude Code", onAnnounce, onRetryFailedTurn, onDetectAgain,
    onUseHosted: jest.fn(), onOpenCredits: jest.fn(), onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(), onCopyText: jest.fn() });
  renderer.load();
  return { renderer, parent, onAnnounce, onRetryFailedTurn, onDetectAgain };
}
async function render(renderer: AgentConversationRenderer, value: AgentConversationSnapshot) {
  await renderer.renderActive(value, presentAgentConversation(value, false));
}

describe("R3 conversation semantics", () => {
  afterEach(() => { document.body.empty(); jest.useRealTimers(); jest.clearAllMocks(); });

  it("delays loading placeholders by 300ms and cancels fast loads", () => {
    jest.useFakeTimers();
    const { renderer, parent, onAnnounce } = setup();
    renderer.setLoading(true);
    jest.advanceTimersByTime(299);
    expect(parent.querySelector('[data-testid="chat.loading"]')).toBeNull();
    renderer.setLoading(false);
    jest.advanceTimersByTime(1);
    expect(onAnnounce).not.toHaveBeenCalled();
    renderer.setLoading(true);
    jest.advanceTimersByTime(300);
    expect(parent.querySelectorAll('.systemsculpt-agent-loading-bar')).toHaveLength(3);
    expect(onAnnounce).toHaveBeenCalledWith("Loading chat");
    renderer.unload();
    expect(parent.querySelector('[data-testid="chat.loading"]')).toBeNull();
  });

  it("labels articles without making the transcript a live region", async () => {
    const { renderer, parent } = setup();
    await renderer.renderHistory([{ role: "user", message_id: "turn", content: "Hello" },
      { role: "assistant", message_id: "answer", content: "Welcome" }]);
    expect(renderer.element.getAttribute("aria-live")).toBe("off");
    expect([...parent.querySelectorAll('[role="article"] > h3')].map(e => e.textContent)).toEqual(["You", "Claude Code"]);
    for (const article of parent.querySelectorAll('[role="article"]')) {
      expect(document.getElementById(article.getAttribute("aria-labelledby")!)?.parentElement).toBe(article);
    }
    renderer.unload();
  });

  it.each([
    ["fine", false, true],
    ["coarse", true, false],
  ])("draws action icons on reveal for %s pointers", async (_kind, coarse, deferred) => {
    const matchMedia = jest.fn(() => ({ matches: coarse }));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    try {
      const { renderer, parent } = setup();
      await renderer.renderHistory([{ role: "user", message_id: "turn", content: "Hello" },
        { role: "assistant", message_id: "answer", content: "Welcome" }]);
      const rows = [...parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn")];
      const icons = () => parent.querySelectorAll(".systemsculpt-agent-message-actions .ss-button__icon").length;
      const buttons = parent.querySelectorAll(".systemsculpt-agent-message-actions button").length;
      expect(buttons).toBeGreaterThan(0);
      expect(icons()).toBe(deferred ? 0 : buttons);
      // Every action keeps its accessible name before its icon is drawn.
      for (const button of parent.querySelectorAll(".systemsculpt-agent-message-actions button")) {
        expect(button.getAttribute("aria-label")).toBeTruthy();
      }
      rows[0].dispatchEvent(new Event("pointerover", { bubbles: true }));
      parent.querySelector<HTMLButtonElement>(".is-assistant .systemsculpt-agent-message-actions button")!
        .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(icons()).toBe(buttons);
      expect(parent.querySelector("[data-pending-icon], [data-pending-icons]")).toBeNull();
      renderer.unload();
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it("deduplicates a notice until another saved chat loads", () => {
    const { renderer, parent } = setup();
    renderer.showNotice("Auto is unavailable");
    parent.querySelector<HTMLButtonElement>('[data-testid="chat.notice.dismiss"]')!.click();
    renderer.showNotice("Auto is unavailable");
    expect(parent.querySelector('[data-testid="chat.notice"]')).toBeNull();
    renderer.setLoading(true);
    renderer.setLoading(false);
    renderer.showNotice("Auto is unavailable");
    expect(parent.querySelectorAll('[data-testid="chat.notice"]')).toHaveLength(1);
    renderer.unload();
  });

  it("announces one start and completion but never text deltas", async () => {
    const { renderer, onAnnounce } = setup();
    const first = snapshot([{ kind: "text", id: "text", messageId: "answer", order: 0, markdown: "Hello", state: "streaming" }]);
    await render(renderer, first);
    await render(renderer, { ...first, parts: [{ ...first.parts[0], kind: "text", messageId: "answer", markdown: "Hello again", state: "streaming" }] });
    await render(renderer, { ...first, status: "completed", parts: [{ ...first.parts[0], kind: "text", messageId: "answer", markdown: "Hello again", state: "complete" }] });
    expect(onAnnounce.mock.calls).toEqual([["Claude Code is working"], ["Claude Code replied"]]);
    renderer.unload();
  });

  it("offers retry for native failures even without a provider retry-message ID", async () => {
    const { renderer, parent, onRetryFailedTurn } = setup();
    await render(renderer, snapshot([{ kind: "error", id: "failed", order: 0, retryable: true,
      error: { code: "local_claude_failed", message: "synthetic diagnostic", retryable: true } }], "failed"));
    const retry = parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.retry-failed"]');
    expect(retry).not.toBeNull();
    retry!.click();
    expect(onRetryFailedTurn).toHaveBeenCalledWith("turn");
    const details = parent.querySelector('[data-testid="chat.turn.error-details"]')!.closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("synthetic diagnostic");
    renderer.unload();
  });

  it("keeps retry before detection in signed-out errors", async () => {
    const { renderer, parent } = setup();
    await render(renderer, snapshot([{ kind: "error", id: "signed-out", order: 0, retryable: true,
      error: { code: "local_codex_failed", message: "Not signed in" } }], "failed"));
    expect([...parent.querySelectorAll('.systemsculpt-agent-error-actions button')].map(button => button.textContent))
      .toEqual(["Retry", "Detect again"]);
    renderer.unload();
  });

  it("enables retry after detection confirms the missing agent is ready", async () => {
    const { renderer, parent, onDetectAgain, onRetryFailedTurn } = setup();
    onDetectAgain.mockResolvedValue(true);
    await render(renderer, snapshot([{ kind: "error", id: "missing", order: 0, retryable: true,
      error: { code: "local_claude_failed", message: "spawn ENOENT" } }], "failed"));
    const detect = parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.detect-again"]')!;
    detect.focus();
    detect.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(detect);
    expect(detect.dataset.testid).toBe("chat.turn.retry-failed");
    detect.click();
    expect(onRetryFailedTurn).toHaveBeenCalledWith("turn");
    expect(parent.querySelectorAll('.systemsculpt-agent-error-actions button')).toHaveLength(2);
    renderer.unload();
  });

  it("keeps receipt links and keyboard focus stable across terminal refreshes", async () => {
    const { renderer, parent } = setup();
    const completed = snapshot([tool({ name: "write", input: { path: "Notes/Plan.md", content: "Done" }, state: "succeeded" })], "completed");
    await render(renderer, completed);
    const link = parent.querySelector<HTMLAnchorElement>('[data-testid="chat.turn.change.open"]')!;
    expect(link).not.toBeNull();
    link.focus();
    await render(renderer, { ...completed, elapsedMs: 3_000 });
    expect(parent.querySelector('[data-testid="chat.turn.change.open"]')).toBe(link);
    expect(document.activeElement).toBe(link);
    renderer.unload();
  });

  it("includes a real stored timestamp in action tooltips without inventing one", async () => {
    const { renderer, parent } = setup();
    const timestamp = new Date("2026-10-23T14:14:00Z").getTime();
    await renderer.renderHistory([{ role: "assistant", message_id: "answer", content: "Welcome",
      messageParts: [{ type: "content", id: "text", timestamp, data: "Welcome" }] }]);
    const time = new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.copy"]')!.title).toBe(`Copy response · ${time}`);
    await renderer.renderHistory([{ role: "assistant", message_id: "untimed", content: "No timestamp" }]);
    expect(parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.copy"]')!.title).toBe("Copy response");
    renderer.unload();
  });

  it("shows the newest streaming activity even while an earlier tool is still active", async () => {
    const { renderer, parent } = setup();
    await render(renderer, snapshot([tool(), { kind: "text", id: "new-text", messageId: "answer", order: 1, state: "streaming", markdown: "Here is the result" }]));
    expect(parent.querySelector('.systemsculpt-agent-tail-status')!.textContent).toBe("Writing · 2s");
    renderer.unload();
  });

  it("keeps native approval waits spinner-free and timer-free", async () => {
    const { renderer, parent } = setup();
    const pending = tool({ name: "Bash", location: "server", input: { command: "pwd" }, state: "approval-required", approvalId: "approval",
      native: { agent: "claude", workingDirectory: "/synthetic" } });
    await render(renderer, snapshot([pending]));
    const status = parent.querySelector('.systemsculpt-agent-tail-status')!;
    expect(status.textContent).toBe("Waiting for your approval");
    expect(status.querySelector('.is-animated')).toBeNull();
    expect(status.hasAttribute('data-agent-working-timer')).toBe(false);
    renderer.unload();
  });

  it("hydrates readable hosted results only after opening the tool", async () => {
    const { renderer, parent } = setup();
    await render(renderer, snapshot([tool({ name: "list_items", input: { paths: ["Notes"] },
      output: { data: { results: [{ path: "Notes", directories: [], files: Array.from({ length: 55 }, (_, index) => ({ path: `Notes/${index}.md` })) }] } } })]));
    const shell = parent.querySelector<HTMLDetailsElement>('details.systemsculpt-agent-tool')!;
    expect(shell.querySelector('.ss-hosted-tool-preview')).toBeNull();
    shell.open = true; shell.dispatchEvent(new Event('toggle'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(shell.querySelectorAll('.ss-hosted-tool-list > li')).toHaveLength(50);
    expect(shell.querySelector('.systemsculpt-agent-tool-details')).toBeNull();
    shell.querySelector<HTMLButtonElement>('[data-testid="chat.tool.show-items"]')!.click();
    expect(shell.querySelectorAll('.ss-hosted-tool-list > li')).toHaveLength(55);
    expect(shell.querySelector('.systemsculpt-agent-tool-raw code')!.textContent).toBe("");
    renderer.unload();
  });

  it("keeps Details lazy and exposes a real keyboard disclosure", async () => {
    const { renderer, parent } = setup();
    await render(renderer, snapshot([tool({ name: "Bash", input: { command: "printf demo" }, native: { agent: "claude", workingDirectory: "/synthetic" } })]));
    const shell = parent.querySelector<HTMLDetailsElement>('details.systemsculpt-agent-tool')!;
    const summary = shell.querySelector('summary')!;
    expect(summary.getAttribute('role')).toBe('button');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(summary.getAttribute('aria-controls')!)).not.toBeNull();
    expect(shell.querySelector('.ss-native-tool-preview')).toBeNull();
    shell.open = true; shell.dispatchEvent(new Event('toggle'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(shell.textContent).toContain('printf demo');
    renderer.unload();
  });
});

describe("native friendly failures", () => {
  it.each([['claude', 'Claude Code'], ['codex', 'Codex']])("separates missing %s installation from diagnostics", (agent, name) => {
    expect(presentAgentError({ code: `local_${agent}_failed`, message: 'spawn ENOENT' }, true)).toMatchObject({
      heading: `${name} isn't installed on this computer`, action: 'detect',
    });
    expect(presentAgentError({ code: `local_${agent}_failed`, message: 'Not signed in' }, true)).toMatchObject({ action: 'sign-in' });
  });
});
