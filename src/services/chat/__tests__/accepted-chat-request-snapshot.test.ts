import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { AcceptedChatOperation, ManagedAllowedLease } from "../../managed/ManagedTypes";
import { composeAcceptedChatContinuation, createAcceptedChatRequestSnapshot } from "../AcceptedChatRequestSnapshot";
import { ChatRequestPreparationService } from "../ChatRequestPreparationService";

function operation(): AcceptedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "accepted", message_id: "u" } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ lease, durableTurnId: "u", acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: "b" });
}

describe("AcceptedChatRequestSnapshot", () => {
  it("deep-copies and freezes closed request data without tool_choice", () => {
    const op = operation();
    const message = { role: "user" as const, content: [{ type: "text" as const, text: "original" }], message_id: "u" };
    const snapshot = createAcceptedChatRequestSnapshot({ operation: op, preparedMessages: [message], tools: [], policy: { prompt: "none", contextCount: 0, imageContextIncluded: true, documentContextIncluded: false, tools: "omitted" } });
    message.content[0].text = "mutated";
    expect(snapshot.operation).toBe(op);
    expect(snapshot.model).toBe("ai-agent");
    expect(JSON.stringify(snapshot.messages)).toContain("original");
    expect(JSON.stringify(snapshot)).not.toContain("tool_choice");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
  });

  it("joins duplicate preparation and preserves settled object identity", async () => {
    const op = operation();
    let calls = 0;
    const context = { prepareMessagesWithContext: async (messages: never[]) => { calls += 1; return messages; } };
    const service = new ChatRequestPreparationService(context as never);
    const sources = { contextFiles: new Set<string>(), includeImages: true, tools: [] };
    const first = service.prepare(op, sources);
    expect(service.prepare(op, sources)).toBe(first);
    const settled = await first;
    expect(await service.prepare(op, sources)).toBe(settled);
    expect(calls).toBe(1);
  });

  it("composes continuations only from frozen request data and the new durable snapshot", () => {
    const op = operation();
    const accepted = createAcceptedChatRequestSnapshot({ operation: op, preparedMessages: op.initialDurableSnapshot.messages, tools: [], policy: { prompt: "none", contextCount: 0, imageContextIncluded: true, documentContextIncluded: false, tools: "omitted" } });
    const next = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...op.initialDurableSnapshot.messages, { role: "assistant" as const, content: "done", message_id: "a" }]) });
    const result = composeAcceptedChatContinuation(accepted, next);
    expect(result).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
