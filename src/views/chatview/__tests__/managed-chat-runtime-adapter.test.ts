import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient, type PlatformRequestInput } from "../../../services/PlatformRequestClient";
import { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type { AcceptedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";
import { HostedTransportAdapter } from "../../../services/managed/adapters/HostedTransportAdapter";
import { createAcceptedChatRequestSnapshot } from "../../../services/chat/AcceptedChatRequestSnapshot";
import { ManagedChatRuntimeAdapter, managedChatOperationKey, type ManagedChatRuntimeEvent } from "../turn/ManagedChatRuntimeAdapter";

class QueueClient extends PlatformRequestClient {
  inputs: PlatformRequestInput[] = [];
  responses: Response[] = [];
  override async request(input: PlatformRequestInput): Promise<Response> { this.inputs.push(input); return this.responses.shift()!; }
}
const bytes = (text: string) => new TextEncoder().encode(text);
const response = (wire: string, status = 200) => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes(wire)); c.close(); } }), { status });
async function collect(events: AsyncIterable<ManagedChatRuntimeEvent>) { const result = []; for await (const event of events) result.push(event); return result; }

function setup() {
  const requestClient = new QueueClient();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "5.11.0", licenseKey: () => "key", requestClient });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "hello", message_id: "u1" } as const);
  const durable = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  const operation = Object.freeze({ lease, durableTurnId: "turn-017b-vector", acceptedUserMessage: message, initialDurableSnapshot: durable, turnBoundaryId: "b" }) as AcceptedChatOperation;
  const acceptedRequestSnapshot = createAcceptedChatRequestSnapshot({
    operation,
    preparation: { prepared: { modelSource: "systemsculpt", resolvedModel: {} as never, actualModelId: "ai-agent", preparedMessages: [message], finalSystemPrompt: "", tools: [] }, notices: [], diagnostics: [] },
    policy: { prompt: "none", contextCount: 0, imageContextIncluded: true, documentContextIncluded: false, tools: "omitted" },
  });
  return { requestClient, adapter: new ManagedChatRuntimeAdapter(client), operation, acceptedRequestSnapshot };
}

describe("ManagedChatRuntimeAdapter live events", () => {
  it("keeps operation-key vectors stable", async () => {
    await expect(managedChatOperationKey("turn-017b-vector", "initial", 0)).resolves.toBe("69c509a7e51c2ff3d502e7d52f14143c4873ff1b9d6c4b9b62099f7ed230a6b7");
  });

  it("consumes only the accepted snapshot and omits tool_choice", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    expect(result.kind).toBe("success");
    expect(state.requestClient.inputs[0].body).toEqual({ model: "ai-agent", stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(state.requestClient.inputs[0].body).not.toHaveProperty("tool_choice");
    if (result.kind === "success") await expect(collect(result.events)).resolves.toEqual([{ kind: "content_delta", text: "ok" }, { kind: "done" }]);
  });

  it("emits tool completion before explicit done", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
    const result = await state.adapter.dispatch({ acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    if (result.kind !== "success") throw new Error(result.kind);
    await expect(collect(result.events)).resolves.toEqual([
      { kind: "tool_call_delta", index: 0, id: "call", name: "search", arguments: '{"q":' },
      { kind: "tool_call_delta", index: 0, arguments: "1}" },
      { kind: "finish_reason", reason: "tool_calls" },
      { kind: "tool_call_completed", index: 0, id: "call", name: "search", arguments: '{"q":1}' },
      { kind: "done" },
    ]);
  });

  it("does not read response bytes until iteration and fails missing DONE during iteration", async () => {
    const state = setup();
    let pulls = 0;
    state.requestClient.responses.push(new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(bytes('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); c.close(); } })));
    const result = await state.adapter.dispatch({ acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 });
    expect(result.kind).toBe("success");
    const pullsBeforeIteration = pulls;
    await Promise.resolve();
    expect(pulls).toBe(pullsBeforeIteration);
    if (result.kind === "success") await expect(collect(result.events)).rejects.toMatchObject({ kind: "transport_failure" });
    expect(pulls).toBeGreaterThanOrEqual(pullsBeforeIteration);
  });

  it("resolves typed statuses before exposing a stream", async () => {
    const state = setup();
    state.requestClient.responses.push(new Response(JSON.stringify({ code: "operation_in_progress" }), { status: 409 }));
    await expect(state.adapter.dispatch({ acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "operation_in_progress" });
  });

  it("deduplicates dispatch identity and clears on durable terminal", async () => {
    const state = setup();
    state.requestClient.responses.push(response('data: [DONE]\n\n'));
    const input = { acceptedRequestSnapshot: state.acceptedRequestSnapshot, phase: "initial" as const, continuationIndex: 0 };
    const first = state.adapter.dispatch(input);
    expect(state.adapter.dispatch(input)).toBe(first);
    await first;
    expect(state.adapter.hasRetainedEntries(state.operation)).toBe(true);
    state.adapter.notifyDurablyTerminal(state.operation);
    expect(state.adapter.hasRetainedEntries(state.operation)).toBe(false);
  });
});
