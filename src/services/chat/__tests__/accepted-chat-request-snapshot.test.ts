import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type {
  AcceptedManagedChatOperation,
  ManagedAllowedLease,
} from "../../managed/ManagedTypes";
import {
  composeAcceptedChatContinuation,
  createAcceptedManagedChatRequestSnapshot,
  prepareManagedMessage,
  projectManagedMessages,
} from "../AcceptedChatRequestSnapshot";
import { ChatRequestPreparationService } from "../ChatRequestPreparationService";

function base(id = "u") {
  const message = Object.freeze({ role: "user", content: "accepted", message_id: id } as const);
  const initialDurableSnapshot = Object.freeze({
    chatId: "c",
    version: 1,
    messages: Object.freeze([message]),
  });
  return {
    durableTurnId: id,
    acceptedUserMessage: message,
    initialDurableSnapshot,
    turnBoundaryId: "b",
  } as const;
}

function managedOperation(id = "u"): AcceptedManagedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  return Object.freeze({ ...base(id), runtime: "managed", lease });
}

const policy = {
  contextCount: 1,
  imageContextIncluded: true,
  documentContextIncluded: false,
  tools: "normalized" as const,
};

describe("AcceptedChatRequestSnapshot", () => {
  it("preserves ordered mixed and attachment-only content parts on the managed wire", () => {
    const mixed = prepareManagedMessage({
      role: "user",
      message_id: "mixed",
      content: [
        { type: "text", text: "Compare these" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "--- BEGIN ATTACHED FILE: brief.md (text/markdown) ---\n# Brief\n--- END ATTACHED FILE: brief.md ---" },
        { type: "image_url", image_url: { url: "data:image/webp;base64,AQID" } },
      ],
    });
    const attachmentOnly = prepareManagedMessage({
      role: "user",
      message_id: "image-only",
      content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }],
    });

    expect(mixed.content).toEqual([
      { type: "text", text: "Compare these" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      expect.objectContaining({ type: "text", text: expect.stringContaining("brief.md") }),
      { type: "image_url", image_url: { url: "data:image/webp;base64,AQID" } },
    ]);
    expect(attachmentOnly.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
    ]);
    expect(Object.isFrozen(mixed.content)).toBe(true);
  });

  it("freezes a managed snapshot without a legacy/provider preparation payload", () => {
    const operation = managedOperation();
    const accepted = createAcceptedManagedChatRequestSnapshot({
      operation,
      policy,
      managedMessages: operation.initialDurableSnapshot.messages,
      managedTools: [{ type: "function", function: { name: "search" } }],
      webSearch: true,
    });

    expect(accepted.runtime).toBe("managed");
    expect(accepted.model).toBe("ai-agent");
    expect(accepted.webSearch).toBe(true);
    expect(accepted).not.toHaveProperty("legacyPreparation");
    expect(Object.isFrozen(accepted.messages)).toBe(true);
    expect(Object.keys(accepted)).not.toContain("operation");
  });

  it("excludes legacy client-owned system messages from initial and continuation payloads", () => {
    const operation = managedOperation();
    const legacySystem = Object.freeze({
      role: "system" as const,
      content: "Legacy client instructions",
      message_id: "legacy-system",
    });
    const accepted = createAcceptedManagedChatRequestSnapshot({
      operation,
      policy,
      managedMessages: [legacySystem, ...operation.initialDurableSnapshot.messages],
      managedTools: [],
      webSearch: false,
    });
    const continuation = Object.freeze({
      chatId: "c",
      version: 2,
      messages: Object.freeze([
        ...operation.initialDurableSnapshot.messages,
        legacySystem,
        { role: "user" as const, content: "Continue", message_id: "next" },
      ]),
    });

    expect(accepted.messages).toEqual([{ role: "user", content: "accepted" }]);
    expect(composeAcceptedChatContinuation(accepted, continuation)).toEqual([
      { role: "user", content: "accepted" },
      { role: "user", content: "Continue" },
    ]);
  });

  it("prepares managed requests without reading legacy model resolution", async () => {
    const operation = managedOperation();
    const service = new ChatRequestPreparationService();
    const reads = { model: 0, context: 0, tools: 0 };
    const dependencies = {
      getModelInfo: async () => {
        reads.model += 1;
        throw new Error("managed preparation must not resolve a model");
      },
      getAvailableTools: async () => { reads.tools += 1; return []; },
      countImageContextFiles: () => 0,
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[]) => {
          reads.context += 1;
          return messages;
        },
      } as never,
    };

    const first = service.prepare(
      operation,
      {},
      dependencies,
    );
    expect(service.prepare(
      operation,
      {},
      dependencies,
    )).toBe(first);
    const accepted = await first;

    expect(accepted.runtime).toBe("managed");
    expect(reads).toEqual({ model: 0, context: 1, tools: 1 });
  });

  it("composes managed continuations from the accepted durable snapshot", () => {
    const managedOperationValue = managedOperation();
    const managed = createAcceptedManagedChatRequestSnapshot({
      operation: managedOperationValue,
      policy,
      managedMessages: managedOperationValue.initialDurableSnapshot.messages,
      managedTools: [],
      webSearch: false,
    });
    const checkpoint = { role: "tool" as const, content: "ok", message_id: "t", tool_call_id: "call" };
    const managedNext = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...managed.durableSnapshot.messages, checkpoint]) });

    expect(composeAcceptedChatContinuation(managed, managedNext).at(-1)).toMatchObject({ role: "tool", content: "ok" });
  });

  it("anchors after the accepted user when prior resolved tools expanded the continuation space", () => {
    const priorUser = { role: "user" as const, content: "First", message_id: "prior-user" };
    const priorAssistant = {
      role: "assistant" as const,
      content: "",
      message_id: "prior-assistant",
      tool_calls: [{
        id: "prior-call",
        messageId: "prior-assistant",
        request: { id: "prior-call", type: "function" as const, function: { name: "read", arguments: "{}" } },
        state: "completed" as const,
        timestamp: 1,
        result: { success: true as const, data: { path: "Prior.md" } },
      }],
    };
    const acceptedUser = { role: "user" as const, content: "Then", message_id: "accepted-user" };
    const initialDurableSnapshot = Object.freeze({
      chatId: "c",
      title: "Chat",
      version: 3,
      backend: "systemsculpt" as const,
      messages: Object.freeze([priorUser, priorAssistant, acceptedUser]),
    });
    const baseOperation = managedOperation("accepted-user");
    const operationWithHistory = Object.freeze({
      ...baseOperation,
      acceptedUserMessage: acceptedUser,
      initialDurableSnapshot,
    });
    const accepted = createAcceptedManagedChatRequestSnapshot({
      operation: operationWithHistory,
      policy,
      managedMessages: [
        priorUser,
        priorAssistant,
        { role: "tool", content: "{\"path\":\"Prior.md\"}", message_id: "prior-tool", tool_call_id: "prior-call" },
        acceptedUser,
      ],
      managedTools: [],
      webSearch: false,
    });
    const currentAssistant = {
      role: "assistant" as const,
      content: "",
      message_id: "current-assistant",
      tool_calls: [{
        id: "current-call",
        messageId: "current-assistant",
        request: { id: "current-call", type: "function" as const, function: { name: "read", arguments: "{}" } },
        state: "completed" as const,
        timestamp: 2,
        result: { success: true as const, data: { path: "Current.md" } },
      }],
    };
    const continuation = Object.freeze({
      ...initialDurableSnapshot,
      version: 5,
      messages: Object.freeze([
        priorUser,
        priorAssistant,
        { role: "tool" as const, content: "{\"path\":\"Prior.md\"}", message_id: "prior-tool", tool_call_id: "prior-call" },
        acceptedUser,
        currentAssistant,
        { role: "tool" as const, content: "{\"path\":\"Current.md\"}", message_id: "current-tool", tool_call_id: "current-call" },
      ]),
    });

    const wire = composeAcceptedChatContinuation(accepted, continuation);

    expect(wire.filter((message) => message.role === "user" && message.content === "Then")).toHaveLength(1);
    expect(wire.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "current-call" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "current-call" }),
    ]);
  });

  it("projects a follow-up after a server-executed search without the unanswerable call", () => {
    // Regression: the server executes web_search itself and writes its own
    // result into its transcript, so this client never has a result row for
    // it. The managed transcript contract requires exactly one result per
    // projected call, so keeping the call on the wire made every session
    // create/rebase after a web-search turn fail server-side with
    // 'Every assistant tool call must receive exactly one matching tool
    // result' — surfaced as "SystemSculpt rejected this request."
    const searchAssistant = {
      role: "assistant" as const,
      content: "Blaxel is cloud infrastructure for AI agents.",
      message_id: "search-assistant",
      tool_calls: [{
        id: "call_web_1",
        messageId: "search-assistant",
        request: { id: "call_web_1", type: "function" as const, function: { name: "web_search", arguments: "{}" } },
        state: "completed" as const,
        timestamp: 1,
        executedOn: "server" as const,
        result: { success: true as const, data: { tool: "web_search", result_count: 3 } },
      }],
    };

    const wire = projectManagedMessages([
      { role: "user", content: "tldr about blaxel please", message_id: "u1" },
      searchAssistant,
      { role: "user", content: "who are its competitors?", message_id: "u2" },
    ]);

    expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_1");
    expect(wire[1]).not.toHaveProperty("tool_calls");
  });

  it("projects a reloaded legacy web search without relying on executedOn metadata", () => {
    const reloadedSearchAssistant = {
      role: "assistant" as const,
      content: "Search-backed answer",
      message_id: "search-assistant",
      tool_calls: [{
        id: "call_web_legacy",
        messageId: "search-assistant",
        request: {
          id: "call_web_legacy",
          type: "function" as const,
          function: { name: "web_search", arguments: "{\"query\":\"release\"}" },
        },
        state: "completed" as const,
        timestamp: 1,
        result: { success: true as const, data: { tool: "web_search", result_count: 1 } },
      }],
    };

    const wire = projectManagedMessages([
      { role: "user", content: "search for release", message_id: "u1" },
      reloadedSearchAssistant,
      { role: "user", content: "follow up", message_id: "u2" },
    ]);

    expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(wire)).not.toContain("call_web_legacy");
    expect(wire[1]).not.toHaveProperty("tool_calls");
  });

  it("omits an empty server-only checkpoint that would violate the wire schema", () => {
    const emptySearchCheckpoint = {
      role: "assistant" as const,
      content: "",
      message_id: "empty-search-assistant",
      tool_calls: [{
        id: "call_web_empty",
        messageId: "empty-search-assistant",
        request: {
          id: "call_web_empty",
          type: "function" as const,
          function: { name: "web_search", arguments: "{}" },
        },
        state: "completed" as const,
        timestamp: 1,
        executedOn: "server" as const,
        result: { success: true as const, data: { tool: "web_search", result_count: 0 } },
      }],
    };

    const wire = projectManagedMessages([
      { role: "user", content: "search", message_id: "u1" },
      emptySearchCheckpoint,
      { role: "user", content: "try again", message_id: "u2" },
    ]);

    expect(wire).toEqual([
      expect.objectContaining({ role: "user", content: "search" }),
      expect.objectContaining({ role: "user", content: "try again" }),
    ]);
  });

  it("normalizes an oldest-shape settled vault call and its synthesized result", () => {
    const wire = projectManagedMessages([
      { role: "user", content: "Read it", message_id: "u1" },
      {
        role: "assistant",
        content: "",
        message_id: "a1",
        tool_calls: [{
          id: "call_flat_read",
          messageId: "a1",
          name: "read",
          arguments: { paths: ["Notes/Legacy.md"] },
          state: "completed",
          timestamp: 1,
          result: { success: true, data: { path: "Notes/Legacy.md" } },
        } as any],
      },
      { role: "user", content: "Continue", message_id: "u2" },
    ]);

    expect(wire).toEqual([
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_flat_read",
          type: "function",
          function: {
            name: "read",
            arguments: "{\"paths\":[\"Notes/Legacy.md\"]}",
          },
        }],
      },
      {
        role: "tool",
        content: "{\"path\":\"Notes/Legacy.md\"}",
        tool_call_id: "call_flat_read",
        name: "read",
      },
      { role: "user", content: "Continue" },
    ]);
  });

  it("rejects a malformed legacy client call with an explicit local-history error", () => {
    const malformedAssistant = {
      role: "assistant" as const,
      content: "",
      message_id: "a1",
      tool_calls: [{
        id: "call_malformed",
        messageId: "a1",
        state: "completed" as const,
        timestamp: 1,
        result: { success: true as const, data: {} },
      } as any],
    };

    expect(() => prepareManagedMessage(malformedAssistant))
      .toThrow("Managed history contains a malformed tool call.");
    expect(() => projectManagedMessages([
      { role: "user", content: "Run it", message_id: "u1" },
      malformedAssistant,
    ])).toThrow("Managed history contains a malformed tool call.");
  });

  it("projects a mixed settled batch keeping only the client call and its result", () => {
    const mixedAssistant = {
      role: "assistant" as const,
      content: "",
      message_id: "mixed-assistant",
      tool_calls: [
        {
          id: "call_web_1",
          messageId: "mixed-assistant",
          request: { id: "call_web_1", type: "function" as const, function: { name: "web_search", arguments: "{}" } },
          state: "completed" as const,
          timestamp: 1,
          executedOn: "server" as const,
          result: { success: true as const, data: { tool: "web_search", result_count: 3 } },
        },
        {
          id: "call_vault_1",
          messageId: "mixed-assistant",
          request: { id: "call_vault_1", type: "function" as const, function: { name: "read", arguments: "{}" } },
          state: "completed" as const,
          timestamp: 2,
          result: { success: true as const, data: { path: "Notes/release.md" } },
        },
      ],
    };

    const wire = projectManagedMessages([
      { role: "user", content: "check both", message_id: "u1" },
      mixedAssistant,
      { role: "tool", content: "{\"path\":\"Notes/release.md\"}", message_id: "t1", tool_call_id: "call_vault_1" },
      { role: "user", content: "thanks, next", message_id: "u2" },
    ]);

    const assistant = wire[1] as { tool_calls?: ReadonlyArray<{ id: string }> };
    expect(assistant.tool_calls?.map((call) => call.id)).toEqual(["call_vault_1"]);
    expect(wire[2]).toMatchObject({ role: "tool", tool_call_id: "call_vault_1" });
    expect(JSON.stringify(wire)).not.toContain("call_web_1");
  });

  it("fails closed when a continuation loses or duplicates its accepted boundary", () => {
    const operation = managedOperation("accepted-user");
    const accepted = createAcceptedManagedChatRequestSnapshot({
      operation,
      policy,
      managedMessages: operation.initialDurableSnapshot.messages,
      managedTools: [],
      webSearch: false,
    });
    const missing = Object.freeze({ ...operation.initialDurableSnapshot, messages: Object.freeze([]) });
    const duplicate = Object.freeze({
      ...operation.initialDurableSnapshot,
      messages: Object.freeze([
        ...operation.initialDurableSnapshot.messages,
        ...operation.initialDurableSnapshot.messages,
      ]),
    });

    expect(() => composeAcceptedChatContinuation(accepted, missing)).toThrow("accepted user-turn boundary");
    expect(() => composeAcceptedChatContinuation(accepted, duplicate)).toThrow("accepted user-turn boundary");
  });

  it("fails closed instead of duplicating partial explicit tool-result batches", () => {
    const assistant = {
      role: "assistant" as const,
      content: "",
      message_id: "assistant-tools",
      tool_calls: ["first", "second"].map((id, index) => ({
        id,
        messageId: "assistant-tools",
        request: {
          id,
          type: "function" as const,
          function: { name: "read", arguments: JSON.stringify({ index }) },
        },
        state: "completed" as const,
        timestamp: index,
        result: { success: true as const, data: { index } },
      })),
    };
    const partial = {
      role: "tool" as const,
      content: "{\"index\":0}",
      message_id: "tool-first",
      tool_call_id: "first",
    };

    expect(() => projectManagedMessages([assistant, partial])).toThrow(
      "partial or mismatched explicit tool-result batch",
    );
  });

  it("fails closed when one assistant repeats a surviving client tool-call id", () => {
    const duplicate = (timestamp: number) => ({
      id: "duplicate-call",
      messageId: "assistant-duplicate",
      request: {
        id: "duplicate-call",
        type: "function" as const,
        function: { name: "read", arguments: JSON.stringify({ timestamp }) },
      },
      state: "completed" as const,
      timestamp,
      result: { success: true as const, data: { timestamp } },
    });

    expect(() => projectManagedMessages([{
      role: "assistant",
      content: "",
      message_id: "assistant-duplicate",
      tool_calls: [duplicate(1), duplicate(2)],
    }])).toThrow("duplicate client tool-call id");
  });

  it("fails closed when separate assistant batches reuse a client tool-call id", () => {
    const assistant = (messageId: string, timestamp: number) => ({
      role: "assistant" as const,
      content: "",
      message_id: messageId,
      tool_calls: [{
        id: "reused-call",
        messageId,
        request: {
          id: "reused-call",
          type: "function" as const,
          function: { name: "read", arguments: "{}" },
        },
        state: "completed" as const,
        timestamp,
        result: { success: true as const, data: { messageId } },
      }],
    });

    expect(() => projectManagedMessages([
      assistant("assistant-1", 1),
      assistant("assistant-2", 2),
    ])).toThrow("duplicate client tool-call id");
  });
});
