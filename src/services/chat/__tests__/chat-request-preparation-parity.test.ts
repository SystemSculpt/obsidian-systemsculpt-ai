import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { AcceptedChatOperation, ManagedAllowedLease } from "../../managed/ManagedTypes";
import { prepareManagedAcceptedChatRequest } from "../ChatRequestPreparationService";

function operation(): AcceptedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: [{ type: "text", text: "body" }, { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE" } }], message_id: "u" } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ lease, durableTurnId: "u", acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: "b" }) as AcceptedChatOperation;
}

describe("managed accepted request preparation", () => {
  it("uses fixed-contract preparation without model selection or image trimming and reads each source once", async () => {
    const reads = { context: 0, tools: 0 };
    const op = operation();
    const result = await prepareManagedAcceptedChatRequest(op, {
      contextFiles: new Set(["context.md"]), systemPromptOverride: "selected prompt", allowTools: true,
    }, {
      contextFileService: { prepareMessagesWithContext: async (messages: never[], files: Set<string>, images: boolean, prompt: string) => {
        reads.context += 1;
        expect(files).toEqual(new Set(["context.md"]));
        expect(images).toBe(true);
        expect(prompt).toBe("selected prompt");
        return messages;
      } } as never,
      getAvailableTools: async () => { reads.tools += 1; return [{ type: "function", function: { name: "search", description: "", parameters: {} } }]; },
    });
    expect(reads).toEqual({ context: 1, tools: 1 });
    expect(JSON.stringify(result.messages)).toContain("PRIVATE_IMAGE");
    expect(result.tools).toHaveLength(1);
  });

  it("does not resolve tools when tools are disabled", async () => {
    let toolReads = 0;
    await prepareManagedAcceptedChatRequest(operation(), { allowTools: false }, {
      contextFileService: { prepareMessagesWithContext: async (messages: never[]) => messages } as never,
      getAvailableTools: async () => { toolReads += 1; return []; },
    });
    expect(toolReads).toBe(0);
  });
});
