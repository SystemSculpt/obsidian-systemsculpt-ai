import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ChatRequestPreparationService } from "../../../services/chat/ChatRequestPreparationService";
import {
  composeAcceptedChatContinuation,
  composeAcceptedChatContinuationDelta,
  prepareManagedMessage,
} from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";

function operation(id = "u"): AcceptedManagedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "accepted", message_id: id } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ runtime: "managed", lease, durableTurnId: id, acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: id });
}

function dependencies(reads: { context: number; tools: number }) {
  return {
    getAvailableTools: async () => { reads.tools += 1; return []; },
    contextFileService: { prepareMessagesWithContext: async (messages: never[]) => { reads.context += 1; return messages; } } as never,
  };
}

describe("accepted request snapshot ownership", () => {
  it("retains one failed preparation and never retries implicitly", async () => {
    const service = new ChatRequestPreparationService();
    const op = operation();
    let attempts = 0;
    const deps = dependencies({ context: 0, tools: 0 });
    deps.contextFileService = { prepareMessagesWithContext: async () => { attempts += 1; throw new Error("private failure"); } } as never;
    const first = service.prepare(op, {}, deps);
    expect(service.prepare(op, {}, deps)).toBe(first);
    await expect(first).rejects.toThrow("private failure");
    await expect(service.prepare(op, {}, deps)).rejects.toThrow("private failure");
    expect(attempts).toBe(1);
  });

  it("keeps live rebind identity, creates a new resend identity, and composes multiple continuations without rereads", async () => {
    const reads = { context: 0, tools: 0 };
    const service = new ChatRequestPreparationService();
    const op = operation("first");
    const input = {};
    const first = await service.prepare(op, input, dependencies(reads));
    expect(await service.prepare(op, input, dependencies(reads))).toBe(first);
    const one = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...op.initialDurableSnapshot.messages, { role: "assistant" as const, content: "one", message_id: "a1" }]) });
    const two = Object.freeze({ chatId: "c", version: 3, messages: Object.freeze([...one.messages, { role: "assistant" as const, content: "two", message_id: "a2" }]) });
    expect(composeAcceptedChatContinuation(first, one).at(-1)).toMatchObject({ content: "one" });
    expect(composeAcceptedChatContinuation(first, two).at(-1)).toMatchObject({ content: "two" });
    expect(reads.context).toBe(1);
    const resend = operation("second");
    const second = await service.prepare(resend, {}, dependencies(reads));
    expect(second).not.toBe(first);
    expect(second.operation).toBe(resend);
    expect(Object.isFrozen(second.messages)).toBe(true);
  });

  it("composes only the latest completed tool-result batch for a resumed session", async () => {
    const service = new ChatRequestPreparationService();
    const op = operation("first");
    const accepted = await service.prepare(op, {}, dependencies({ context: 0, tools: 0 }));
    const durable = Object.freeze({
      chatId: "c",
      version: 6,
      messages: Object.freeze([
        ...op.initialDurableSnapshot.messages,
        {
          role: "assistant" as const,
          content: "",
          message_id: "assistant-1",
          tool_calls: [{
            id: "call-1",
            messageId: "assistant-1",
            request: { id: "call-1", type: "function" as const, function: { name: "read", arguments: "{}" } },
            state: "completed" as const,
            timestamp: 1,
            result: { success: true, data: "one" },
          }],
        },
        {
          role: "assistant" as const,
          content: "",
          message_id: "assistant-2",
          tool_calls: [
            {
              id: "call-2a",
              messageId: "assistant-2",
              request: { id: "call-2a", type: "function" as const, function: { name: "read", arguments: "{}" } },
              state: "completed" as const,
              timestamp: 2,
              result: { success: true, data: "two-a" },
            },
            {
              id: "call-2b",
              messageId: "assistant-2",
              request: { id: "call-2b", type: "function" as const, function: { name: "read", arguments: "{}" } },
              state: "completed" as const,
              timestamp: 3,
              result: { success: true, data: "two-b" },
            },
          ],
        },
      ]),
    });

    expect(composeAcceptedChatContinuationDelta(accepted, durable)).toEqual([
      { role: "tool", content: '"two-a"', tool_call_id: "call-2a", name: "read" },
      { role: "tool", content: '"two-b"', tool_call_id: "call-2b", name: "read" },
    ]);
    expect(Object.isFrozen(composeAcceptedChatContinuationDelta(accepted, durable))).toBe(true);
  });

  it("emits message names only on the server-supported tool role", () => {
    expect(prepareManagedMessage({
      role: "user",
      content: "hello",
      message_id: "user",
      name: "legacy-name",
    })).toEqual({ role: "user", content: "hello" });
    expect(prepareManagedMessage({
      role: "tool",
      content: "done",
      message_id: "tool",
      tool_call_id: "call",
      name: "read",
    })).toEqual({ role: "tool", content: "done", tool_call_id: "call", name: "read" });
  });
});
