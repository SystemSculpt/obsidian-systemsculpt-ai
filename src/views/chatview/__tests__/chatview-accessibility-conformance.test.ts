/** @jest-environment jsdom */
import * as obsidian from "obsidian";
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, setTooltip: jest.fn(actual.setTooltip) };
});
import type { AgentConversationSnapshot, AgentToolPart } from "../../../chat/ChatConversation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { AgentWorkspace } from "../AgentWorkspace";
import { presentAgentConversation } from "../AgentConversationPresentation";

function tool(overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return { kind: "tool", id: "tool", callId: "call", messageId: "answer", order: 0,
    name: "read", input: { paths: ["Notes/Plan.md"] }, state: "running", location: "vault", ...overrides };
}
function snapshot(parts: AgentConversationSnapshot["parts"], status: AgentConversationSnapshot["status"] = "running"): AgentConversationSnapshot {
  return { runId: "run", turnId: "turn", elapsedMs: 2_000, status, messages: [], parts };
}
function setup() {
  const parent = document.body.createDiv();
  const onAnnounce = jest.fn();
  const renderer = new AgentConversationRenderer(parent, {
    app: new obsidian.App(), sourcePath: () => "", backendName: () => "Codex", onAnnounce,
    onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
    onCopyText: jest.fn(async () => true), onRetryMessage: jest.fn(), onRetryFailedTurn: jest.fn(),
  });
  renderer.load();
  const render = (value: AgentConversationSnapshot) => renderer.renderActive(value, presentAgentConversation(value, false));
  return { parent, renderer, render, onAnnounce };
}

