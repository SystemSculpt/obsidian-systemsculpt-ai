/** @jest-environment jsdom */

import type { ChatMessage } from "../../../types";
import type { AcceptedChatOperation } from "../../../services/managed/ManagedTypes";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";
import {
  ChatTurn,
  ChatTurnTerminalFence,
  durableContinuationIndex,
} from "../turn/ChatTurn";

const user = { role: "user", content: "hello", message_id: "turn-1" } as ChatMessage;
const durable = Object.freeze({ chatId: "chat", version: 1, messages: Object.freeze([user]) });
const operation = Object.freeze({
  lease: {} as never,
  durableTurnId: "turn-1",
  acceptedUserMessage: user,
  initialDurableSnapshot: durable,
  turnBoundaryId: "boundary",
}) as AcceptedChatOperation;

function assistant(id: string, calls: number): ChatMessage {
  return {
    role: "assistant",
    content: calls ? "" : "done",
    message_id: id,
    tool_calls: Array.from({ length: calls }, (_, index) => ({ id: `${id}-${index}` })) as never,
  } as ChatMessage;
}

function streamed(message: ChatMessage, completionState = "completed"): any {
  return { message, messageId: message.message_id, messageEl: document.createElement("div"), completionState };
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length === 0; attempt += 1) await Promise.resolve();
  expect(mock).toHaveBeenCalled();
}

