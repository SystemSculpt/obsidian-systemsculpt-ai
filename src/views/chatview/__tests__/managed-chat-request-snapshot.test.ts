import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ChatRequestPreparationService } from "../../../services/chat/ChatRequestPreparationService";
import { composeAcceptedChatContinuation } from "../../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";

function operation(id = "u"): AcceptedManagedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "accepted", message_id: id } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ runtime: "managed", lease, durableTurnId: id, acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: id });
}

const model = { id: "legacy", supported_parameters: ["tools"], architecture: { modality: "text->text" } } as never;
function dependencies(reads: { context: number; tools: number; model: number }) {
  return {
    getModelInfo: async () => { reads.model += 1; return { modelSource: "systemsculpt" as const, actualModelId: "provider/model", model }; },
    getAvailableTools: async () => { reads.tools += 1; return []; },
    countImageContextFiles: () => 0,
    contextFileService: { prepareMessagesWithContext: async (messages: never[]) => { reads.context += 1; return messages; } } as never,
  };
}

describe("accepted request snapshot ownership", () => {
  it("retains one failed preparation and never retries implicitly", async () => {
    const service = new ChatRequestPreparationService();
    const op = operation();
    let attempts = 0;
    const deps = dependencies({ context: 0, tools: 0, model: 0 });
    deps.contextFileService = { prepareMessagesWithContext: async () => { attempts += 1; throw new Error("private failure"); } } as never;
    const first = service.prepare(op, { messages: [], model: "legacy" }, deps, deps);
    expect(service.prepare(op, { messages: [], model: "legacy" }, deps, deps)).toBe(first);
    await expect(first).rejects.toThrow("private failure");
    await expect(service.prepare(op, { messages: [], model: "legacy" }, deps, deps)).rejects.toThrow("private failure");
    expect(attempts).toBe(1);
  });

  it("keeps live rebind identity, creates a new resend identity, and composes multiple continuations without rereads", async () => {
    const reads = { context: 0, tools: 0, model: 0 };
    const service = new ChatRequestPreparationService();
    const op = operation("first");
    const input = { messages: op.initialDurableSnapshot.messages, model: "legacy" };
    const first = await service.prepare(op, input, dependencies(reads), dependencies(reads));
    expect(await service.prepare(op, input, dependencies(reads), dependencies(reads))).toBe(first);
    const one = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...op.initialDurableSnapshot.messages, { role: "assistant" as const, content: "one", message_id: "a1" }]) });
    const two = Object.freeze({ chatId: "c", version: 3, messages: Object.freeze([...one.messages, { role: "assistant" as const, content: "two", message_id: "a2" }]) });
    expect(composeAcceptedChatContinuation(first, one).at(-1)).toMatchObject({ content: "one" });
    expect(composeAcceptedChatContinuation(first, two).at(-1)).toMatchObject({ content: "two" });
    expect(reads.context).toBe(1);
    expect(reads.model).toBe(0);
    const resend = operation("second");
    const second = await service.prepare(resend, { messages: resend.initialDurableSnapshot.messages, model: "legacy" }, dependencies(reads), dependencies(reads));
    expect(second).not.toBe(first);
    expect(second.operation).toBe(resend);
    expect(Object.isFrozen(second.messages)).toBe(true);
  });
});