// Spec §6.3: exercise the public renderer, including restored and live turns.
describe("ChatView conversation accessibility conformance", () => {
  afterEach(() => { document.body.empty(); jest.restoreAllMocks(); jest.useRealTimers(); });

  it("labels the non-live conversation and every saved/live article with a hidden h3", async () => {
    const ui = setup();
    try {
      await ui.renderer.renderHistory([
        { role: "user", message_id: "old-user", content: "Hello" },
        { role: "assistant", message_id: "old-answer", content: "Welcome" },
      ]);
      await ui.render(snapshot([{ kind: "text", id: "text", messageId: "answer", order: 0, markdown: "Working", state: "streaming" }]));
      expect(ui.renderer.element.getAttribute("role")).toBe("log");
      expect(ui.renderer.element.getAttribute("aria-label")).toBe("Conversation");
      expect(ui.renderer.element.getAttribute("aria-live")).toBe("off");
      const turns = [...ui.parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn")];
      expect(turns.length).toBeGreaterThanOrEqual(3);
      for (const turn of turns) {
        expect(turn.getAttribute("role")).toBe("article");
        const heading = document.getElementById(turn.getAttribute("aria-labelledby")!);
        expect(heading?.tagName).toBe("H3");
        expect(heading?.parentElement).toBe(turn);
        expect(heading?.classList.contains("systemsculpt-agent-sr-only")).toBe(true);
        expect(heading?.hasAttribute("hidden")).toBe(false);
        expect(heading?.hasAttribute("aria-hidden")).toBe(false);
        expect(heading?.textContent).toBe(turn.classList.contains("is-user") ? "You" : "Codex");
      }
      expect(new Set(turns.map(turn => turn.getAttribute("aria-labelledby"))).size).toBe(turns.length);
    } finally { ui.renderer.unload(); }
  });

  it.each([
    ["hosted", tool()],
    ["native", tool({ name: "Bash", input: { command: "pwd" }, native: { agent: "claude", workingDirectory: "/vault" } })],
  ])("keeps %s tool button controls and expansion synchronized", async (_backend, part) => {
    const ui = setup();
    try {
      await ui.render(snapshot([part]));
      const button = ui.parent.querySelector<HTMLElement>('[data-testid="chat.tool.toggle"]')!;
      const details = button.closest("details")!;
      const content = document.getElementById(button.getAttribute("aria-controls")!);
      expect(button.getAttribute("role")).toBe("button");
      expect(content?.closest("details")).toBe(details);
      for (const open of [true, false, true]) {
        details.open = open;
        details.dispatchEvent(new Event("toggle"));
        await Promise.resolve();
        expect(button.getAttribute("aria-expanded")).toBe(String(open));
        expect(document.getElementById(button.getAttribute("aria-controls")!)).toBe(content);
      }
    } finally { ui.renderer.unload(); }
  });

  it.each([
    ["hosted mutation", tool({ name: "write", input: { path: "Notes/Plan.md", content: "Ready" } })],
    ["native mutation", tool({ name: "Edit", input: { file_path: "/vault/Notes/Plan.md", old_string: "Draft", new_string: "Ready" }, native: { agent: "claude", workingDirectory: "/vault" } })],
    ["plan", tool({ name: "ExitPlanMode", input: { plan: "Update the note" }, native: { agent: "claude", workingDirectory: "/vault" } })],
    ["question", tool({ name: "request_user_input", input: { questions: [{ id: "scope", question: "Which notes?", options: [{ label: "All", description: "Every note" }] }] }, native: { agent: "codex", workingDirectory: "/vault" } })],
  ])("exposes the %s card title, metadata and keyboard hints", async (_kind, part) => {
    const ui = setup();
    try {
      await ui.render(snapshot([{ ...part, state: "approval-required", approvalId: "approval" }]));
      const card = ui.parent.querySelector<HTMLElement>(".systemsculpt-agent-approval")!;
      expect(card.getAttribute("role")).toBe("group");
      const title = document.getElementById(card.getAttribute("aria-labelledby")!);
      const meta = document.getElementById(card.getAttribute("aria-describedby")!);
      expect(title?.textContent).toBeTruthy();
      expect(card.contains(title)).toBe(true);
      expect(meta).not.toBeNull();
      expect(card.contains(meta)).toBe(true);
      for (const hint of card.querySelectorAll("kbd")) {
        expect(hint.getAttribute("aria-hidden")).toBe("true");
        expect(hint.closest("button")?.getAttribute("aria-keyshortcuts")).toBeTruthy();
      }
      expect(card.querySelector('[data-testid="chat.approval.allow-once"]')?.getAttribute("aria-keyshortcuts")).toContain("Enter");
      expect(card.querySelector('[data-testid="chat.approval.deny"]')?.getAttribute("aria-keyshortcuts")).toBe("Escape");
    } finally { ui.renderer.unload(); }
  });

  it("does not create a second polite live region for an incident report inside an alert", async () => {
    const ui = setup();
    try {
      await ui.render(snapshot([{ kind: "error", id: "error", order: 0, retryable: true,
        error: { code: "request_failed", message: "Failed", incidentId: `incident_${"a".repeat(32)}` } }], "failed"));
      expect(ui.parent.querySelector('[role="alert"]')).not.toBeNull();
      expect(ui.parent.querySelector(".systemsculpt-agent-error-report")).not.toBeNull();
      expect(ui.parent.querySelectorAll('[aria-live="polite"], [role="status"]:not([aria-live="off"])')).toHaveLength(0);
      ui.renderer.showCompletedRenderFallback();
      expect(ui.parent.querySelector(".systemsculpt-agent-render-fallback")?.getAttribute("role")).toBe("alert");
    } finally { ui.renderer.unload(); }
  });

  it("registers matching Obsidian tooltips for header, composer, attachment and queue icon actions", () => {
    const tooltip = jest.mocked(obsidian.setTooltip);
    tooltip.mockClear();
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new obsidian.App(), sourcePath: () => "", onSubmit: jest.fn(), onStop: jest.fn(), onAttach: jest.fn(),
      onMic: jest.fn(), onRemoveAttachment: jest.fn(), onApprove: jest.fn(), onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(), onNewChat: jest.fn(), onOpenHistory: jest.fn(), onCancelQueued: jest.fn(),
    });
    workspace.load();
    try {
      workspace.setInputText("Next step");
      workspace.setAttachments([{ id: "note", label: "Plan.md", path: "Notes/Plan.md", kind: "vault" }]);
      workspace.setQueue([{ id: "queued", text: "Next step", includeContextFiles: false }]);
      for (const running of [false, true]) {
        workspace.setRunPending(running);
        const buttons = [...parent.querySelectorAll<HTMLButtonElement>('[data-ss-action="icon"]')];
        expect(buttons.length).toBeGreaterThan(6);
        for (const button of buttons) {
          const name = button.getAttribute("aria-label");
          expect(name).toBeTruthy();
          expect(tooltip).toHaveBeenCalledWith(button, name);
          if (button.title) expect(button.title).toBe(name);
        }
      }
      expect(parent.querySelector('[data-testid="chat.composer.send"]')?.getAttribute("aria-keyshortcuts")).toBe("Enter Meta+Enter Control+Enter");
      expect(parent.querySelector('[data-testid="chat.composer.stop"]')?.getAttribute("aria-keyshortcuts")).toBe("Escape");
    } finally { workspace.unload(); }
  });

  it("keeps icon action names identical to Obsidian tooltips through timestamped copy feedback", async () => {
    jest.useFakeTimers();
    const tooltip = jest.mocked(obsidian.setTooltip);
    tooltip.mockClear();
    const ui = setup();
    try {
      await ui.renderer.renderHistory([{ role: "user", message_id: "old-user", content: "Hello",
        messageParts: [{ type: "content", id: "text", timestamp: 1_790_000_000_000, data: "Hello" }] }]);
      const buttons = ui.parent.querySelectorAll<HTMLButtonElement>('[data-ss-action="icon"]');
      expect(buttons.length).toBeGreaterThan(0);
      const expectTooltip = (button: HTMLButtonElement) => {
        expect(button.getAttribute("aria-label")).toBe(button.title);
        expect(tooltip).toHaveBeenCalledWith(button, button.getAttribute("aria-label"));
      };
      buttons.forEach(expectTooltip);
      const copy = ui.parent.querySelector<HTMLButtonElement>('[data-testid="chat.turn.copy"]')!;
      copy.click();
      await Promise.resolve(); await Promise.resolve();
      expect(copy.getAttribute("aria-label")).toBe("Message copied");
      expectTooltip(copy);
      jest.advanceTimersByTime(1_500);
      expect(copy.getAttribute("aria-label")).toMatch(/^Copy message/);
      expectTooltip(copy);
    } finally { ui.renderer.unload(); }
  });
});
