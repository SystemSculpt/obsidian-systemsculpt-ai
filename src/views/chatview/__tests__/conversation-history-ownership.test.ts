/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer } from "obsidian";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { historyHydrationFor } from "./fixtures/conversation-rendering";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation } from "../AgentConversationPresentation";

it.each(["restored", "adopted"])("does not duplicate the action summary in opened %s history", async (origin) => {
  const parent = document.body.createDiv();
  const renderer = new AgentConversationRenderer(parent, {
    app: new App(), sourcePath: () => "", onApprove: jest.fn(),
    onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
  });
  renderer.load();
  try {
    const tool: ToolCall = {
      id: "summary-call", messageId: "summary-assistant", timestamp: 2,
      request: { id: "summary-call", type: "function", function: { name: "read", arguments: JSON.stringify({ paths: ["Plan.md"] }) } },
      state: "completed", result: { success: true, data: { summary: "Read Plan.md" } },
    };
    const messages: ChatMessage[] = [
      { role: "user", message_id: "summary-user", content: "Review the plan." },
      { role: "assistant", message_id: "summary-assistant", content: "Done.", responseDurationMs: 12000, messageParts: [
        { id: "summary-reasoning", type: "reasoning", timestamp: 1, data: "Checked the plan." },
        { id: "summary-tool", type: "tool_call", timestamp: 2, data: tool },
        { id: "summary-answer", type: "content", timestamp: 3, data: "Done." },
      ] },
    ];
    if (origin === "adopted") {
      await renderer.renderHistory(messages.slice(0, 1));
      const snapshot: AgentConversationSnapshot = {
        runId: "summary-run", turnId: "summary-user", status: "completed", phase: "complete", elapsedMs: 12000,
        messages: [{ id: "summary-assistant", role: "assistant", partIds: ["summary-reasoning", "summary-tool", "summary-answer"] }],
        parts: [
          { id: "summary-reasoning", kind: "reasoning", messageId: "summary-assistant", order: 1, state: "complete", summary: "Checked the plan." },
          { id: "summary-tool", kind: "tool", messageId: "summary-assistant", order: 2, state: "succeeded", callId: tool.id, name: "read", location: "vault", input: { paths: ["Plan.md"] }, output: { summary: "Read Plan.md" } },
          { id: "summary-answer", kind: "text", messageId: "summary-assistant", order: 3, state: "complete", markdown: "Done." },
        ],
      };
      await renderer.renderActive(snapshot, presentAgentConversation(snapshot, false));
      await renderer.settleHistory(messages, "summary-user");
    } else {
      await renderer.renderHistory(messages);
    }
    const activity = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const label = activity.querySelector<HTMLElement>(":scope > summary .systemsculpt-agent-activity-label")!;
    expect(label.textContent).toBe("Thought, read Plan.md");
    activity.open = true;
    activity.dispatchEvent(new Event("toggle"));
    await historyHydrationFor(renderer).hydrate(activity);
    expect(label.textContent).toBe("Activity");
    expect(activity.querySelector(".systemsculpt-agent-activity-overflow-label")?.textContent).toBe("Thought, read Plan.md");
    expect(activity.querySelector(".systemsculpt-agent-activity-duration")?.textContent).toBe("12s");
    await renderer.renderHistory(messages);
    expect(label.textContent).toBe("Activity");
    activity.open = false;
    activity.dispatchEvent(new Event("toggle"));
    expect(label.textContent).toBe("Thought, read Plan.md");
  } finally {
    renderer.unload();
    parent.remove();
  }
});

it.each(["current-user", null])("does not adopt an active turn %j during an ordinary history refresh", async (turnId) => {
  const parent = document.body.createDiv();
  const renderer = new AgentConversationRenderer(parent, {
    app: new App(),
    sourcePath: () => "",
    onApprove: jest.fn(),
    onOpenArtifact: jest.fn(),
    onCopyArtifactPath: jest.fn(),
  });
  renderer.load();
  try {
    const snapshot: AgentConversationSnapshot = {
      runId: "current-run",
      turnId,
      status: "running",
      phase: "working",
      messages: [{ id: "current-assistant", role: "assistant", partIds: ["current-tool"] }],
      parts: [{
        id: "current-tool",
        kind: "tool",
        order: 1,
        callId: "current-call",
        name: "read",
        location: "vault",
        messageId: "current-assistant",
        input: { paths: ["Current.md"] },
        state: "running",
      }],
    };
    await renderer.renderActive(snapshot, presentAgentConversation(snapshot, true));
    const active = renderer.activeResponseElement;
    const tool = active!.querySelector('[data-part-key="tool:current-call"]');
    // Restored exports can start with an assistant message and have no user turn ID.
    await renderer.renderHistory([{ role: "assistant", message_id: "old-assistant", content: "Earlier answer" }]);
    expect(renderer.activeResponseElement).toBe(active);
    expect(active!.parentElement).toBe(renderer.activeRoot);
    expect(active!.querySelector('[data-part-key="tool:current-call"]')).toBe(tool);
    expect(parent.querySelector('[data-message-id="old-assistant"]')).not.toBe(active);
    expect(parent.querySelector('[data-message-id="old-assistant"]')?.textContent).toContain("Earlier answer");
  } finally {
    renderer.unload();
    parent.remove();
  }
});

it("does not lend settlement adoption to an overlapping ordinary history refresh", async () => {
  const parent = document.body.createDiv();
  const renderer = new AgentConversationRenderer(parent, {
    app: new App(), sourcePath: () => "", onApprove: jest.fn(),
    onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
  });
  renderer.load();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const originalRender = MarkdownRenderer.render;
  const markdown = jest.spyOn(MarkdownRenderer, "render").mockImplementation(async (...args) => {
    if (args[1] === "Settling prompt") {
      started();
      await gate;
    }
    await originalRender(...args);
  });
  try {
    const user = { role: "user" as const, message_id: "overlap-user", content: "Original prompt" };
    const answer = { role: "assistant" as const, message_id: "overlap-answer", content: "Done" };
    await renderer.renderHistory([user]);
    const snapshot: AgentConversationSnapshot = {
      runId: "overlap-run", turnId: user.message_id, status: "completed", phase: "complete",
      messages: [{ id: answer.message_id, role: "assistant", partIds: ["overlap-text"] }],
      parts: [{ id: "overlap-text", order: 1, kind: "text", messageId: answer.message_id, state: "complete", markdown: "Done" }],
    };
    await renderer.renderActive(snapshot, presentAgentConversation(snapshot, false));
    const liveRow = renderer.activeResponseElement;
    const settling = renderer.settleHistory([{ ...user, content: "Settling prompt" }, answer], user.message_id);
    await rendering;
    await renderer.renderHistory([user, answer]);
    expect(renderer.activeResponseElement).toBe(liveRow);
    expect(liveRow!.parentElement).toBe(renderer.activeRoot);
    release();
    await settling;
    expect(renderer.activeResponseElement).toBe(liveRow);
    expect(parent.querySelectorAll('.systemsculpt-agent-history [data-message-id="overlap-answer"]')).toHaveLength(1);
  } finally {
    release();
    markdown.mockRestore();
    renderer.unload();
    parent.remove();
  }
});
