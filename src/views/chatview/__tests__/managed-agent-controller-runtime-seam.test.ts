import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { PlatformRequestClient, type PlatformRequestInput } from "../../../services/PlatformRequestClient";
import { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import { HostedTransportAdapter } from "../../../services/managed/adapters/HostedTransportAdapter";
import { createAcceptedManagedChatRequestSnapshot } from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";
import type { AgentTranscriptSnapshot } from "../AgentTranscriptRepository";
import {
  ManagedAgentController,
  type ManagedAgentControllerHost,
} from "../ManagedAgentController";
import { ManagedChatRuntimeAdapter } from "../turn/ManagedChatRuntimeAdapter";

// Seam tests: the controller drives the REAL ManagedChatRuntimeAdapter,
// ManagedCapabilityClient, and HostedTransportAdapter; only HTTP itself is
// queued. The mocked-runtime controller suite cannot see rejections the real
// adapter raises before HTTP (empty continuation deltas) or the exact bytes
// the server receives (which the server's transcript validation judges), and
// both have shipped production incidents that mocked suites green-lit.

jest.mock("obsidian", () => jest.requireActual("obsidian"));

class QueueClient extends PlatformRequestClient {
  inputs: PlatformRequestInput[] = [];
  responses: Response[] = [];
  override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error("Seam test received an unexpected extra HTTP request.");
    return next;
  }
}

const bytes = (text: string) => new TextEncoder().encode(text);
const SESSION_ID = "mchat_0123456789abcdef0123456789abcdef";
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
const response = (wire: string, revision = 1) => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(wire.replace("data: [DONE]", `${sessionFrame(revision)}data: [DONE]`)));
      controller.close();
    },
  }),
  { status: 200, headers: sessionHeaders(revision) },
);

