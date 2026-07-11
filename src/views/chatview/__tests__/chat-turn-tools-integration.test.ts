import { ChatTurn } from "../turn/ChatTurn";
import type { ChatTurnEffects } from "../turn/ChatTurnEffects";
import type { ChatMessage } from "../../types";
import { ChatPersistenceError } from "../persistence/ChatPersistenceError";

function tool(id: string, state = "pending"): any {
  return { id, state, request: { function: { name: `tool_${id}`, arguments: "{}" } } };
}

function message(toolCalls: any[] = [], id = "assistant-1", content = ""): ChatMessage {
  return { role: "assistant", content, message_id: id, tool_calls: toolCalls } as ChatMessage;
}

function stream(result: ChatMessage, completionState = "content", stopReason = toolCallsPresent(result) ? "tool_calls" : "stop"): any {
  return { message: result, messageId: result.message_id, messageEl: {} as HTMLElement, completionState, stopReason };
}

function toolCallsPresent(value: ChatMessage): boolean {
  return Array.isArray(value.tool_calls) && value.tool_calls.length > 0;
}

function harness(overrides: Partial<ChatTurnEffects> = {}) {
  const controller = new AbortController();
  const order: string[] = [];
  const initial = message([tool("1")]);
  const continuation = message([], "assistant-2", "done");
  const effects: ChatTurnEffects = {
    signal: controller.signal,
    commitUser: async () => { order.push("user"); },
    commitAssistant: async (value) => { order.push(`assistant:${value.message_id}`); },
    runInitialStream: async () => stream(initial),
    shouldContinueTools: (value) => toolCallsPresent(value.message),
    requestToolApproval: async (value) => { order.push(`approve:${value.id}`); return true; },
    executeTool: async (value) => {
      order.push(`execute:${value.id}`);
      value.state = "completed";
      value.result = { success: true, data: "ok" };
    },
    commitToolCheckpoint: async () => { order.push("checkpoint"); },
    renderToolCheckpoint: async () => { order.push("render"); },
    runContinuationStream: async () => { order.push("continuation"); return stream(continuation); },
    ...overrides,
  };
  return { controller, effects, order, initial, continuation, turn: new ChatTurn(effects) };
}

const user = { role: "user", content: "go", message_id: "user-1" } as ChatMessage;

