/** @jest-environment jsdom */

import { App, MarkdownRenderer } from "obsidian";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";
import { AgentWorkspace } from "../AgentWorkspace";

function snapshot(markdown: string): AgentConversationSnapshot {
  return {
    runId: "run", turnId: "user", status: "running", phase: "working", statusLabel: "Working", elapsedMs: 1000,
    messages: [{ id: "assistant", role: "assistant", partIds: ["text"] }],
    parts: [{ id: "text", kind: "text", messageId: "assistant", state: "streaming", markdown, order: 0 }],
  };
}

describe("chat leaf visibility", () => {
  let parent: HTMLElement;
  let workspace: AgentWorkspace;
  let listeners: Map<string, () => void>;
  let onHiddenApproval: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(MarkdownRenderer, "render");
    jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const app = new App();
    listeners = new Map();
    (app.workspace.on as jest.Mock).mockImplementation((name, callback) => {
      listeners.set(name, callback);
      return name;
    });
    parent = document.body.createDiv();
    onHiddenApproval = jest.fn();
    workspace = new AgentWorkspace(parent, {
      app, sourcePath: () => "", onSubmit: jest.fn(), onStop: jest.fn(), onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(), onApprove: jest.fn(), onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(), onNewChat: jest.fn(), onOpenHistory: jest.fn(),
      isApprovalVisible: () => parent.isShown(), onHiddenApproval,
    });
    workspace.load();
  });

  afterEach(() => {
    workspace.unload();
    document.body.replaceChildren();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const tick = () => jest.advanceTimersByTimeAsync(100);
  function shown(visible: boolean): void {
    parent.hidden = !visible;
    listeners.get("active-leaf-change")?.();
  }
  async function render(markdown: string): Promise<void> {
    const rendering = workspace.setAgentSnapshot(snapshot(markdown));
    await tick();
    await rendering;
  }

  it("does no stream DOM or markdown work in a hidden tab and catches up only to the latest snapshot", async () => {
    await render("Before hiding");
    shown(false);
    await tick();
    const before = workspace.renderer.element.innerHTML;
    const parses = (MarkdownRenderer.render as jest.Mock).mock.calls.length;
    const renderActive = jest.spyOn(workspace.renderer, "renderActive");
    const updates = ["hidden one", "hidden two", "latest hidden text"].map(text => workspace.setAgentSnapshot(snapshot(text)));
    await tick();
    await Promise.all(updates);
    expect(workspace.renderer.element.innerHTML).toBe(before);
    expect((MarkdownRenderer.render as jest.Mock).mock.calls).toHaveLength(parses);
    expect(renderActive).not.toHaveBeenCalled();
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("latest hidden text");
    expect(renderActive).toHaveBeenCalledTimes(1);
    expect(renderActive.mock.calls[0][0].parts).toEqual(snapshot("latest hidden text").parts);
  });

  it("cancels pending loading and announcement timers while hidden", async () => {
    workspace.setLoading(true);
    workspace.announce("Loading a saved chat");
    shown(false);
    const before = workspace.element.innerHTML;
    await jest.advanceTimersByTimeAsync(1000);
    expect(workspace.element.innerHTML).toBe(before);
    workspace.setLoading(false);
    shown(true);
    await tick();
    expect(workspace.element.querySelector(".systemsculpt-agent-loading")).toBeNull();
    expect(workspace.element.classList.contains("is-loading-chat")).toBe(false);
  });

  it("suspends the working timer while hidden and restarts it on show without a new event", async () => {
    await render("Still running");
    shown(false);
    await tick();
    const before = workspace.renderer.element.innerHTML;
    await jest.advanceTimersByTimeAsync(5000);
    expect(workspace.renderer.element.innerHTML).toBe(before);
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("Writing · 6s");
    await jest.advanceTimersByTimeAsync(2000);
    expect(workspace.renderer.element.textContent).toContain("Writing · 8s");
  });

  it("settles a completed hidden run without blocking persistence and displays it once on show", async () => {
    await render("Partial response");
    shown(false);
    const before = workspace.renderer.element.innerHTML;
    const settled = workspace.settleCompletedRun([
      { role: "user", message_id: "user", content: "Question" },
      { role: "assistant", message_id: "assistant", content: "Final answer" },
    ]);
    workspace.setRunPending(false);
    await tick();
    await settled;
    expect(workspace.renderer.element.innerHTML).toBe(before);
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("Final answer");
    expect(workspace.renderer.element.textContent).not.toContain("Partial response");
    expect(workspace.renderer.element.querySelectorAll(".systemsculpt-agent-turn.is-assistant")).toHaveLength(1);
  });

  it("drops a queued visible frame when hidden before the frame runs", async () => {
    await render("Before queued frame");
    const rendering = workspace.setAgentSnapshot(snapshot("Queued then hidden"));
    shown(false);
    const before = workspace.renderer.element.innerHTML;
    await tick();
    await rendering;
    expect(workspace.renderer.element.innerHTML).toBe(before);
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("Queued then hidden");
  });

  it("keeps approval notices working without building hidden cards", async () => {
    shown(false);
    const pending: AgentConversationSnapshot = {
      ...snapshot(""),
      parts: [{ id: "tool", kind: "tool", messageId: "assistant", callId: "call", name: "write", location: "vault", input: { path: "Note.md", content: "hello" }, state: "approval-required", approvalId: "approve", order: 0 }],
    };
    const rendering = workspace.setAgentSnapshot(pending);
    await tick();
    await rendering;
    expect(onHiddenApproval).toHaveBeenCalledWith(pending.parts[0]);
    expect(workspace.renderer.element.querySelector(".systemsculpt-agent-approval")).toBeNull();
    shown(true);
    await tick();
    expect(workspace.renderer.element.querySelector(".systemsculpt-agent-approval")).not.toBeNull();
  });

  it("clears the working interval in its original window after the leaf moves", async () => {
    await render("Running in the main window");
    const clear = jest.spyOn(window, "clearInterval");
    const frame = document.body.createEl("iframe");
    frame.contentDocument!.body.appendChild(parent);
    shown(false);
    expect(clear).toHaveBeenCalledTimes(1);
    const before = workspace.renderer.element.innerHTML;
    await jest.advanceTimersByTimeAsync(2000);
    expect(workspace.renderer.element.innerHTML).toBe(before);
  });

  it("does not commit markdown that finishes parsing after the leaf hides", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    (MarkdownRenderer.render as jest.Mock).mockImplementationOnce(async (_app, markdown, staging) => {
      await gate;
      staging.setText(markdown);
    });
    const rendering = workspace.setAgentSnapshot(snapshot("Parsing before hide"));
    await tick();
    shown(false);
    const before = workspace.renderer.element.innerHTML;
    finish();
    await rendering;
    await workspace.setAgentSnapshot(snapshot("Latest while hidden"));
    await tick();
    expect(workspace.renderer.element.innerHTML).toBe(before);
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("Latest while hidden");
    expect(workspace.renderer.element.textContent).not.toContain("Parsing before hide");
  });

  it("catches up a failed hidden run with its retry surface and committed history", async () => {
    await render("Partial response");
    shown(false);
    const failed: AgentConversationSnapshot = {
      ...snapshot(""), status: "failed", phase: "failed",
      terminalError: { code: "connection_lost", message: "Connection lost" },
      parts: [{ id: "error", kind: "error", error: { code: "connection_lost", message: "Connection lost" }, retryable: true, order: 1 }],
    };
    await workspace.setAgentSnapshot(failed);
    await workspace.settleUnfinishedRun([
      { role: "user", message_id: "user", content: "Question" },
      { role: "assistant", message_id: "assistant", content: "Partial response" },
    ]);
    workspace.setRunPending(false);
    shown(true);
    await tick();
    expect(workspace.renderer.element.textContent).toContain("Partial response");
    expect(workspace.renderer.element.querySelector(".systemsculpt-agent-active-run")?.textContent).toContain("Retry this message to continue.");
  });

  it("does not stop a shown split pane when another leaf or window takes focus", async () => {
    window.dispatchEvent(new Event("blur"));
    listeners.get("active-leaf-change")?.();
    await render("Visible split pane");
    expect(workspace.renderer.element.textContent).toContain("Visible split pane");
  });
});
