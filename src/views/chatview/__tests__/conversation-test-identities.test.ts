/** @jest-environment jsdom */

import { App } from "obsidian";
import type { AgentConversationSnapshot, AgentPart } from "../../../chat/ChatConversation";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { presentAgentConversation } from "../AgentConversationPresentation";
import { historyHydrationFor } from "./fixtures/conversation-rendering";

const toolCall: ToolCall = {
  id: "read-plan", messageId: "answer", timestamp: 2, state: "completed",
  request: { id: "read-plan", type: "function", function: { name: "read", arguments: '{"paths":["Plan.md"]}' } },
  result: { success: true, data: { files: [{ path: "Plan.md", content: "# Plan" }] } },
};
const parts: readonly AgentPart[] = [
  { id: "thinking", kind: "reasoning", messageId: "answer", order: 1, state: "complete", summary: "Check the plan" },
  { id: "read-part", kind: "tool", messageId: "answer", order: 2, callId: toolCall.id, name: "read", location: "vault", input: { paths: ["Plan.md"] }, state: "running" },
  { id: "answer-part", kind: "text", messageId: "answer", order: 3, state: "complete", markdown: "The plan is ready." },
];
const snapshot: AgentConversationSnapshot = {
  runId: "run", turnId: "prompt", status: "running", phase: "working",
  messages: [{ id: "answer", role: "assistant", partIds: parts.map((part) => part.id) }],
  parts,
};
const history: readonly ChatMessage[] = [
  { role: "user", message_id: "prompt", content: "Check the plan" },
  {
    role: "assistant", message_id: "answer", content: "The plan is ready.", tool_calls: [toolCall],
    messageParts: [
      { id: "thinking", type: "reasoning", timestamp: 1, data: "Check the plan" },
      { id: "read-part", type: "tool_call", timestamp: 2, data: toolCall },
      { id: "answer-part", type: "content", timestamp: 3, data: "The plan is ready." },
    ],
  },
];

function setup() {
  const host = document.body.createDiv();
  const renderer = new AgentConversationRenderer(host, {
    app: new App(), sourcePath: () => "", onApprove: jest.fn(),
    onOpenArtifact: jest.fn(), onCopyArtifactPath: jest.fn(),
  });
  renderer.load();
  return { host, renderer, dispose: () => { renderer.unload(); host.remove(); } };
}

function expectToolIdentity(tool: HTMLElement, state: string) {
  expect(tool.dataset).toMatchObject({ testid: "chat.part", kind: "tool", state, toolGrouped: "false", partKey: "tool:read-plan" });
  expect(tool.querySelector('[data-testid="chat.tool.label"]')?.textContent).toContain("Plan");
  expect(tool.querySelector('[data-testid="chat.tool.summary"]')).not.toBeNull();
  expect(tool.querySelector<HTMLElement>('[data-testid="chat.tool.state"]')?.dataset.iconState)
    .toBe(state === "running" ? "loader-circle" : "check");
}

afterEach(async () => {
  // Let queued <details> toggle events finish before jsdom disposes its window.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("keeps live structural identities current while keyed parts and tools update", async () => {
  const { host, renderer, dispose } = setup();
  try {
    await renderer.renderActive(snapshot, presentAgentConversation(snapshot, true));
    const turn = host.querySelector<HTMLElement>('[data-testid="chat.turn"]')!;
    expect(turn.dataset).toMatchObject({ role: "assistant", active: "true", turnId: "prompt" });
    turn.querySelector<HTMLButtonElement>('[data-testid="chat.activity.previous-tools"]')!.click();
    expect([...turn.querySelectorAll<HTMLElement>('[data-testid="chat.part"]')].map((part) => part.dataset.kind))
      .toEqual(["reasoning", "tool", "text"]);
    const tool = turn.querySelector<HTMLElement>('[data-kind="tool"]')!;
    expectToolIdentity(tool, "running");
    const tail = host.querySelector<HTMLElement>('[data-testid="chat.tail-status"]')!;
    expect(tail.dataset.phase).toBe("acting");
    expect(tail.querySelector('[data-testid="chat.tail-status.label"]')?.textContent).toBe(tail.dataset.status);
    expect(turn.querySelector('[data-testid="chat.activity.body"]')).not.toBeNull();

    const completed: AgentConversationSnapshot = {
      ...snapshot, status: "completed", phase: "complete",
      parts: parts.map((part) => part.kind === "tool" ? { ...part, state: "succeeded", output: toolCall.result } : part),
    };
    await renderer.renderActive(completed, presentAgentConversation(completed, false));
    expect(host.querySelector('[data-testid="chat.turn"]')).toBe(turn);
    expect(turn.dataset.active).toBe("false");
    expect(turn.querySelector('[data-kind="tool"]')).toBe(tool);
    expectToolIdentity(tool, "succeeded");
    expect(host.querySelector('[data-testid="chat.tail-status"]')).toBeNull();
  } finally { dispose(); }
});

