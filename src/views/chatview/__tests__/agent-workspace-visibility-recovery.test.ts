/** @jest-environment jsdom */
import { App, MarkdownRenderer, TFile } from "obsidian";
import { AgentWorkspace } from "../AgentWorkspace";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(markdown: string): AgentConversationSnapshot {
  return {
    runId: "run", turnId: "user", status: "running", phase: "working", elapsedMs: 1000,
    messages: [{ id: "assistant", role: "assistant", partIds: ["text"] }],
    parts: [{ id: "text", kind: "text", messageId: "assistant", state: "streaming", markdown, order: 0 }],
  };
}

describe("chat visibility recovery", () => {
  let app: App;
  let parent: HTMLElement;
  let workspace: AgentWorkspace;
  let listeners: Map<string, () => void>;
  let migrations: Set<() => void>;
  let onHiddenApproval: jest.Mock;
  const originalMigration = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onWindowMigrated");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(MarkdownRenderer, "render");
    jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    migrations = new Set();
    Object.defineProperty(HTMLElement.prototype, "onWindowMigrated", {
      configurable: true,
      value: function(this: HTMLElement, callback: (owner: Window) => void) {
        const migrate = () => callback(this.ownerDocument.defaultView!);
        migrations.add(migrate);
        return () => migrations.delete(migrate);
      },
    });
    listeners = new Map();
    app = new App();
    (app.workspace.on as jest.Mock).mockImplementation((name, callback) => {
      listeners.set(name, callback);
      return name;
    });
    parent = document.body.createDiv();
    onHiddenApproval = jest.fn();
  });

  function mount(extra = {}): void {
    workspace = new AgentWorkspace(parent, {
      app, sourcePath: () => "", onSubmit: jest.fn(), onStop: jest.fn(), onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(), onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(), onOpenHistory: jest.fn(), isApprovalVisible: () => parent.isShown(), onHiddenApproval, ...extra,
    });
    workspace.load();
  }

  afterEach(() => {
    workspace?.unload();
    document.body.replaceChildren();
    if (originalMigration) Object.defineProperty(HTMLElement.prototype, "onWindowMigrated", originalMigration);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).onWindowMigrated;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function shown(visible: boolean): void {
    parent.hidden = !visible;
    listeners.get("active-leaf-change")?.();
  }
  async function tick(): Promise<void> { await jest.advanceTimersByTimeAsync(100); }
  async function render(value: AgentConversationSnapshot): Promise<void> {
    const rendering = workspace.setAgentSnapshot(value);
    await tick();
    await rendering;
  }

  it("mounts hidden without parsing snapshots and shows only the newest", async () => {
    parent.hidden = true;
    mount();
    await workspace.setAgentSnapshot(snapshot("initial-hidden"));
    expect(MarkdownRenderer.render).not.toHaveBeenCalled();
    shown(true);
    await tick();
    expect(parent.textContent).toContain("initial-hidden");
  });

  it("notifies for native non-vault approvals while hidden and builds cards on show", async () => {
    mount();
    shown(false);
    const pending: AgentConversationSnapshot = {
      ...snapshot(""), status: "waiting", phase: "waiting", waitingReason: "approval",
      parts: [{
        id: "tool", kind: "tool", messageId: "assistant", callId: "call", name: "Bash", location: "server",
        native: { agent: "claude" }, input: { command: "pwd" }, state: "approval-required", approvalId: "approve", order: 0,
      }],
    };
    await workspace.setAgentSnapshot(pending);
    expect(onHiddenApproval).toHaveBeenCalledWith(pending.parts[0]);
    expect(parent.querySelector(".systemsculpt-agent-approval")).toBeNull();
    shown(true);
    await tick();
    expect(parent.querySelector(".systemsculpt-agent-approval")).not.toBeNull();
  });

  it("recovers an approval preview whose read completes while hidden", async () => {
    mount();
    const gate = deferred<string>();
    const file = new TFile();
    file.path = "Note.md";
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockReturnValue(gate.promise);
    const pending: AgentConversationSnapshot = {
      ...snapshot(""), status: "waiting", phase: "waiting", waitingReason: "approval",
      parts: [{
        id: "tool", kind: "tool", messageId: "assistant", callId: "call", name: "write", location: "vault",
        input: { path: "Note.md", content: "replacement" }, state: "approval-required", approvalId: "approve", order: 0,
      }],
    };
    await render(pending);
    expect(app.vault.read).toHaveBeenCalledTimes(1);
    shown(false);
    gate.resolve("original");
    await tick();
    shown(true);
    await tick();
    expect(parent.querySelector(".systemsculpt-agent-approval-preview .systemsculpt-inline-diff")).not.toBeNull();
  });

  it("applies a completed incident report to the same cached history row on show", async () => {
    const gate = deferred<boolean>();
    mount({ onPrepareIncidentReport: () => gate.promise, onCopyIncidentReport: jest.fn() });
    const reportId = `report_${"d".repeat(32)}`;
    await workspace.setHistory([
      { role: "user", message_id: "user", content: "Question" },
      { role: "assistant", message_id: "assistant", content: "", terminalOutcome: "failed", terminalReportId: reportId,
        terminalFailureCode: "response_start_failed", terminalRetryable: true },
    ]);
    expect(parent.textContent).toContain("Preparing report");
    shown(false);
    gate.resolve(true);
    await tick();
    shown(true);
    await tick();
    expect(parent.textContent).toContain(`Report ID: ${reportId}`);
  });

  it("shows the existing fallback if a hidden completion's final history cannot render", async () => {
    mount();
    await render(snapshot("old partial response"));
    shown(false);
    await workspace.settleCompletedRun([
      { role: "user", message_id: "user", content: "Question" },
      { role: "assistant", message_id: "assistant", content: "final answer" },
    ]);
    workspace.setRunPending(false);
    (MarkdownRenderer.render as jest.Mock).mockImplementation(async (_app, markdown, target) => {
      if (markdown === "final answer") throw new Error("parser failed");
      target.setText(markdown);
    });
    shown(true);
    await tick();
    expect(parent.querySelector(".systemsculpt-agent-render-fallback")).not.toBeNull();
  });

  it("does not reconcile connected settlement DOM after the leaf hides", async () => {
    mount();
    await render(snapshot("old partial response"));
    const gate = deferred();
    (MarkdownRenderer.render as jest.Mock).mockImplementation(async (_app, markdown, target) => {
      if (markdown === "final answer") await gate.promise;
      target.setText(markdown);
    });
    const settled = workspace.settleCompletedRun([
      { role: "user", message_id: "user", content: "Question" },
      { role: "assistant", message_id: "assistant", content: "final answer" },
    ]);
    await tick();
    shown(false);
    const before = workspace.renderer.element.innerHTML;
    await settled;
    gate.resolve();
    await tick();
    expect(workspace.renderer.element.innerHTML).toBe(before);
    shown(true);
    await tick();
    expect(parent.textContent).toContain("final answer");
  });

  it("reschedules a pending frame on migration without relying on the old window", async () => {
    mount();
    const frame = document.body.createEl("iframe");
    const nextWindow = frame.contentWindow! as Window & typeof globalThis;
    // Obsidian installs its DOM extensions in every pop-out; jsdom only patches
    // the main realm in setup.ts. Copy those extensions, not browser methods.
    for (const type of ["Node", "HTMLElement", "DocumentFragment"] as const) {
      const target = nextWindow[type].prototype;
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(window[type].prototype))) {
        if (!(name in target)) Object.defineProperty(target, name, descriptor);
      }
    }
    jest.spyOn(nextWindow.document, "visibilityState", "get").mockReturnValue("visible");
    const oldFrame = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(777);
    const newFrame = jest.spyOn(nextWindow, "requestAnimationFrame").mockImplementation(callback =>
      window.setTimeout(() => callback(performance.now()), 16));
    const queued = workspace.setAgentSnapshot(snapshot("queued in old window"));
    expect(oldFrame).toHaveBeenCalled();
    nextWindow.document.body.appendChild(parent);
    for (const migrate of [...migrations]) migrate();
    const latest = workspace.setAgentSnapshot(snapshot("new owner latest"));
    const rendered = Promise.all([queued, latest]);
    await tick();
    await rendered;
    expect(newFrame).toHaveBeenCalled();
    expect(parent.textContent).toContain("new owner latest");
  });
});
