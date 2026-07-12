/** @jest-environment jsdom */

import type { AcceptedManagedChatRequestSnapshot } from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation } from "../../../services/managed/ManagedTypes";
import {
  CurrentRuntimeAdapter,
  ManagedChatRuntimeFailure,
} from "../turn/CurrentRuntimeAdapter";
import type { ManagedChatRuntimeEvent } from "../turn/ManagedChatRuntimeAdapter";

const operation = Object.freeze({ runtime: "managed", lease: {}, durableTurnId: "turn" }) as AcceptedManagedChatOperation;
const snapshot = Object.freeze({ runtime: "managed", operation, durableTurnId: "turn" }) as AcceptedManagedChatRequestSnapshot;

async function* events(): AsyncGenerator<ManagedChatRuntimeEvent> {
  yield { kind: "content_delta", text: "hello" };
  yield { kind: "done" };
}

describe("CurrentRuntimeAdapter", () => {
  it("is an unconditional managed standard-Chat seam and preserves exact snapshot provenance", async () => {
    const managed = {
      dispatch: jest.fn().mockResolvedValue({ kind: "success", events: events(), diagnostic: { requestId: "r" } }),
      notifyDurablyTerminal: jest.fn(),
    };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    const signal = new AbortController().signal;
    const fence = { isOpen: () => true };
    const result = await runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal,
      fence,
    });

    expect(result.kind).toBe("stream");
    expect(managed.dispatch).toHaveBeenCalledWith({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal,
    });
    expect(managed.dispatch.mock.calls[0][0].acceptedRequestSnapshot).toBe(snapshot);
    expect((managed.dispatch.mock.calls[0][0] as Record<string, unknown>)).not.toHaveProperty("messages");
    expect((managed.dispatch.mock.calls[0][0] as Record<string, unknown>)).not.toHaveProperty("tools");
  });

  it("passes the exact frozen snapshot and post-checkpoint snapshot into continuation dispatch", async () => {
    const managed = {
      dispatch: jest.fn().mockResolvedValue({ kind: "success", events: events(), diagnostic: {} }),
      notifyDurablyTerminal: jest.fn(),
    };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    const postCheckpointDurableSnapshot = Object.freeze({
      chatId: "chat",
      version: 2,
      messages: Object.freeze([]),
    });
    await runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "continuation",
      continuationIndex: 1,
      postCheckpointDurableSnapshot,
      signal: new AbortController().signal,
      fence: { isOpen: () => true },
    });
    expect(managed.dispatch).toHaveBeenCalledWith({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "continuation",
      continuationIndex: 1,
      postCheckpointDurableSnapshot,
      signal: expect.any(AbortSignal),
    });
    expect(managed.dispatch.mock.calls[0][0].acceptedRequestSnapshot).toBe(snapshot);
    expect(managed.dispatch.mock.calls[0][0].postCheckpointDurableSnapshot).toBe(postCheckpointDurableSnapshot);
  });

  it("suppresses dispatch when abort has already won", async () => {
    const managed = { dispatch: jest.fn(), notifyDurablyTerminal: jest.fn() };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    const abort = new AbortController();
    abort.abort();
    const error = await runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal: abort.signal,
      fence: { isOpen: () => true },
    }).catch((caught) => caught as ManagedChatRuntimeFailure);
    expect(error).toMatchObject({ kind: "aborted" });
    expect(managed.dispatch).not.toHaveBeenCalled();
  });

  it("suppresses a late successful dispatch after local abort", async () => {
    let resolveDispatch!: (value: { kind: "success"; events: AsyncGenerator<ManagedChatRuntimeEvent>; diagnostic: {} }) => void;
    const managed = {
      dispatch: jest.fn(() => new Promise((resolve) => { resolveDispatch = resolve; })),
      notifyDurablyTerminal: jest.fn(),
    };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    const abort = new AbortController();
    const pending = runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal: abort.signal,
      fence: { isOpen: () => true },
    });
    abort.abort();
    resolveDispatch({ kind: "success", events: events(), diagnostic: {} });
    const error = await pending.catch((caught) => caught as ManagedChatRuntimeFailure);
    expect(error).toMatchObject({ kind: "aborted" });
  });

  it.each([
    "operation_in_progress",
    "operation_already_completed",
    "operation_terminal",
    "settlement_pending",
  ] as const)("returns %s before exposing a stream", async (kind) => {
    const managed = {
      dispatch: jest.fn().mockResolvedValue({ kind, diagnostic: { status: 409 } }),
      notifyDurablyTerminal: jest.fn(),
    };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    await expect(runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal: new AbortController().signal,
      fence: { isOpen: () => true },
    })).resolves.toEqual({ kind: "recovery", disposition: kind, diagnostic: { status: 409 } });
  });

  it("turns managed failures into one typed failure with no fallback", async () => {
    const managed = {
      dispatch: jest.fn().mockResolvedValue({ kind: "rate_limit", diagnostic: { status: 429 } }),
      notifyDurablyTerminal: jest.fn(),
    };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    const error = await runtime.dispatch({
      operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
      signal: new AbortController().signal,
      fence: { isOpen: () => true },
    }).catch((caught) => caught as ManagedChatRuntimeFailure);
    expect(error).toBeInstanceOf(ManagedChatRuntimeFailure);
    expect(error.kind).toBe("rate_limit");
    expect(managed.dispatch).toHaveBeenCalledTimes(1);
  });

  it("releases only the exact accepted operation at durable terminal", () => {
    const managed = { dispatch: jest.fn(), notifyDurablyTerminal: jest.fn() };
    const runtime = new CurrentRuntimeAdapter(managed as never);
    runtime.notifyDurablyTerminal(operation);
    expect(managed.notifyDurablyTerminal).toHaveBeenCalledWith(operation);
  });
});
