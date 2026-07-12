import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type {
  AcceptedManagedChatOperation,
  ManagedAllowedLease,
} from "../../managed/ManagedTypes";
import {
  composeAcceptedChatContinuation,
  createAcceptedManagedChatRequestSnapshot,
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
  prompt: "selected" as const,
  contextCount: 1,
  imageContextIncluded: true,
  documentContextIncluded: false,
  tools: "normalized" as const,
};

describe("AcceptedChatRequestSnapshot", () => {
  it("freezes a managed snapshot without a legacy/provider preparation payload", () => {
    const operation = managedOperation();
    const accepted = createAcceptedManagedChatRequestSnapshot({
      operation,
      policy,
      managedMessages: operation.initialDurableSnapshot.messages,
      managedTools: [{ type: "function", function: { name: "search" } }],
    });

    expect(accepted.runtime).toBe("managed");
    expect(accepted.model).toBe("ai-agent");
    expect(accepted).not.toHaveProperty("legacyPreparation");
    expect(Object.isFrozen(accepted.messages)).toBe(true);
    expect(Object.keys(accepted)).not.toContain("operation");
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
      { messages: operation.initialDurableSnapshot.messages, model: "legacy-must-not-run" },
      dependencies,
    );
    expect(service.prepare(
      operation,
      { messages: operation.initialDurableSnapshot.messages, model: "legacy-must-not-run" },
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
    });
    const checkpoint = { role: "tool" as const, content: "ok", message_id: "t", tool_call_id: "call" };
    const managedNext = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...managed.durableSnapshot.messages, checkpoint]) });

    expect(composeAcceptedChatContinuation(managed, managedNext).at(-1)).toMatchObject({ role: "tool", content: "ok" });
  });
});
