import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient, type PlatformRequestInput } from "../../../services/PlatformRequestClient";
import { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";
import { HostedTransportAdapter } from "../../../services/managed/adapters/HostedTransportAdapter";
import {
  createAcceptedManagedChatRequestSnapshot,
  managedToolsetFingerprint,
} from "../../../services/chat/AcceptedChatRequestSnapshot";
import { ManagedChatRuntimeAdapter, managedChatOperationKey, type ManagedChatRuntimeEvent } from "../turn/ManagedChatRuntimeAdapter";
import type { ManagedChatSessionBinding } from "../storage/ChatPersistenceTypes";

class QueueClient extends PlatformRequestClient {
  inputs: PlatformRequestInput[] = [];
  responses: Response[] = [];
  override async request(input: PlatformRequestInput): Promise<Response> { this.inputs.push(input); return this.responses.shift()!; }
}
const bytes = (text: string) => new TextEncoder().encode(text);
const SESSION_ID = "mchat_0123456789abcdef0123456789abcdef";
const sessionCheckpoint = (revision = 1) => ({
  kind: "session_committed" as const,
  checkpoint: { id: SESSION_ID, revision },
});
const sessionFrame = (revision = 1) => `data: ${JSON.stringify({
  object: "systemsculpt.chat.session",
  session_id: SESSION_ID,
  revision,
  state: "committed",
})}\n\n`;
const sessionHeaders = (revision = 1) => new Headers({
  "x-systemsculpt-session-id": SESSION_ID,
  "x-systemsculpt-session-revision": String(revision),
});
const rawResponse = (wire: string, revision = 1) => new Response(
  new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes(wire)); controller.close(); } }),
  { status: 200, headers: sessionHeaders(revision) },
);
const response = (wire: string, revision = 1) => rawResponse(
  wire.includes('"object":"systemsculpt.chat.session"')
    ? wire
    : wire.replace("data: [DONE]", `${sessionFrame(revision)}data: [DONE]`),
  revision,
);
async function collect(events: AsyncIterable<ManagedChatRuntimeEvent>) { const result = []; for await (const event of events) result.push(event); return result; }

const EMPTY_TOOLSET_FINGERPRINT = managedToolsetFingerprint([]);
const DEFAULT_SESSION_BUDGET: ManagedChatSessionBinding["budget"] = Object.freeze({
  messageCount: 1,
  imageCount: 0,
  attachmentBytes: 0,
  storedJsonBytes: 128,
});
type TestSessionBinding = Omit<ManagedChatSessionBinding, "budget"> & Readonly<{
  budget?: ManagedChatSessionBinding["budget"];
}>;

function setup(
  webSearch = false,
  initialBinding?: TestSessionBinding,
  includeBindingAnchor = true,
  limitOverrides?: Readonly<Record<string, string | number | boolean>>,
) {
  const requestClient = new QueueClient();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "5.11.0", licenseKey: () => "key", requestClient });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const fixtureDescriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const descriptor = limitOverrides
    ? { ...fixtureDescriptor, limits: { ...fixtureDescriptor.limits, ...limitOverrides } }
    : fixtureDescriptor;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "hello", message_id: "turn-017b-vector" } as const);
  const priorAssistant = initialBinding && includeBindingAnchor
    ? Object.freeze({
        role: "assistant" as const,
        content: "prior answer",
        message_id: initialBinding.checkpointMessageId,
      })
    : undefined;
  const durable = Object.freeze({
    chatId: "c",
    version: 1,
    messages: Object.freeze([...(priorAssistant ? [priorAssistant] : []), message]),
  });
  const operation = Object.freeze({ runtime: "managed", lease, durableTurnId: "turn-017b-vector", acceptedUserMessage: message, initialDurableSnapshot: durable, turnBoundaryId: "b" }) as AcceptedManagedChatOperation;
  const acceptedRequestSnapshot = createAcceptedManagedChatRequestSnapshot({
    operation,
    policy: { contextCount: 0, imageContextIncluded: true, documentContextIncluded: false, tools: "omitted" },
    managedMessages: durable.messages,
    managedTools: [],
    webSearch,
  });
  let binding: ManagedChatSessionBinding | undefined = initialBinding
    ? Object.freeze({ ...initialBinding, budget: initialBinding.budget ?? DEFAULT_SESSION_BUDGET })
    : undefined;
  let invalidations = 0;
  const adapter = new ManagedChatRuntimeAdapter(client, {
    get: () => binding,
    invalidate: async () => {
      invalidations += 1;
      binding = undefined;
    },
  });
  return {
    requestClient,
    adapter,
    operation,
    acceptedRequestSnapshot,
    setBinding: (next: ManagedChatSessionBinding | undefined) => { binding = next; },
    invalidations: () => invalidations,
  };
}

