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
});
