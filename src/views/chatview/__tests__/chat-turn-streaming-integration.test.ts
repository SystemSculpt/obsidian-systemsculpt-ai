/**
 * @jest-environment jsdom
 */

import { ChatTurn } from "../turn/ChatTurn";
import type { ChatMessage } from "../../../types";

const user = { role: "user", content: "hello", message_id: "user-1" } as ChatMessage;
const assistant = (content = "answer", toolCount = 0) => ({
  role: "assistant",
  content,
  message_id: "assistant-1",
  tool_calls: Array.from({ length: toolCount }, (_, index) => ({ id: `tool-${index}` })),
}) as ChatMessage;

function harness(streamResults: any[]) {
  const order: string[] = [];
  const commitUser = jest.fn(async () => { order.push("user"); });
  const commitAssistant = jest.fn(async () => { order.push("assistant"); });
  const runInitialStream = jest.fn(async () => streamResults.shift());
  const turn = new ChatTurn({
    signal: new AbortController().signal,
    commitUser,
    commitAssistant,
    runInitialStream,
    shouldContinueTools: () => false,
    requestToolApproval: jest.fn(),
    executeTool: jest.fn(),
    commitToolCheckpoint: jest.fn(),
    renderToolCheckpoint: jest.fn(),
    runContinuationStream: jest.fn(),
  });
  return { turn, order, commitUser, commitAssistant, runInitialStream };
}

describe("ChatTurn initial streaming migration", () => {
  test("durably commits the user before streaming and the assistant before terminal completion", async () => {
    const h = harness([{ completionState: "completed", message: assistant() }]);
    await h.turn.run(user);
    expect(h.order).toEqual(["user", "assistant"]);
    expect(h.runInitialStream).toHaveBeenCalledWith(0, h.turn.signal);
  });

  test("retries empty and reasoning-only initial output without committing an assistant", async () => {
    const h = harness([
      { completionState: "empty", message: assistant("") },
      { completionState: "reasoning_only", message: assistant("") },
      { completionState: "completed", message: assistant("recovered") },
    ]);
    await h.turn.run(user);
    expect(h.runInitialStream).toHaveBeenCalledTimes(3);
    expect(h.commitAssistant).toHaveBeenCalledTimes(1);
    expect(h.commitAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: "recovered" }));
  });

  test("completes a no-tool answer", async () => {
    const h = harness([{ completionState: "completed", message: assistant() }]);
    await h.turn.run(user);
    expect(h.turn.outcome).toBe("completed");
  });

  test("settles cancellation with the supplied lifecycle signal and no second abort owner", async () => {
    const controller = new AbortController();
    controller.abort();
    const commitUser = jest.fn();
    const turn = new ChatTurn({
      signal: controller.signal,
      commitUser,
      commitAssistant: jest.fn(),
      runInitialStream: jest.fn(),
      shouldContinueTools: jest.fn(),
      requestToolApproval: jest.fn(),
      executeTool: jest.fn(),
      commitToolCheckpoint: jest.fn(),
      renderToolCheckpoint: jest.fn(),
      runContinuationStream: jest.fn(),
    });
    await turn.run(user);
    expect(commitUser).not.toHaveBeenCalled();
    expect(turn.signal).toBe(controller.signal);
    expect(turn.outcome).toBe("cancelled");
  });

  test("maps user and assistant persistence rejection to persistence_failed", async () => {
    const userFailure = harness([]);
    userFailure.commitUser.mockRejectedValueOnce(new Error("disk"));
    await expect(userFailure.turn.run(user)).rejects.toThrow("disk");
    expect(userFailure.turn.outcome).toBe("persistence_failed");

    const assistantFailure = harness([{ completionState: "completed", message: assistant() }]);
    assistantFailure.commitAssistant.mockRejectedValueOnce(new Error("disk"));
    await expect(assistantFailure.turn.run(user)).rejects.toThrow("disk");
    expect(assistantFailure.turn.outcome).toBe("persistence_failed");
  });

  test("late duplicate terminal execution is idempotent", async () => {
    const h = harness([{ completionState: "completed", message: assistant() }]);
    await h.turn.run(user);
    await h.turn.run(user);
    expect(h.commitUser).toHaveBeenCalledTimes(1);
    expect(h.commitAssistant).toHaveBeenCalledTimes(1);
  });
});
