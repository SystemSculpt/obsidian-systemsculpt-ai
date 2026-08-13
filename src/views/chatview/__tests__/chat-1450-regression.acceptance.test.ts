/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { normalizeLocalToolOutcome } from "../../../services/SystemSculptService";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type {
  AgentConversationSnapshot,
  AgentPart,
  AgentToolPart,
} from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
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

async function hydrateRestoredWorked(
  renderer: AgentConversationRenderer,
  worked: HTMLDetailsElement | null,
): Promise<void> {
  if (!worked) return;
  const state = (renderer as unknown as {
    historicalActivityHydrationStates: Map<
      HTMLDetailsElement,
      { hydration: Promise<void> | null }
    >;
  }).historicalActivityHydrationStates.get(worked);
  if (!state) return;
  worked.open = true;
  worked.dispatchEvent(new Event("toggle"));
  await state.hydration;
  worked.open = false;
  worked.dispatchEvent(new Event("toggle"));
}

async function expandHistoricalOverflow(
  renderer: AgentConversationRenderer,
  overflow: HTMLButtonElement,
): Promise<void> {
  overflow.click();
  const state = (renderer as unknown as {
    historicalOverflowHydrationStates: Map<
      HTMLButtonElement,
      { hydration: Promise<void> | null }
    >;
  }).historicalOverflowHydrationStates.get(overflow);
  await state?.hydration;
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

function durableReadCall(part: AgentToolPart): ToolCall {
  return {
    id: part.callId,
    messageId: part.messageId,
    request: {
      id: part.callId,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input),
      },
    },
    state: "failed",
    timestamp: part.order,
    result: {
      success: false,
      data: part.output?.data,
      ...(part.error ? { error: part.error } : {}),
    },
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
      const expectToolOutcomes = (): HTMLElement[] => {
        const tools = [...parent.querySelectorAll<HTMLElement>(
          ".systemsculpt-agent-part.is-tool",
        )];
        expect(tools).toHaveLength(2);
        const mixedTool = tools.find((tool) =>
          tool.dataset.partKey === `tool:${mixed.callId}`);
        const failedTool = tools.find((tool) =>
          tool.dataset.partKey === `tool:${failed.callId}`);
        expect(mixedTool?.classList).toContain("is-partial");
        expect(mixedTool?.querySelector<HTMLElement>(
          ".systemsculpt-agent-tool-state-icon",
        )?.dataset.iconState).toBe("x");
        expect(mixedTool?.querySelector(".systemsculpt-agent-tool-summary")?.textContent)
          .toBe("2 completed, 1 failed");
        expect(failedTool?.classList).toContain("is-failed");
        expect(failedTool?.querySelector<HTMLElement>(
          ".systemsculpt-agent-tool-state-icon",
        )?.dataset.iconState).toBe("x");
        expect(failedTool?.querySelector(".systemsculpt-agent-tool-summary")?.textContent)
          .toBe("0 completed, 2 failed");
        return tools;
      };

      const expandPreviousToolCalls = async (): Promise<void> => {
        await hydrateRestoredWorked(
          view.renderer,
          parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]"),
        );
        const visibleTools = [...parent.querySelectorAll<HTMLElement>(
          ".systemsculpt-agent-part.is-tool",
        )];
        expect(visibleTools).toHaveLength(1);
        expect(visibleTools[0]?.dataset.partKey).toBe(`tool:${failed.callId}`);
        const overflow = parent.querySelector<HTMLButtonElement>(
          "button[data-agent-activity-overflow]",
        );
        expect(overflow).not.toBeNull();
        expect(overflow?.getAttribute("aria-expanded")).toBe("false");
        if (overflow) await expandHistoricalOverflow(view.renderer, overflow);
        expect(overflow?.getAttribute("aria-expanded")).toBe("true");
      };

      await view.setAgentSnapshot(snapshot);
      await expandPreviousToolCalls();
      const tools = expectToolOutcomes();
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

      const durableCalls = [mixed, failed].map(durableReadCall);
      const restoredHistory: ChatMessage[] = [{
        role: "assistant",
        message_id: "assistant-sanitized-1450",
        content: fixture.continuationMarker,
        tool_calls: durableCalls,
        messageParts: [
          ...durableCalls.map((call, index) => ({
            id: index === 0 ? mixed.id : failed.id,
            type: "tool_call" as const,
            timestamp: index,
            data: call,
          })),
          {
            id: continuation.id,
            type: "content",
            timestamp: 2,
            data: fixture.continuationMarker,
          },
        ],
      }];
      await view.setAgentSnapshot(null);
      await view.setHistory(restoredHistory);
      await expandPreviousToolCalls();
      expectToolOutcomes();
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
      name: "unknown_server_action",
      location: "server",
      input: {},
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
      expect(parent.querySelector("details.systemsculpt-agent-tool")?.classList)
        .not.toContain("is-disclosure");
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
