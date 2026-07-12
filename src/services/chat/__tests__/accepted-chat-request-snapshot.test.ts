import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { AcceptedChatOperation, ManagedAllowedLease } from "../../managed/ManagedTypes";
import { composeAcceptedChatContinuation, composeAcceptedLegacyContinuation, createAcceptedChatRequestSnapshot } from "../AcceptedChatRequestSnapshot";
import { ChatRequestPreparationService } from "../ChatRequestPreparationService";

function operation(): AcceptedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: "accepted", message_id: "u" } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ lease, durableTurnId: "u", acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: "b" });
}
const model = { id: "m", supported_parameters: ["tools"], architecture: { modality: "text->text" } } as never;
const policy = { prompt: "selected" as const, contextCount: 1, imageContextIncluded: true, documentContextIncluded: false, tools: "normalized" as const };
function snapshot(op = operation()) {
  return createAcceptedChatRequestSnapshot({ operation: op, preparation: {
    prepared: { modelSource: "systemsculpt", resolvedModel: model, actualModelId: "provider/model", preparedMessages: [
      { role: "system", content: "frozen prompt and context", message_id: "s" }, ...op.initialDurableSnapshot.messages,
    ], finalSystemPrompt: "frozen prompt", tools: [{ type: "function", function: { name: "search" } }] }, notices: [], diagnostics: [],
  }, policy });
}

describe("AcceptedChatRequestSnapshot", () => {
  it("deep-copies and freezes authoritative legacy and managed preparation", () => {
    const accepted = snapshot();
    expect(accepted.operation.durableTurnId).toBe("u");
    expect(accepted.model).toBe("ai-agent");
    expect(accepted.legacyPreparation.preparedMessages[0].content).toBe("frozen prompt and context");
    expect(Object.isFrozen(accepted.legacyPreparation.preparedMessages)).toBe(true);
    expect(Object.keys(accepted)).not.toContain("operation");
    expect(JSON.stringify(accepted)).not.toContain("tool_choice");
  });

  it("reads model, tools, and context exactly once and joins duplicate callers", async () => {
    const op = operation();
    const reads = { model: 0, tools: 0, context: 0 };
    const service = new ChatRequestPreparationService();
    const dependencies = {
      getModelInfo: async () => { reads.model += 1; return { modelSource: "systemsculpt" as const, actualModelId: "provider/model", model }; },
      getAvailableTools: async () => { reads.tools += 1; return [{ type: "function", function: { name: "search" } }]; },
      countImageContextFiles: () => 0,
      contextFileService: { prepareMessagesWithContext: async (messages: never[]) => { reads.context += 1; return messages; } } as never,
    };
    const input = { messages: op.initialDurableSnapshot.messages, model: "m", contextFiles: new Set<string>(), systemPromptOverride: "selected" };
    const first = service.prepare(op, input, dependencies, dependencies);
    expect(service.prepare(op, input, dependencies, dependencies)).toBe(first);
    const settled = await first;
    expect(await service.prepare(op, input, dependencies, dependencies)).toBe(settled);
    expect(reads).toEqual({ model: 1, tools: 1, context: 1 });
    expect(service.has(op)).toBe(true);
    service.release(op);
    expect(service.has(op)).toBe(false);
  });

  it("preserves frozen prompt/context/tools and appends durable tool checkpoints purely", () => {
    const accepted = snapshot();
    const checkpoint = { role: "assistant" as const, content: null, message_id: "a", tool_calls: [{ id: "call", messageId: "a", state: "completed" as const, timestamp: 1, request: { id: "call", type: "function" as const, function: { name: "search", arguments: "{\"q\":1}" } } }] };
    const resultMessage = { role: "tool" as const, content: "ok", message_id: "t", tool_call_id: "call" };
    const next = Object.freeze({ chatId: "c", version: 2, messages: Object.freeze([...accepted.durableSnapshot.messages, checkpoint, resultMessage]) });
    const managed = composeAcceptedChatContinuation(accepted, next);
    const legacy = composeAcceptedLegacyContinuation(accepted, next);
    expect(managed[0]).toMatchObject({ role: "system", content: "frozen prompt and context" });
    expect(managed.at(-1)).toMatchObject({ role: "tool", content: "ok", tool_call_id: "call" });
    expect(legacy.preparedMessages[0].content).toBe("frozen prompt and context");
    expect(legacy.tools).toEqual(accepted.legacyPreparation.tools);
    expect(Object.isFrozen(legacy)).toBe(true);
  });
});
