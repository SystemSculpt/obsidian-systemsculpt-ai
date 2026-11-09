/** @jest-environment jsdom */

import { App } from "obsidian";
import type { AgentConversationSnapshot, AgentPart, AgentToolPart } from "../../../chat/ChatConversation";
import { encodeSystemSculptToolResult } from "../../../tools/systemsculpt/SystemSculptTools";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation } from "../AgentConversationPresentation";

const read: AgentToolPart = {
  id: "read", kind: "tool", messageId: "answer", callId: "call-read", order: 0, name: "read", location: "vault",
  input: { paths: ["Notes/Lighthouse.md"] }, state: "succeeded",
  output: { data: { files: [{ path: "Notes/Lighthouse.md", content: "A lighthouse at dusk" }] } },
};
const narration: AgentPart = { id: "say", kind: "text", messageId: "answer", order: 1, state: "complete", markdown: "Drawing it now." };
const generate: AgentToolPart = {
  id: "gen", kind: "tool", messageId: "answer", callId: "call-gen", order: 2, name: "generate_image", location: "server",
  input: { prompt: "A lighthouse at night" }, state: "running",
};

function snapshot(parts: readonly AgentPart[], done = false): AgentConversationSnapshot {
  return {
    runId: "run", turnId: "prompt", status: done ? "completed" : "running", phase: done ? "complete" : "working",
    elapsedMs: 3_000, messages: [{ id: "answer", role: "assistant", partIds: parts.map((part) => part.id) }], parts,
  };
}

describe("a live generation's turn", () => {
  it("folds the steps and words before the picture into the turn's one row, so nothing above it moves when it lands", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(), sourcePath: () => "", onApprove: jest.fn(), onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    try {
      const running = snapshot([read, narration, generate]);
      await renderer.renderActive(running, presentAgentConversation(running, true));
      const body = host.querySelector<HTMLElement>(".systemsculpt-agent-active-run .systemsculpt-agent-turn-body")!;
      const fold = body.firstElementChild as HTMLDetailsElement;
      expect(fold.matches("details[data-agent-turn-fold].is-settled")).toBe(true);
      // The read and the words said before the picture sit inside it; the tile comes right after.
      expect(fold.querySelector("[data-part-key='tool:call-read']")).not.toBeNull();
      expect(fold.textContent).toContain("Drawing it now.");
      expect(fold.nextElementSibling?.querySelector("[data-testid='chat.turn.media.pending']")).not.toBeNull();

      const saved = { ...generate, state: "succeeded" as const, output: { data: encodeSystemSculptToolResult({ ok: true, message: "Saved", media: [{ kind: "image", path: "SystemSculpt/Images/night.png" }] }) } };
      const done = snapshot([read, narration, saved], true);
      await renderer.renderActive(done, presentAgentConversation(done, false));
      // The finished turn keeps that same row first.
      expect(body.firstElementChild).toBe(fold);
    } finally { renderer.unload(); host.remove(); }
  });
});