const SERVER_SEARCH_TURN_WIRE = [
  'data: {"object":"systemsculpt.chat.tool_result","tool_call_id":"call_web_1","status":"succeeded","details":{"tool":"web_search","result_count":3}}',
  "",
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_web_1","function":{"name":"web_search","arguments":"{}"}}]}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"Blaxel is cloud infrastructure for AI agents."}}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const MIXED_BATCH_TURN_WIRE = [
  'data: {"object":"systemsculpt.chat.tool_result","tool_call_id":"call_web_1","status":"succeeded","details":{"tool":"web_search","result_count":3}}',
  "",
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_web_1","function":{"name":"web_search","arguments":"{}"}}]}}]}',
  "",
  'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_vault_1","function":{"name":"read","arguments":"{\\"paths\\":[\\"Notes/release.md\\"]}"}}]}}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const TEXT_TURN_WIRE = (text: string) => [
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createSeamHarness(
  executeLocalTool: (toolCall: ToolCall, signal: AbortSignal) => Promise<unknown> = async () => ({
    success: true,
    data: { path: "Notes/release.md", bytes: 12 },
  }),
) {
  const descriptor = fixture.capabilities.find((entry) => entry.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find(
    (entry) => entry.capability === "chat_turn",
  )!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;

  const requestClient = new QueueClient();
  const transport = new HostedTransportAdapter({
    baseUrl: "https://api.test",
    pluginVersion: "6.2.5",
    licenseKey: () => "key",
    requestClient,
  });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const adapter = new ManagedChatRuntimeAdapter(client, {
    get: () => undefined,
    invalidate: async () => undefined,
  });

  let version = 0;
  let messages: ChatMessage[] = [];
  const snapshot = (): AgentTranscriptSnapshot => Object.freeze({
    chatId: "chat-1",
    title: "Chat",
    version,
    backend: "systemsculpt",
    messages: Object.freeze(clone(messages)),
  });

  const host: ManagedAgentControllerHost = {
    acquireChatTurnLease: jest.fn(async () => ({ outcome: "allowed" as const, lease })),
    commitUser: jest.fn(async (input) => {
      messages.push(clone(input.message));
      version += 1;
      return snapshot();
    }),
    claimUser: jest.fn(() => true),
    prepareAcceptedRequest: jest.fn(async (operation: AcceptedManagedChatOperation) =>
      createAcceptedManagedChatRequestSnapshot({
        operation,
        policy: {
          contextCount: 0,
          imageContextIncluded: false,
          documentContextIncluded: false,
          tools: "normalized" as const,
        },
        managedMessages: operation.initialDurableSnapshot.messages,
        managedTools: [],
        webSearch: true,
      })),
    persistAssistant: jest.fn(async (message) => {
      const index = messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (index < 0) messages.push(clone(message));
      else messages[index] = clone(message);
      version += 1;
      return snapshot();
    }),
    persistAssistantWithSession: jest.fn(async (message) => {
      const index = messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (index < 0) messages.push(clone(message));
      else messages[index] = clone(message);
      version += 1;
      return snapshot();
    }),
    clearSessionCheckpoint: jest.fn(async () => undefined),
    snapshot,
    executeLocalTool: jest.fn(executeLocalTool),
    refreshCredits: jest.fn(),
    reportError: jest.fn(),
  };

  const startTurn = (id: string, content: string) => new ManagedAgentController({
    host,
    runtime: adapter,
    now: (() => {
      let now = 1_000;
      return () => ++now;
    })(),
  }).start({ commit: { kind: "append", message: { role: "user", content, message_id: id } } });

  return { requestClient, host, startTurn, transcript: snapshot };
}

function requestMessages(input: PlatformRequestInput): ReadonlyArray<Record<string, unknown>> {
  return (input.body as { messages: ReadonlyArray<Record<string, unknown>> }).messages;
}

describe("ManagedAgentController through the real runtime adapter", () => {
  it("completes a pure server-executed search turn with exactly one HTTP request", async () => {
    // Incident guard: the real adapter refuses a continuation whose delta
    // composes to zero messages. A mocked runtime accepted that dispatch and
    // shipped "This chat history could not be prepared safely." to the field.
    const harness = createSeamHarness();
    harness.requestClient.responses.push(response(SERVER_SEARCH_TURN_WIRE));

    const result = await harness.startTurn("user-1", "tldr about blaxel please");

    expect(result.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(1);
    expect(harness.host.executeLocalTool).not.toHaveBeenCalled();
    const assistant = harness.transcript().messages.at(-1)!;
    expect(assistant.content).toContain("Blaxel is cloud infrastructure");
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: "call_web_1",
      state: "completed",
      executedOn: "server",
    });
  });

  it("sends a follow-up after a search turn without the unanswerable server call", async () => {
    // Incident guard: the durable transcript keeps the server-executed call
    // but never a result row for it, and the server's transcript validation
    // requires exactly one result per call on session create/rebase. Keeping
    // the call in the projected wire made every follow-up after a search
    // fail with "SystemSculpt rejected this request." (verified against
    // production: the poisoned body 400s, the stripped body streams).
    const harness = createSeamHarness();
    harness.requestClient.responses.push(response(SERVER_SEARCH_TURN_WIRE));
    harness.requestClient.responses.push(response(TEXT_TURN_WIRE("Cloudflare and Modal, briefly.")));

    await harness.startTurn("user-1", "tldr about blaxel please");
    const followUp = await harness.startTurn("user-2", "who are its competitors?");

    expect(followUp.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(2);
    const wire = requestMessages(harness.requestClient.inputs[1]);
    expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_1");
    expect(wire[1]).not.toHaveProperty("tool_calls");
  });

  it("continues a mixed batch sending only the vault result and no server call", async () => {
    const harness = createSeamHarness();
    harness.requestClient.responses.push(response(MIXED_BATCH_TURN_WIRE));
    harness.requestClient.responses.push(response(TEXT_TURN_WIRE("Both checked.")));

    const result = await harness.startTurn("user-1", "check both");

    expect(result.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(2);
    expect(harness.host.executeLocalTool).toHaveBeenCalledTimes(1);
    const wire = requestMessages(harness.requestClient.inputs[1]);
    const assistant = wire.find((message) => message.role === "assistant") as {
      tool_calls?: ReadonlyArray<{ id: string }>;
    };
    expect(assistant.tool_calls?.map((call) => call.id)).toEqual(["call_vault_1"]);
    const toolRows = wire.filter((message) => message.role === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]).toMatchObject({ tool_call_id: "call_vault_1" });
    expect(wire.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_vault_1" });
    expect(JSON.stringify(wire).match(/call_web_1/g) ?? []).toHaveLength(0);
  });
});