describe("ChatTurn terminal fence", () => {
  it("atomically awards one terminal winner for the accepted operation", () => {
    const emissions: string[] = [];
    const fence = new ChatTurnTerminalFence(operation, (outcome) => emissions.push(outcome));
    expect(fence.isOpen(operation)).toBe(true);
    expect(fence.claimTerminal("completed")).toBe(true);
    expect(fence.claimTerminal("cancelled")).toBe(false);
    expect(fence.isOpen(operation)).toBe(false);
    expect(emissions).toEqual(["completed"]);
  });

  it("suppresses assistant persistence when abort wins while waiting for transport", async () => {
    const abort = new AbortController();
    let release!: (result: any) => void;
    const terminal = jest.fn();
    const commitAssistant = jest.fn();
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant,
      runInitialStream: () => new Promise((resolve) => { release = resolve; }),
      shouldContinueTools: () => false,
      requestToolApproval: jest.fn(),
      executeTool: jest.fn(),
      commitToolCheckpoint: jest.fn(),
      renderToolCheckpoint: jest.fn(),
      runContinuationStream: jest.fn(),
      onTerminal: terminal,
    });

    const running = turn.run(user);
    abort.abort();
    release({ completionState: "completed", message: assistant("late", 0) });
    await running;

    expect(turn.outcome).toBe("cancelled");
    expect(commitAssistant).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith("cancelled", operation);
  });

  it("starts no later effect when abort arrives during assistant persistence", async () => {
    const abort = new AbortController();
    let releaseCommit!: () => void;
    const commitAssistant = jest.fn(() => new Promise<void>((resolve) => { releaseCommit = resolve; }));
    const requestToolApproval = jest.fn().mockResolvedValue(true);
    const terminal = jest.fn();
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant,
      runInitialStream: async () => streamed(assistant("checkpoint", 1)),
      shouldContinueTools: () => true,
      requestToolApproval,
      executeTool: jest.fn(),
      commitToolCheckpoint: jest.fn(),
      renderToolCheckpoint: jest.fn(),
      runContinuationStream: jest.fn(),
      onTerminal: terminal,
    });
    const running = turn.run(user);
    await waitForCall(commitAssistant);
    abort.abort();
    releaseCommit();
    await running;
    expect(turn.outcome).toBe("cancelled");
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it("starts no checkpoint or continuation when abort arrives during tool execution", async () => {
    const abort = new AbortController();
    let releaseTool!: () => void;
    const executeTool = jest.fn(() => new Promise<void>((resolve) => { releaseTool = resolve; }));
    const commitToolCheckpoint = jest.fn();
    const runContinuationStream = jest.fn();
    const terminal = jest.fn();
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant: jest.fn().mockResolvedValue(undefined),
      runInitialStream: async () => streamed(assistant("checkpoint", 1)),
      shouldContinueTools: () => true,
      requestToolApproval: jest.fn().mockResolvedValue(true),
      executeTool,
      commitToolCheckpoint,
      renderToolCheckpoint: jest.fn(),
      runContinuationStream,
      onTerminal: terminal,
    });
    const running = turn.run(user);
    await waitForCall(executeTool);
    abort.abort();
    releaseTool();
    await running;
    expect(turn.outcome).toBe("cancelled");
    expect(commitToolCheckpoint).not.toHaveBeenCalled();
    expect(runContinuationStream).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it("does not read or render after abort arrives during a checkpoint commit", async () => {
    const abort = new AbortController();
    let releaseCheckpoint!: () => void;
    const commitToolCheckpoint = jest.fn(() => new Promise<void>((resolve) => { releaseCheckpoint = resolve; }));
    const readDurableSnapshot = jest.fn();
    const renderToolCheckpoint = jest.fn();
    const runContinuationStream = jest.fn();
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant: jest.fn().mockResolvedValue(undefined),
      runInitialStream: async () => streamed(assistant("checkpoint", 1)),
      shouldContinueTools: () => true,
      requestToolApproval: jest.fn().mockResolvedValue(true),
      executeTool: jest.fn(async (call) => { call.state = "completed"; }),
      commitToolCheckpoint,
      readDurableSnapshot,
      renderToolCheckpoint,
      runContinuationStream,
    });
    const running = turn.run(user);
    await waitForCall(commitToolCheckpoint);
    abort.abort();
    releaseCheckpoint();
    await running;
    expect(turn.outcome).toBe("cancelled");
    expect(readDurableSnapshot).not.toHaveBeenCalled();
    expect(renderToolCheckpoint).not.toHaveBeenCalled();
    expect(runContinuationStream).not.toHaveBeenCalled();
  });

  it("does not render or continue after abort wins during the post-checkpoint snapshot read", async () => {
    const abort = new AbortController();
    let releaseSnapshot!: (snapshot: ChatTranscriptSnapshot) => void;
    const readDurableSnapshot = jest.fn(() => new Promise<ChatTranscriptSnapshot>((resolve) => { releaseSnapshot = resolve; }));
    const renderToolCheckpoint = jest.fn();
    const runContinuationStream = jest.fn();
    const checkpoint = assistant("checkpoint", 1);
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant: jest.fn().mockResolvedValue(undefined),
      runInitialStream: async () => streamed(checkpoint),
      shouldContinueTools: () => true,
      requestToolApproval: jest.fn().mockResolvedValue(true),
      executeTool: jest.fn(async (call) => { call.state = "completed"; }),
      commitToolCheckpoint: jest.fn().mockResolvedValue(undefined),
      readDurableSnapshot,
      renderToolCheckpoint,
      runContinuationStream,
    });
    const running = turn.run(user);
    await waitForCall(readDurableSnapshot);
    abort.abort();
    releaseSnapshot({ chatId: "chat", version: 2, messages: [user, checkpoint] });
    await running;
    expect(turn.outcome).toBe("cancelled");
    expect(renderToolCheckpoint).not.toHaveBeenCalled();
    expect(runContinuationStream).not.toHaveBeenCalled();
  });

  it("keeps a typed-409 terminal win when a later abort reaches ChatTurn", async () => {
    const abort = new AbortController();
    const terminal = jest.fn();
    const conflict = new Error("managed 409 recovered");
    const turn = new ChatTurn({
      signal: abort.signal,
      acceptedOperation: operation,
      commitAssistant: jest.fn(),
      runInitialStream: async (_accepted, _retry, _signal, fence) => {
        expect(fence.claimTerminal("transport_failed")).toBe(true);
        abort.abort();
        throw conflict;
      },
      shouldContinueTools: () => false,
      requestToolApproval: jest.fn(),
      executeTool: jest.fn(),
      commitToolCheckpoint: jest.fn(),
      renderToolCheckpoint: jest.fn(),
      runContinuationStream: jest.fn(),
      onTerminal: terminal,
    });
    await expect(turn.run(user)).rejects.toBe(conflict);
    expect(turn.outcome).toBe("transport_failed");
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith("transport_failed", operation);
  });
});

