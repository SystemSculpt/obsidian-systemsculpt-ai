/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer } from "obsidian";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation } from "../AgentConversationPresentation";

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
