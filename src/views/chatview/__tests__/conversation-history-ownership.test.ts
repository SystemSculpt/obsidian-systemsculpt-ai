/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
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
