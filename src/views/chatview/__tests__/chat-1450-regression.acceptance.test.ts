/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { normalizeLocalToolOutcome } from "../../../services/SystemSculptService";
import type {
  AgentConversationSnapshot,
  AgentPart,
  AgentToolPart,
} from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";
import { CHAT_1450_REGRESSION_FIXTURE as fixture } from "./fixtures/chat-1450-regression.fixture";

const GENERIC_AGENT_FAILURE = "SystemSculpt could not complete the response.";

function workspace(parent: HTMLElement): AgentWorkspace {
  const value = new AgentWorkspace(parent, {
    app: new App(),
    sourcePath: () => "SystemSculpt/Chats/sanitized-acceptance.md",
    onSubmit: jest.fn(),
    onStop: jest.fn(),
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onApprove: jest.fn(),
    onOpenArtifact: jest.fn(),
    onCopyArtifactPath: jest.fn(),
    onNewChat: jest.fn(),
    onOpenHistory: jest.fn(),
    onOpenSettings: jest.fn(),
  });
  value.load();
  return value;
}

function legacyReadPart(
  id: string,
  order: number,
  call: typeof fixture.mixedRead | typeof fixture.allFailedRead,
): AgentToolPart {
  return {
    id,
    order,
    kind: "tool",
    messageId: "assistant-sanitized-1450",
    callId: `call-${id}`,
    name: call.name,
    location: "vault",
    input: call.input,
    state: "failed",
    output: { data: call.result.data },
    // Preserve the stale response-wide code present in the regression shape.
    // Item-level outcomes must remain authoritative for display state.
    error: call.result.error,
  };
}

describe("sanitized 14:50 ChatView regression acceptance", () => {
  it("renders a mixed read as warning-state Partial and an all-failed read as Failed", async () => {
    const parent = document.body.createDiv();
    const view = workspace(parent);
    expect(normalizeLocalToolOutcome(
      fixture.mixedRead.result.data,
      fixture.mixedRead.name,
    )).toMatchObject({
      success: false,
      error: { code: "TOOL_PARTIAL_FAILURE" },
    });
    expect(normalizeLocalToolOutcome(
      fixture.allFailedRead.result.data,
      fixture.allFailedRead.name,
    )).toMatchObject({
      success: false,
      error: { code: "TOOL_OPERATION_FAILED" },
    });
    const mixed = legacyReadPart("tool-mixed", 0, fixture.mixedRead);
    const failed = legacyReadPart("tool-all-failed", 1, fixture.allFailedRead);
    const continuation: AgentPart = {
      id: "text-after-tools",
      order: 2,
      kind: "text",
      messageId: "assistant-sanitized-1450",
      state: "complete",
      markdown: fixture.continuationMarker,
    };
    const snapshot: AgentConversationSnapshot = {
      runId: "run-sanitized-1450",
      turnId: "turn-sanitized-1450",
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-sanitized-1450",
        role: "assistant",
        partIds: [mixed.id, failed.id, continuation.id],
      }],
      parts: [mixed, failed, continuation],
    };

    try {
      await view.setAgentSnapshot(snapshot);
      const tools = [...parent.querySelectorAll<HTMLElement>(
        ".systemsculpt-agent-part.is-tool",
      )];
      expect(tools).toHaveLength(2);
      expect(tools[0].classList).toContain("is-partial");
      expect(tools[0].querySelector(".systemsculpt-agent-tool-state")?.textContent)
        .toBe("Partial");
      expect(tools[0].querySelector(".systemsculpt-agent-tool-summary")?.textContent)
        .toBe("2 completed, 1 failed");
      expect(tools[1].classList).toContain("is-failed");
      expect(tools[1].querySelector(".systemsculpt-agent-tool-state")?.textContent)
        .toBe("Failed");
      expect(tools[1].querySelector(".systemsculpt-agent-tool-summary")?.textContent)
        .toBe("0 completed, 2 failed");
      expect(parent.querySelectorAll(".systemsculpt-agent-tool-icon.is-animated"))
        .toHaveLength(0);
      expect(parent.querySelectorAll(".systemsculpt-agent-part.is-error"))
        .toHaveLength(0);
      expect(parent.textContent).not.toContain(GENERIC_AGENT_FAILURE);
      const text = parent.querySelector<HTMLElement>(
        ".systemsculpt-agent-part.is-text",
      );
      expect(text?.textContent).toBe(fixture.continuationMarker);
      expect(tools.every((tool) => Boolean(
        tool.compareDocumentPosition(text!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ))).toBe(true);
      expect(parent.textContent).not.toContain(fixture.mixedRead.result.error.message);
      expect(parent.textContent).not.toContain(fixture.allFailedRead.result.error.message);
    } finally {
      view.unload();
    }
  });

  it("renders one response-wide banner and suppresses its duplicate tool error", async () => {
    const parent = document.body.createDiv();
    const view = workspace(parent);
    const duplicate = fixture.duplicateTerminalError;
    const tool: AgentToolPart = {
      id: "tool-duplicate-terminal",
      order: 0,
      kind: "tool",
      messageId: "assistant-duplicate-terminal",
      callId: "call-duplicate-terminal",
      name: "read",
      location: "vault",
      input: { paths: ["Fixture/unavailable.md"] },
      state: "failed",
      error: duplicate,
    };
    const snapshot: AgentConversationSnapshot = {
      runId: "run-duplicate-terminal",
      turnId: "turn-duplicate-terminal",
      status: "failed",
      phase: "complete",
      terminalError: duplicate,
      messages: [{
        id: "assistant-duplicate-terminal",
        role: "assistant",
        partIds: [tool.id],
      }],
      parts: [tool, {
        id: "error-duplicate-terminal",
        order: 1,
        kind: "error",
        error: duplicate,
        retryable: true,
        retryMessageId: "turn-duplicate-terminal",
      }],
    };

    try {
      await view.setAgentSnapshot(snapshot);
      expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBeNull();
      expect(parent.querySelectorAll(".systemsculpt-agent-part.is-error"))
        .toHaveLength(1);
      expect(parent.querySelector(".systemsculpt-agent-tool-error")).toBeNull();
      expect(parent.textContent?.match(
        /SystemSculpt could not complete the response\./g,
      )).toHaveLength(1);
      expect(parent.textContent).not.toContain(duplicate.message);
    } finally {
      view.unload();
    }
  });

  it("keeps the invalid-call acceptance inputs limited to empty read and list_items", () => {
    expect(fixture.invalidEmptyClientCalls).toEqual([
      { name: "read", arguments: {} },
      { name: "list_items", arguments: {} },
    ]);
    expect(JSON.stringify(fixture.invalidEmptyClientCalls)).not.toMatch(
      /path|content|prompt|response|provider|request|call.?id/iu,
    );
  });
});