describe("durable managed continuation identity", () => {
  it("derives zero then one from committed assistant checkpoints, not tool cardinality", () => {
    const first = assistant("checkpoint-1", 2);
    const second = assistant("checkpoint-2", 1);
    const firstSnapshot = Object.freeze({
      chatId: "chat",
      version: 2,
      messages: Object.freeze([user, first]),
    }) as ChatTranscriptSnapshot;
    const secondSnapshot = Object.freeze({
      chatId: "chat",
      version: 3,
      messages: Object.freeze([user, first, second]),
    }) as ChatTranscriptSnapshot;

    expect(durableContinuationIndex(operation, firstSnapshot, "checkpoint-1")).toBe(0);
    expect(durableContinuationIndex(operation, secondSnapshot, "checkpoint-2")).toBe(1);
    expect(durableContinuationIndex(operation, secondSnapshot, "checkpoint-2")).toBe(1);
  });

  it("rejects snapshots that do not contain the accepted turn or committed checkpoint", () => {
    expect(() => durableContinuationIndex(operation, {
      chatId: "chat",
      version: 2,
      messages: [assistant("checkpoint", 1)],
    }, "checkpoint")).toThrow("accepted turn");
    expect(() => durableContinuationIndex(operation, durable, "missing")).toThrow("checkpoint");
  });

  it("stops indexing at the next durable user turn", () => {
    const first = assistant("checkpoint-1", 1);
    const laterUser = { role: "user", content: "later", message_id: "turn-2" } as ChatMessage;
    const laterCheckpoint = assistant("checkpoint-later", 1);
    const snapshot = {
      chatId: "chat",
      version: 4,
      messages: [user, first, laterUser, laterCheckpoint],
    } as ChatTranscriptSnapshot;
    expect(durableContinuationIndex(operation, snapshot, "checkpoint-1")).toBe(0);
    expect(() => durableContinuationIndex(operation, snapshot, "checkpoint-later")).toThrow("committed checkpoint");
  });

  it("keeps durable continuation ordinals stable across unrelated retry and reducer rounds", async () => {
    const first = assistant("checkpoint-1", 2);
    const second = assistant("checkpoint-2", 1);
    const final = assistant("final", 0);
    const firstSnapshot = { chatId: "chat", version: 2, messages: [user, first] } as ChatTranscriptSnapshot;
    const secondSnapshot = { chatId: "chat", version: 3, messages: [user, first, second] } as ChatTranscriptSnapshot;
    const snapshots = [firstSnapshot, secondSnapshot];
    const continuations = [
      streamed(assistant("empty", 0), "empty"),
      streamed(second),
      streamed(final),
    ];
    const runContinuationStream = jest.fn(async () => continuations.shift());
    const turn = new ChatTurn({
      signal: new AbortController().signal,
      acceptedOperation: operation,
      commitAssistant: jest.fn().mockResolvedValue(undefined),
      runInitialStream: async () => streamed(first),
      shouldContinueTools: (result) => (result.message.tool_calls?.length ?? 0) > 0,
      requestToolApproval: jest.fn().mockResolvedValue(true),
      executeTool: jest.fn(async (call) => { call.state = "completed"; }),
      commitToolCheckpoint: jest.fn().mockResolvedValue(undefined),
      readDurableSnapshot: jest.fn(async () => snapshots.shift()!),
      renderToolCheckpoint: jest.fn().mockResolvedValue(undefined),
      runContinuationStream,
      retryEmptyStream: true,
    });
    await turn.run(user);
    expect(turn.outcome).toBe("completed");
    expect(runContinuationStream.mock.calls.map((call) => [call[1], call[5]])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(runContinuationStream.mock.calls[0]?.[4]).toBe(firstSnapshot);
    expect(runContinuationStream.mock.calls[2]?.[4]).toBe(secondSnapshot);
  });
});
