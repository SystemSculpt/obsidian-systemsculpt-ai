import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { AGENT_PRESET } from "../../../constants/prompts";
import { AGENT_TOOL_INSTRUCTIONS } from "../../../constants/prompts/agent";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../managed/ManagedTypes";
import { prepareManagedAcceptedChatRequest } from "../ChatRequestPreparationService";

function operation(): AcceptedManagedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({ role: "user", content: [{ type: "text", text: "body" }, { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE" } }], message_id: "u" } as const);
  const initialDurableSnapshot = Object.freeze({ chatId: "c", version: 1, messages: Object.freeze([message]) });
  return Object.freeze({ runtime: "managed", lease, durableTurnId: "u", acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: "b" });
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
        expect(prompt).toBe(`selected prompt\n\n${AGENT_TOOL_INSTRUCTIONS}`);
        return messages;
      } } as never,
      getAvailableTools: async () => { reads.tools += 1; return [{ type: "function", function: { name: "search", description: "", parameters: {} } }]; },
    });
    expect(reads).toEqual({ context: 1, tools: 1 });
    expect(JSON.stringify(result.messages)).toContain("PRIVATE_IMAGE");
    expect(result.tools).toHaveLength(1);
  });

  it.each([0, 1, 3])("preserves established context output exactly with %i normalized tools", async (toolCount) => {
    const privatePath = "/vault/PRIVATE-7f91/context.md";
    const privateMetadata = "PRIVATE_FRONTMATTER_4c82";
    const contextFiles = new Set(["one.md", "two.md", "wiki:[[linked]]", "doc:report.pdf"]);
    const established = [
      { role: "system" as const, content: "selected prompt\n\n# one\nbody\n\n[[linked]]\n\nDOCUMENT_TEXT", message_id: "system" },
      ...operation().initialDurableSnapshot.messages,
      { role: "assistant" as const, content: null, message_id: "assistant", tool_calls: [{ id: "call", messageId: "assistant", state: "completed" as const, timestamp: 1, request: { id: "call", type: "function" as const, function: { name: "search", arguments: "{}" } } }] },
      { role: "tool" as const, content: "tool result", message_id: "tool", tool_call_id: "call" },
      { role: "user" as const, content: "oversized-".repeat(20_000), message_id: "large" },
    ];
    const tools = Array.from({ length: toolCount }, (_, index) => ({ type: "function" as const, function: { name: `tool_${index}`, description: "", parameters: {} } }));
    const result = await prepareManagedAcceptedChatRequest(operation(), {
      contextFiles, systemPromptOverride: "selected prompt", allowTools: true,
    }, {
      contextFileService: { prepareMessagesWithContext: async (_messages: never[], files: Set<string>, images: boolean, prompt: string) => {
        expect([...files]).toEqual([...contextFiles]);
        expect(images).toBe(true);
        expect(prompt).toBe(`selected prompt\n\n${AGENT_TOOL_INSTRUCTIONS}`);
        return established;
      } } as never,
      getAvailableTools: async () => tools,
    });
    expect(result.messages).toEqual(established);
    expect(result.tools).toEqual(tools);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(privateMetadata);
    expect(serialized).toContain("DOCUMENT_TEXT");
    expect(serialized).toContain("tool result");
    expect(serialized).toContain("oversized-");
  });

  it("uses the managed agent preset when no prompt is selected", async () => {
    let observedPrompt: string | undefined;
    await prepareManagedAcceptedChatRequest(operation(), {}, {
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[], _files: Set<string>, _images: boolean, prompt?: string) => {
          observedPrompt = prompt;
          return messages;
        },
      } as never,
      getAvailableTools: async () => [],
    });
    expect(observedPrompt).toBe(AGENT_PRESET.systemPrompt);
  });

  it("keeps a selected prompt unchanged and does not resolve tools when tools are disabled", async () => {
    let toolReads = 0;
    let observedPrompt: string | undefined;
    await prepareManagedAcceptedChatRequest(operation(), {
      allowTools: false,
      systemPromptOverride: "selected without tools",
    }, {
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[], _files: Set<string>, _images: boolean, prompt?: string) => {
          observedPrompt = prompt;
          return messages;
        },
      } as never,
      getAvailableTools: async () => { toolReads += 1; return []; },
    });
    expect(toolReads).toBe(0);
    expect(observedPrompt).toBe("selected without tools");
  });
});