it("preserves structural identities when a live response becomes durable history", async () => {
  const { host, renderer, dispose } = setup();
  try {
    await renderer.renderActive(snapshot, presentAgentConversation(snapshot, true));
    const turn = host.querySelector<HTMLElement>('[data-testid="chat.turn"]')!;
    const tool = turn.querySelector<HTMLElement>('[data-kind="tool"]')!;
    await renderer.settleHistory(history, "prompt");
    expect(host.querySelector('[data-testid="chat.turn"][data-role="assistant"]')).toBe(turn);
    expect(turn.dataset.active).toBe("false");
    expect(turn.querySelector('[data-testid="chat.part"][data-kind="tool"]')).toBe(tool);
    expectToolIdentity(tool, "succeeded");
    expect(host.querySelector<HTMLElement>('[data-testid="chat.turn"][data-role="user"]')?.dataset.active).toBe("false");
  } finally { dispose(); }
});

it("stamps restored historical parts after deferred activity hydration", async () => {
  const { host, renderer, dispose } = setup();
  try {
    await renderer.renderHistory(history);
    const turn = host.querySelector<HTMLElement>('[data-testid="chat.turn"][data-role="assistant"]')!;
    const activity = turn.querySelector<HTMLDetailsElement>('details[data-agent-turn-fold]')!;
    await historyHydrationFor(renderer).hydrate(activity);
    const restored = [...turn.querySelectorAll<HTMLElement>('[data-testid="chat.part"]')];
    expect(restored.map((part) => part.dataset.kind).sort()).toEqual(["reasoning", "text", "tool"]);
    expectToolIdentity(turn.querySelector<HTMLElement>('[data-kind="tool"]')!, "succeeded");
    expect(turn.dataset.active).toBe("false");
  } finally { dispose(); }
});

it("identifies live and restored cancellation tails and durable error parts", async () => {
  const { host, renderer, dispose } = setup();
  try {
    const cancelled: AgentConversationSnapshot = { ...snapshot, status: "cancelled", phase: "complete", parts: [], messages: [] };
    await renderer.renderActive(cancelled, presentAgentConversation(cancelled, false));
    expect(host.querySelector<HTMLElement>('[data-testid="chat.tail-status"]')?.dataset.phase).toBe("cancelled");
    renderer.clearActive();
    await renderer.renderHistory([
      history[0],
      { role: "assistant", message_id: "stopped-answer", content: "Partial", terminalOutcome: "cancelled" },
      { role: "user", message_id: "failed-prompt", content: "Try again" },
      { role: "assistant", message_id: "failed-answer", content: "", terminalOutcome: "failed", terminalFailureCode: "agent_turn_failed", terminalRetryable: false, terminalReportId: `report_${"a".repeat(32)}` },
    ]);
    const tail = host.querySelector<HTMLElement>('[data-testid="chat.tail-status"]')!;
    expect(tail.dataset).toMatchObject({ phase: "cancelled", status: "Stopped" });
    expect(tail.querySelector('[data-testid="chat.tail-status.label"]')?.textContent).toBe("Stopped");
    expect(host.querySelector('[data-testid="chat.part"][data-kind="error"]')?.getAttribute("role")).toBe("alert");
  } finally { dispose(); }
});