describe("ChatTurn tool ownership", () => {
  it("durably checkpoints a completed tool before starting its continuation", async () => {
    const { turn, order } = harness();
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(order).toEqual(["user", "assistant:assistant-1", "approve:1", "execute:1", "checkpoint", "render", "continuation", "assistant:assistant-2"]);
  });

  it("finishes explicitly when a tool-bearing assistant response should not continue", async () => {
    const { turn, effects } = harness({ shouldContinueTools: () => false });
    const approval = jest.spyOn(effects, "requestToolApproval");
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(approval).not.toHaveBeenCalled();
  });

  it("finishes a continuation containing only already-completed tool calls", async () => {
    const completed = tool("already", "completed");
    completed.result = { success: true, data: "done" };
    const { turn, effects } = harness({
      runContinuationStream: async () => stream(message([completed], "assistant-2")),
      shouldContinueTools: (value) => (value.message.tool_calls || []).some((call) => call.state !== "completed" && call.state !== "failed"),
    });
    const approval = jest.spyOn(effects, "requestToolApproval");
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it("executes multiple tools in approval order before one checkpoint", async () => {
    const calls = [tool("1"), tool("2"), tool("3")];
    const { turn, order } = harness({ runInitialStream: async () => stream(message(calls)) });
    await turn.run(user);
    expect(order).toEqual(["user", "assistant:assistant-1", "approve:1", "execute:1", "approve:2", "execute:2", "approve:3", "execute:3", "checkpoint", "render", "continuation", "assistant:assistant-2"]);
  });

  it.each([["denial", false], ["failure", true]] as const)("persists %s and continues the batch", async (_label, approved) => {
    const calls = [tool("1"), tool("2")];
    const { turn, order } = harness({
      runInitialStream: async () => stream(message(calls)),
      requestToolApproval: async (value) => { order.push(`approve:${value.id}`); return value.id === "1" ? approved : true; },
      executeTool: async (value) => {
        order.push(`execute:${value.id}`);
        value.state = value.id === "1" ? "failed" : "completed";
        value.result = value.state === "failed" ? { success: false, error: { code: "FAILED", message: "no" } } : { success: true, data: "ok" };
      },
    });
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(order).toContain("approve:2");
    expect(order.filter((entry) => entry === "checkpoint")).toHaveLength(1);
  });

  it("durably marks every unstarted tool cancelled when abort arrives immediately before approval", async () => {
    const calls = [tool("1"), tool("2"), tool("3")];
    let actualInvocations = 0;
    let checkpointed: any[] = [];
    const { turn, controller, effects } = harness({
      runInitialStream: async () => stream(message(calls)),
      commitAssistant: async () => { controller.abort(); },
      requestToolApproval: async () => { throw new Error("approval must not open after cancellation"); },
      executeTool: async (value, signal) => {
        if (!signal.aborted) actualInvocations += 1;
        value.state = "failed";
        value.result = {
          success: false,
          error: {
            code: "TOOL_CANCELLED_BEFORE_START",
            message: "Tool execution was cancelled before it started.",
          },
        };
      },
      commitToolCheckpoint: async (value) => {
        checkpointed = JSON.parse(JSON.stringify(value.tool_calls || []));
      },
    });
    const approval = jest.spyOn(effects, "requestToolApproval");
    const continuation = jest.spyOn(effects, "runContinuationStream");

    await turn.run(user);

    expect(turn.outcome).toBe("cancelled");
    expect(approval).not.toHaveBeenCalled();
    expect(actualInvocations).toBe(0);
    expect(continuation).not.toHaveBeenCalled();
    expect(checkpointed).toHaveLength(3);
    expect(checkpointed).toEqual(expect.arrayContaining(calls.map((value) => expect.objectContaining({
      id: value.id,
      state: "failed",
      result: {
        success: false,
        error: {
          code: "TOOL_CANCELLED_BEFORE_START",
          message: "Tool execution was cancelled before it started.",
        },
      },
    }))));
    expect(checkpointed.some((value) => value.state === "pending")).toBe(false);
  });

  it("cancels after approval without starting a later tool or continuation", async () => {
    const { turn, controller, effects } = harness({
      runInitialStream: async () => stream(message([tool("1"), tool("2")])),
      requestToolApproval: async () => { controller.abort(); return true; },
    });
    const continuation = jest.spyOn(effects, "runContinuationStream");
    await turn.run(user);
    expect(turn.outcome).toBe("cancelled");
    expect(continuation).not.toHaveBeenCalled();
  });

  it("gives checkpoint persistence failure precedence over cancellation", async () => {
    const failure = new ChatPersistenceError({ operation: "tool_checkpoint", chatId: "chat-1", cause: new Error("disk") });
    const { turn, controller } = harness({ commitToolCheckpoint: async () => { controller.abort(); throw failure; } });
    await expect(turn.run(user)).rejects.toBe(failure);
    expect(turn.outcome).toBe("persistence_failed");
    expect(failure.operation).toBe("tool_checkpoint");
  });

  it("gives established unknown outcome precedence over cancellation during checkpoint", async () => {
    const { turn, controller } = harness({
      executeTool: async (value) => {
        value.state = "failed";
        value.result = { success: false, error: { code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN", message: "unknown" } };
      },
      commitToolCheckpoint: async () => { controller.abort(); },
    });
    await turn.run(user);
    expect(turn.outcome).toBe("tool_outcome_unknown");
  });

  it("cancels after a normal checkpoint when cancellation arrives during persistence", async () => {
    const { turn, controller, effects } = harness({ commitToolCheckpoint: async () => { controller.abort(); } });
    const continuation = jest.spyOn(effects, "runContinuationStream");
    await turn.run(user);
    expect(turn.outcome).toBe("cancelled");
    expect(continuation).not.toHaveBeenCalled();
  });

  it("keeps a durable checkpoint when Pi sync/render fails", async () => {
    const { turn, order } = harness({ renderToolCheckpoint: async () => { order.push("pi-sync-failed"); } });
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(order.indexOf("checkpoint")).toBeLessThan(order.indexOf("pi-sync-failed"));
  });

  it("retries empty continuations and then completes", async () => {
    let attempts = 0;
    const { turn } = harness({ runContinuationStream: async () => ++attempts < 3 ? stream(message([], `empty-${attempts}`), "empty") : stream(message([], "done", "ok")) });
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(attempts).toBe(3);
  });

  it("terminates through the reducer when empty continuation retries are exhausted", async () => {
    const failure = new Error("empty exhausted");
    const { turn } = harness({
      runContinuationStream: async () => stream(message([], "empty"), "empty"),
      onContinuationRetryExhausted: () => { throw failure; },
    });
    await expect(turn.run(user)).rejects.toBe(failure);
    expect(turn.outcome).toBe("retry_exhausted");
  });

  it("terminates through the reducer at maximum continuation depth", async () => {
    const failure = new Error("max depth");
    const { turn } = harness({
      runContinuationStream: async (_retry, _signal, previous) => stream(message([tool(`next-${previous.message_id}`)], `${previous.message_id}-next`)),
      onMaxContinuationDepth: () => { throw failure; },
    });
    await expect(turn.run(user)).rejects.toBe(failure);
    expect(turn.outcome).toBe("transport_failed");
  });

  it("returns the same running promise for repeated run calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { turn } = harness({ commitUser: async () => gate });
    const first = turn.run(user);
    const second = turn.run(user);
    expect(second).toBe(first);
    release();
    await first;
  });
});
