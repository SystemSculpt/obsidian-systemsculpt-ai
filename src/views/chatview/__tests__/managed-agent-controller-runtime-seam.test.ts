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
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import { ManagedChatRuntimeAdapter } from "../turn/ManagedChatRuntimeAdapter";

// Seam tests: the controller drives the REAL ManagedChatRuntimeAdapter,
// ManagedCapabilityClient, and HostedTransportAdapter; only HTTP itself is
// queued. The mocked-runtime controller suite cannot see rejections the real
// adapter raises before HTTP (empty continuation deltas) or the exact bytes
// the server receives (which the server's transcript validation judges), and
// both have shipped production incidents that mocked suites green-lit.

jest.mock("obsidian", () => ({
  parseYaml: jest.fn((content: string) => {
    const result: Record<string, unknown> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      result[key] = value === "" ? null : value.replace(/^["']|["']$/g, "");
    }
    return result;
  }),
}));

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

function saveAndReloadMessages(messages: readonly ChatMessage[], chatId = "chat-1"): ChatMessage[] {
  const serialized = ChatMarkdownSerializer.serializeMessages(clone([...messages]) as ChatMessage[]);
  const parsed = ChatMarkdownSerializer.parseMarkdown(`---
id: ${chatId}
---

${serialized}`);
  if (!parsed) throw new Error(`Failed to reload persisted chat transcript for ${chatId}.`);
  return clone(parsed.messages);
}

function expectSchemaValidAssistantProjection(
  wire: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const assistants = wire.filter((message) => message.role === "assistant");
  expect(assistants.length).toBeLessThanOrEqual(1);
  const assistant = assistants[0];
  if (!assistant) return undefined;

  const content = assistant.content;
  const toolCalls = assistant.tool_calls;
  const hasNonEmptyContent = typeof content === "string"
    ? content.length > 0
    : Array.isArray(content) && content.length > 0;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

  expect(hasNonEmptyContent || hasToolCalls).toBe(true);
  return assistant;
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
    pluginVersion: "6.2.6",
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
  const replaceTranscript = (nextMessages: readonly ChatMessage[]) => {
    messages = clone([...nextMessages]) as ChatMessage[];
    version += 1;
    return snapshot();
  };

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

  return { requestClient, host, startTurn, transcript: snapshot, replaceTranscript };
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

  it("sends a follow-up after a search turn through a real save and reload without the unanswerable server call", async () => {
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
    harness.replaceTranscript(saveAndReloadMessages(harness.transcript().messages, "search-follow-up"));
    const followUp = await harness.startTurn("user-2", "who are its competitors?");

    expect(followUp.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(2);
    const wire = requestMessages(harness.requestClient.inputs[1]);
    const assistant = expectSchemaValidAssistantProjection(wire);
    expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_1");
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "Blaxel is cloud infrastructure for AI agents.",
    });
    expect(assistant).not.toHaveProperty("tool_calls");
  });

  it("projects a reloaded legacy web search follow-up without relying on executedOn metadata", async () => {
    const harness = createSeamHarness();
    const legacyWebSearchToolCall = {
      id: "call_web_legacy",
      messageId: "assistant-search",
      request: {
        id: "call_web_legacy",
        type: "function" as const,
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "release notes" }),
        },
      },
      state: "completed" as const,
      timestamp: 1,
      result: {
        success: true as const,
        data: { tool: "web_search", result_count: 1 },
      },
    };
    harness.replaceTranscript(saveAndReloadMessages([
      { role: "user", content: "Search release notes", message_id: "user-search" },
      {
        role: "assistant",
        content: "Search-backed answer",
        message_id: "assistant-search",
        messageParts: [
          {
            id: "tool_call_part-call_web_legacy",
            type: "tool_call",
            data: legacyWebSearchToolCall,
            timestamp: 1,
          },
          {
            id: "content-search-answer",
            type: "content",
            data: "Search-backed answer",
            timestamp: 2,
          },
        ],
      },
    ], "legacy-web-search"));
    harness.requestClient.responses.push(response(TEXT_TURN_WIRE("It changed recently.")));

    expect(harness.transcript().messages[1]?.tool_calls?.[0]).not.toHaveProperty("executedOn");

    const followUp = await harness.startTurn("user-follow-up", "Follow up");

    expect(followUp.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(1);
    const wire = requestMessages(harness.requestClient.inputs[0]);
    const assistant = expectSchemaValidAssistantProjection(wire);
    expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_legacy");
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "Search-backed answer",
    });
    expect(assistant).not.toHaveProperty("tool_calls");
  });

  it("omits a reloaded empty server-only checkpoint instead of sending an empty assistant row", async () => {
    const harness = createSeamHarness();
    const legacyEmptyWebSearchToolCall = {
      id: "call_web_empty",
      messageId: "assistant-empty-search",
      request: {
        id: "call_web_empty",
        type: "function" as const,
        function: {
          name: "web_search",
          arguments: "{}",
        },
      },
      state: "completed" as const,
      timestamp: 1,
      result: {
        success: true as const,
        data: { tool: "web_search", result_count: 0 },
      },
    };
    harness.replaceTranscript(saveAndReloadMessages([
      { role: "user", content: "Search", message_id: "user-search" },
      {
        role: "assistant",
        content: "",
        message_id: "assistant-empty-search",
        messageParts: [{
          id: "tool_call_part-call_web_empty",
          type: "tool_call",
          data: legacyEmptyWebSearchToolCall,
          timestamp: 1,
        }],
      },
    ], "legacy-empty-search"));
    harness.requestClient.responses.push(response(TEXT_TURN_WIRE("Try a more specific query.")));

    expect(harness.transcript().messages[1]?.tool_calls?.[0]).not.toHaveProperty("executedOn");

    const followUp = await harness.startTurn("user-retry", "Try again");

    expect(followUp.kind).toBe("completed");
    expect(harness.requestClient.inputs).toHaveLength(1);
    const wire = requestMessages(harness.requestClient.inputs[0]);
    expectSchemaValidAssistantProjection(wire);
    expect(wire.map((message) => message.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_empty");
    expect(wire.find((message) => message.role === "assistant")).toBeUndefined();
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