describe("ManagedChatRuntimeAdapter live events", () => {
  it("keeps operation-key vectors stable", async () => {
    await expect(managedChatOperationKey("turn-017b-vector", "initial", 0)).resolves.toBe("324aa1a9a04566bf5f7f988a889c2777c6e2bad40dfe8b6f26d9413a91c83c6f");
  });

  it("consumes only the accepted snapshot and omits tool_choice", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    expect(result.kind).toBe("success");
    expect(state.requestClient.inputs[0].body).toEqual({
      model: "ai-agent",
      stream: true,
      session: { mode: "create" },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(state.requestClient.inputs[0].body).not.toHaveProperty("tool_choice");
    if (result.kind === "success") await expect(collect(result.events)).resolves.toEqual([
      { kind: "content_delta", text: "ok" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
  });

  it("streams only first-party reasoning summaries and consumes canonical usage totals", async () => {
    const state = setup();
    state.requestClient.responses.push(response([
      'data: {"choices":[{"delta":{"reasoning_summary":"Checked the relevant vault context."}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":5}}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join("\n")));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "reasoning_summary_delta", text: "Checked the relevant vault context." },
      { kind: "content_delta", text: "ok" },
      { kind: "finish_reason", reason: "stop" },
      { kind: "usage", promptTokens: 3, completionTokens: 7, reasoningTokens: 5, totalTokens: 10 },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
  });

  it("replays a retryable in-stream finalization failure with the same operation key", async () => {
    const state = setup();
    state.requestClient.responses.push(rawResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      "",
      `data: ${JSON.stringify({ error: {
        code: "managed_stream_failed",
        message: "Managed chat stream failed.",
        session_id: SESSION_ID,
        current_revision: 0,
        retry_same_idempotency_key: true,
      } })}`,
      "",
      "",
    ].join("\n")));
    state.requestClient.responses.push(response(
      'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
    ));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "phase_restarted", attempt: 1 },
      { kind: "content_delta", text: "recovered" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
    expect(state.requestClient.inputs).toHaveLength(2);
    expect(state.requestClient.inputs[1].body).toEqual(state.requestClient.inputs[0].body);
    expect(state.requestClient.inputs[1].headers?.["Idempotency-Key"])
      .toBe(state.requestClient.inputs[0].headers?.["Idempotency-Key"]);
  });

  it("bounds same-key recovery and preserves a non-retryable stream error code", async () => {
    const state = setup();
    state.requestClient.responses.push(rawResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      "",
      `data: ${JSON.stringify({ error: {
        code: "managed_stream_failed",
        message: "Managed chat stream failed.",
        retry_same_idempotency_key: false,
      } })}`,
      "",
      "",
    ].join("\n")));
    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).rejects.toMatchObject({
      kind: "transport_failure",
      diagnostic: { code: "managed_stream_failed" },
    });
    expect(state.requestClient.inputs).toHaveLength(1);
  });

  it("recovers a retryable HTTP finalization response with the same operation key", async () => {
    const state = setup();
    state.requestClient.responses.push(new Response(JSON.stringify({ error: {
      code: "session_finalization_failed",
      message: "The managed chat turn is awaiting durable finalization.",
      session_id: SESSION_ID,
      current_revision: 0,
      retry_same_idempotency_key: true,
    } }), { status: 503, headers: sessionHeaders(0) }));
    state.requestClient.responses.push(response(
      'data: {"choices":[{"delta":{"content":"replayed"}}]}\n\ndata: [DONE]\n\n',
    ));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "phase_restarted", attempt: 1 },
      { kind: "content_delta", text: "replayed" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
    expect(state.requestClient.inputs).toHaveLength(2);
    expect(state.requestClient.inputs[1].headers?.["Idempotency-Key"])
      .toBe(state.requestClient.inputs[0].headers?.["Idempotency-Key"]);
  });

  it("dispatches managed web search through the accepted request snapshot", async () => {
    const state = setup(true);
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    expect(result.kind).toBe("success");
    expect(state.requestClient.inputs[0].body).toEqual({
      model: "ai-agent",
      stream: true,
      session: { mode: "create" },
      messages: [{ role: "user", content: "hello" }],
      plugins: [{ id: "web" }],
    });
    if (result.kind === "success") await expect(collect(result.events)).resolves.toEqual([
      { kind: "content_delta", text: "ok" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
  });

  it("resumes a bound server session with only the accepted turn delta", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    });
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', 3));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });

    expect(state.requestClient.inputs[0].body).toEqual({
      model: "ai-agent",
      stream: true,
      session: { id: SESSION_ID, revision: 2 },
      messages: [{ role: "user", content: "hello" }],
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "content_delta", text: "ok" },
      sessionCheckpoint(3),
      { kind: "done" },
    ]);
  });

  it("durably invalidates a stale transcript anchor or tool contract before creating", async () => {
    const staleAnchor = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "missing-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    }, false);
    staleAnchor.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));

    const staleResult = await staleAnchor.adapter.dispatch({
      operation: staleAnchor.operation,
      acceptedRequestSnapshot: staleAnchor.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });

    expect(staleAnchor.invalidations()).toBe(1);
    expect(staleAnchor.requestClient.inputs[0].body).toMatchObject({ session: { mode: "create" } });
    if (staleResult.kind !== "success") throw new Error(staleResult.kind);
    await expect(collect(staleResult.events)).resolves.toContainEqual(sessionCheckpoint());

    const staleTools = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: "1:0:0",
    });
    staleTools.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    const toolsResult = await staleTools.adapter.dispatch({
      operation: staleTools.operation,
      acceptedRequestSnapshot: staleTools.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    expect(staleTools.invalidations()).toBe(1);
    expect(staleTools.requestClient.inputs[0].body).toMatchObject({ session: { mode: "create" } });
    if (toolsResult.kind !== "success") throw new Error(toolsResult.kind);
    await expect(collect(toolsResult.events)).resolves.toContainEqual(sessionCheckpoint());

    const budgetless = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    });
    budgetless.setBinding({
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    } as ManagedChatSessionBinding);
    budgetless.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    const budgetlessResult = await budgetless.adapter.dispatch({
      operation: budgetless.operation,
      acceptedRequestSnapshot: budgetless.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    expect(budgetless.invalidations()).toBe(1);
    expect(budgetless.requestClient.inputs[0].body).toMatchObject({ session: { mode: "create" } });
    expect(budgetlessResult.kind).toBe("success");
  });

  it("sends only the newest tool-result batch for a continuation", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 3,
      boundChatId: "c",
      checkpointMessageId: "assistant-1",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    }, false);
    const continuation = Object.freeze({
      chatId: "c",
      version: 3,
      backend: "systemsculpt" as const,
      messages: Object.freeze([
        ...state.operation.initialDurableSnapshot.messages,
        {
          role: "assistant" as const,
          content: "",
          message_id: "assistant-1",
          tool_calls: [{
            id: "call-1",
            messageId: "assistant-1",
            request: {
              id: "call-1",
              type: "function" as const,
              function: { name: "read", arguments: "{}" },
            },
            state: "completed" as const,
            timestamp: 1,
            result: { success: true, data: { success: true } },
          }],
        },
      ]),
    });
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', 4));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "continuation",
      continuationIndex: 0,
      postCheckpointDurableSnapshot: continuation,
    });

    expect(state.requestClient.inputs[0].body).toEqual({
      model: "ai-agent",
      stream: true,
      session: { id: SESSION_ID, revision: 3 },
      messages: [{ role: "tool", content: '{"success":true}', tool_call_id: "call-1", name: "read" }],
    });
    expect(state.requestClient.inputs[0].body).not.toHaveProperty("plugins");
    expect(state.requestClient.inputs[0].body).not.toHaveProperty("tools");
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toContainEqual(sessionCheckpoint(4));
  });

  it("invalidates a rejected session and rebases once from the full accepted snapshot", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 7,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    });
    state.requestClient.responses.push(new Response(JSON.stringify({
      error: { code: "session_revision_conflict", message: "stale", current_revision: 8 },
    }), { status: 409 }));
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"rebased"}}]}\n\ndata: [DONE]\n\n'));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });

    expect(state.invalidations()).toBe(1);
    expect(state.requestClient.inputs).toHaveLength(2);
    expect(state.requestClient.inputs[0].body).toMatchObject({ session: { id: SESSION_ID, revision: 7 } });
    expect(state.requestClient.inputs[1].body).toEqual({
      model: "ai-agent",
      stream: true,
      session: { mode: "create" },
      messages: [
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "hello" },
      ],
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toContainEqual(sessionCheckpoint());
  });

  it("emits tool completion before explicit done", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "tool_call_delta", index: 0, id: "call", name: "search", arguments: '{"q":' },
      { kind: "tool_call_delta", index: 0, arguments: "1}" },
      { kind: "finish_reason", reason: "tool_calls" },
      sessionCheckpoint(),
      { kind: "tool_call_completed", index: 0, id: "call", name: "search", arguments: '{"q":1}' },
      { kind: "done" },
    ]);
  });

  it("does not read response bytes until iteration and recovers a missing DONE with the same operation", async () => {
    const state = setup();
    let pulls = 0;
    state.requestClient.responses.push(new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(bytes('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); c.close(); } }), { headers: sessionHeaders() }));
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"replayed"}}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    expect(result.kind).toBe("success");
    const pullsBeforeIteration = pulls;
    await Promise.resolve();
    expect(pulls).toBe(pullsBeforeIteration);
    if (result.kind === "success") await expect(collect(result.events)).resolves.toEqual([
      { kind: "content_delta", text: "x" },
      { kind: "phase_restarted", attempt: 1 },
      { kind: "content_delta", text: "replayed" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
    expect(pulls).toBeGreaterThanOrEqual(pullsBeforeIteration);
    expect(state.requestClient.inputs).toHaveLength(2);
    expect(state.requestClient.inputs[1].body).toEqual(state.requestClient.inputs[0].body);
    expect(state.requestClient.inputs[1].headers?.["Idempotency-Key"])
      .toBe(state.requestClient.inputs[0].headers?.["Idempotency-Key"]);
  });

  it("polls an in-progress server-owned turn and replays it without changing the operation", async () => {
    const state = setup();
    state.requestClient.responses.push(rawResponse(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    ));
    state.requestClient.responses.push(new Response(JSON.stringify({ error: {
      code: "operation_in_progress",
      message: "Operation is already running.",
    } }), {
      status: 409,
      headers: { "content-type": "application/json", "retry-after": "0" },
    }));
    state.requestClient.responses.push(response(
      'data: {"choices":[{"delta":{"content":"committed"}}]}\n\ndata: [DONE]\n\n',
    ));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "content_delta", text: "partial" },
      { kind: "phase_restarted", attempt: 1 },
      { kind: "content_delta", text: "committed" },
      sessionCheckpoint(),
      { kind: "done" },
    ]);
    expect(state.requestClient.inputs).toHaveLength(3);
    for (const input of state.requestClient.inputs.slice(1)) {
      expect(input.body).toEqual(state.requestClient.inputs[0].body);
      expect(input.headers?.["Idempotency-Key"])
        .toBe(state.requestClient.inputs[0].headers?.["Idempotency-Key"]);
    }
  });

  it("cancels the reader before releasing its lock when the consumer returns early", async () => {
    const state = setup();
    const effects: string[] = [];
    state.requestClient.responses.push(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        effects.push("read");
        controller.enqueue(bytes('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      },
      cancel() { effects.push("cancel"); },
    }), { headers: sessionHeaders() }));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    for await (const event of result.events) {
      expect(event).toEqual({ kind: "content_delta", text: "first" });
      break;
    }
    expect(effects.at(-1)).toBe("cancel");
    const readsAfterReturn = effects.filter((effect) => effect === "read").length;
    await Promise.resolve();
    expect(effects.filter((effect) => effect === "read")).toHaveLength(readsAfterReturn);
  });

  it("releases the reader lock even when early-return cancellation rejects", async () => {
    const state = setup();
    const effects: string[] = [];
    let reads = 0;
    const reader = {
      read: async () => {
        reads += 1;
        return { done: false, value: bytes('data: {"choices":[{"delta":{"content":"first"}}]}\n\n') };
      },
      cancel: async () => { effects.push("cancel"); throw new Error("cancel rejected"); },
      releaseLock: () => { effects.push("release"); },
    };
    const fakeResponse = { ok: true, status: 200, headers: sessionHeaders(), body: { getReader: () => reader } } as unknown as Response;
    state.requestClient.responses.push(fakeResponse);
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect((async () => {
      for await (const event of result.events) {
        expect(event).toEqual({ kind: "content_delta", text: "first" });
        break;
      }
    })()).rejects.toThrow("cancel rejected");
    expect(effects).toEqual(["cancel", "release"]);
    expect(reads).toBe(1);
  });

  it("returns the typed server rejection without trimming oversized prepared history", async () => {
    const state = setup();
    const large = "oversized-".repeat(20_000);
    const snapshot = { ...state.acceptedRequestSnapshot, operation: state.operation, messages: Object.freeze([{ role: "user", content: large }]) } as typeof state.acceptedRequestSnapshot;
    state.requestClient.responses.push(new Response(JSON.stringify({ error: { code: "request_too_large", message: "Request is too large." } }), { status: 400 }));
    await expect(state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({
      kind: "capability_request", diagnostic: { status: 400, code: "request_too_large" },
    });
    expect(JSON.stringify(state.requestClient.inputs[0].body)).toContain(large);
  });

  it("rejects an oversized exact request locally from the negotiated envelope", async () => {
    const state = setup(false, undefined, true, { max_request_bytes: 64 });

    await expect(state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    })).resolves.toEqual({
      kind: "capability_request",
      diagnostic: { code: "local_request_too_large" },
    });
    expect(state.requestClient.inputs).toEqual([]);
  });

  it("fails locally before transport when a full rebase exceeds the negotiated message count", async () => {
    const state = setup();
    const messages = Object.freeze(Array.from({ length: 256 }, (_, index) => Object.freeze({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}`,
    })));
    const snapshot = {
      ...state.acceptedRequestSnapshot,
      operation: state.operation,
      messages,
    } as typeof state.acceptedRequestSnapshot;

    await expect(state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: snapshot,
      phase: "initial",
      continuationIndex: 0,
    })).resolves.toEqual({
      kind: "capability_request",
      diagnostic: { code: "local_rebase_message_limit" },
    });
    expect(state.requestClient.inputs).toEqual([]);
  });

  it("rotates a bound session to a full create when its delta shape cannot fit", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    }, true, { max_messages_per_delta: 1 });
    const context = Object.freeze({ role: "user" as const, content: "context" });
    const accepted = {
      ...state.acceptedRequestSnapshot,
      operation: state.operation,
      messages: Object.freeze([
        { role: "assistant" as const, content: "prior answer" },
        context,
        { role: "user" as const, content: "hello" },
      ]),
      turnMessages: Object.freeze([context, { role: "user" as const, content: "hello" }]),
    } as typeof state.acceptedRequestSnapshot;
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: accepted,
      phase: "initial",
      continuationIndex: 0,
    });

    expect(state.invalidations()).toBe(1);
    expect(state.requestClient.inputs[0].body).toMatchObject({
      session: { mode: "create" },
      messages: accepted.messages,
    });
    expect(result.kind).toBe("success");
  });

  it("uses persisted session counters for prior injected context that is absent locally", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
      budget: {
        messageCount: 3,
        imageCount: 0,
        attachmentBytes: 0,
        storedJsonBytes: 128,
      },
    }, true, { max_session_messages: 4 });
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));

    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });

    expect(state.invalidations()).toBe(1);
    expect(state.requestClient.inputs[0].body).toMatchObject({ session: { mode: "create" } });
    expect(result.kind).toBe("success");
  });

  it("invalidates a full bound session and fails actionably when a safe rebase cannot fit", async () => {
    const state = setup(false, {
      id: SESSION_ID,
      revision: 2,
      boundChatId: "c",
      checkpointMessageId: "prior-assistant",
      toolsetFingerprint: EMPTY_TOOLSET_FINGERPRINT,
    }, true, { max_session_messages: 2 });

    await expect(state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    })).resolves.toEqual({
      kind: "capability_request",
      diagnostic: { code: "local_session_message_limit" },
    });
    expect(state.invalidations()).toBe(1);
    expect(state.requestClient.inputs).toEqual([]);
  });

  it("enforces cumulative image bytes and stored JSON before creating a session", async () => {
    const imageContent = Object.freeze([
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BAUG" } },
    ]);
    const attachmentState = setup(false, undefined, true, {
      max_session_attachment_bytes: 5,
    });
    const attachmentSnapshot = {
      ...attachmentState.acceptedRequestSnapshot,
      operation: attachmentState.operation,
      messages: Object.freeze([{ role: "user" as const, content: imageContent }]),
    } as typeof attachmentState.acceptedRequestSnapshot;

    await expect(attachmentState.adapter.dispatch({
      operation: attachmentState.operation,
      acceptedRequestSnapshot: attachmentSnapshot,
      phase: "initial",
      continuationIndex: 0,
    })).resolves.toEqual({
      kind: "capability_request",
      diagnostic: { code: "local_session_attachment_limit" },
    });
    expect(attachmentState.requestClient.inputs).toEqual([]);

    const jsonState = setup(false, undefined, true, {
      max_session_stored_json_bytes: 512,
    });
    await expect(jsonState.adapter.dispatch({
      operation: jsonState.operation,
      acceptedRequestSnapshot: jsonState.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    })).resolves.toEqual({
      kind: "capability_request",
      diagnostic: { code: "local_session_stored_json_limit" },
    });
    expect(jsonState.requestClient.inputs).toEqual([]);
  });

  it("resolves typed statuses before exposing a stream", async () => {
    const state = setup();
    state.requestClient.responses.push(new Response(JSON.stringify({ error: { code: "operation_in_progress", message: "Operation is already running." } }), { status: 409 }));
    await expect(state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "operation_in_progress" });
  });

  it("rejects private reasoning fields outside the first-party stream contract", async () => {
    const state = setup();
    state.requestClient.responses.push(response([
      'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join("\n")));
    const result = await state.adapter.dispatch({ operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).rejects.toMatchObject({ kind: "transport_failure" });
  });

  it("rejects provider reasoning details even when they contain a summary", async () => {
    const state = setup();
    state.requestClient.responses.push(response([
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"provider payload"}]}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join("\n")));
    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).rejects.toMatchObject({ kind: "transport_failure" });
  });

  it("rejects reasoning summaries that exceed the managed presentation bound", async () => {
    const state = setup();
    const half = "x".repeat(8_001);
    state.requestClient.responses.push(response([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_summary: half } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_summary: half } }] })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n")));
    const result = await state.adapter.dispatch({
      operation: state.operation,
      acceptedRequestSnapshot: state.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).rejects.toMatchObject({ kind: "transport_failure" });
  });

  it("rejects a missing or mismatched session commit frame", async () => {
    const missing = setup();
    missing.requestClient.responses.push(rawResponse(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    ));
    const missingResult = await missing.adapter.dispatch({
      operation: missing.operation,
      acceptedRequestSnapshot: missing.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (missingResult.kind !== "success") throw new Error(missingResult.kind);
    await expect(collect(missingResult.events)).rejects.toMatchObject({ kind: "transport_failure" });

    const mismatched = setup();
    mismatched.requestClient.responses.push(rawResponse(
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n${sessionFrame(2)}data: [DONE]\n\n`,
      1,
    ));
    const mismatchedResult = await mismatched.adapter.dispatch({
      operation: mismatched.operation,
      acceptedRequestSnapshot: mismatched.acceptedRequestSnapshot,
      phase: "initial",
      continuationIndex: 0,
    });
    if (mismatchedResult.kind !== "success") throw new Error(mismatchedResult.kind);
    await expect(collect(mismatchedResult.events)).rejects.toMatchObject({ kind: "transport_failure" });
  });

  it("deduplicates dispatch identity and clears on durable terminal", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: [DONE]\n\n'));
    const input = { operation: state.operation, acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial" as const, continuationIndex: 0 };
    const first = state.adapter.dispatch(input);
    expect(state.adapter.dispatch(input)).toBe(first);
    await first;
    expect(state.adapter.hasRetainedEntries(state.operation)).toBe(true);
    state.adapter.notifyDurablyTerminal(state.operation);
    expect(state.adapter.hasRetainedEntries(state.operation)).toBe(false);
  });
});
