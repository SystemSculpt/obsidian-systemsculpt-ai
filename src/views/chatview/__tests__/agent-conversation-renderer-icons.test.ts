/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer, setIcon } from "obsidian";
import type { AgentConversationSnapshot } from "../AgentConversation";
import type {
  AgentConversationPresentation,
  AgentPresentationPhase,
} from "../AgentConversationPresentation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";

function presentation(
  phase: AgentPresentationPhase,
  busy: boolean,
  activityStatus: string,
  snapshot: AgentConversationSnapshot,
): AgentConversationPresentation {
  return {
    phase,
    busy,
    composerRunning: busy,
    visibleParts: snapshot.parts,
    activityStatus,
  };
}

describe("AgentConversationRenderer tail status", () => {
  afterEach(() => {
    document.body.empty();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("keeps one loader node across live lifecycle changes and removes it at terminal", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const parts = [{
      id: "reasoning-icon",
      kind: "reasoning" as const,
      messageId: "assistant-icon",
      state: "complete" as const,
      summary: "Checked the request",
      order: 0,
    }];
    const running: AgentConversationSnapshot = {
      runId: "run-icon",
      turnId: "user-icon",
      status: "running",
      phase: "thinking",
      statusLabel: "Thinking",
      messages: [{
        id: "assistant-icon",
        role: "assistant",
        partIds: ["reasoning-icon"],
      }],
      parts,
    };
    await renderer.renderActive(
      running,
      presentation("reasoning", true, "Thinking", running),
    );
    const status = parent.querySelector<HTMLElement>(".systemsculpt-agent-tail-status")!;
    const icon = status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-icon")!;
    expect(setIcon).toHaveBeenCalledWith(icon, "loader-circle");
    (setIcon as jest.Mock).mockClear();

    const responding: AgentConversationSnapshot = {
      ...running,
      phase: "working",
      parts: [{
        ...parts[0],
        summary: "Checked the request and the current note",
      }],
    };
    await renderer.renderActive(
      responding,
      presentation("responding", true, "Thinking", responding),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBe(status);
    expect(parent.querySelector(".systemsculpt-agent-tail-status-icon")).toBe(icon);
    expect((setIcon as jest.Mock).mock.calls.filter(([element]) => element === icon))
      .toHaveLength(0);
    expect(icon.classList).toContain("is-animated");
    expect(status.parentElement?.lastElementChild).toBe(status);

    const terminal: AgentConversationSnapshot = {
      ...responding,
      status: "completed",
    };
    await renderer.renderActive(
      terminal,
      presentation("completed", false, "Done", terminal),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBeNull();
    expect(status.isConnected).toBe(false);
    renderer.unload();
  });

  it("drops an asynchronous history render after unload instead of writing stale DOM", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const render = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        await renderGate;
        staging.setText(String(markdown));
      },
    );

    const pending = renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-stale-render",
      content: "This must never appear after unload.",
    }]);
    await Promise.resolve();
    renderer.unload();
    releaseRender();
    await pending;

    expect(parent.textContent).not.toContain("This must never appear after unload.");
    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-disabled-render",
      content: "Rendering stays disabled until load.",
    }]);
    expect(render).toHaveBeenCalledTimes(1);
    render.mockRestore();
  });

  it("falls back to cancelling an inline edit when Escape keyup is lost", async () => {
    jest.useFakeTimers();
    const parent = document.body.createDiv();
    const onCancelMessageEdit = jest.fn();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCancelMessageEdit,
    });
    renderer.load();
    renderer.setInlineMessageEdit({
      messageId: "user-keyup-fallback",
      text: "Original request",
      laterMessageCount: 2,
      hasAttachments: false,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    });
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-keyup-fallback",
      content: "Original request",
    }]);
    const input = parent.querySelector<HTMLTextAreaElement>(
      ".systemsculpt-agent-message-editor-input",
    )!;

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(onCancelMessageEdit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(onCancelMessageEdit).toHaveBeenCalledTimes(1);
    expect(onCancelMessageEdit).toHaveBeenCalledWith("user-keyup-fallback");
    renderer.unload();
  });
});
