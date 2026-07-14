import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import type { AcceptedManagedChatOperation, ManagedAllowedLease } from "../../managed/ManagedTypes";
import { prepareManagedAcceptedChatRequest } from "../ChatRequestPreparationService";

function operation(): AcceptedManagedChatOperation {
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = Object.freeze({
    role: "user",
    content: [{ type: "text", text: "body" }, { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE" } }],
    message_id: "u",
  } as const);
  const initialDurableSnapshot = Object.freeze({
    chatId: "c",
    title: "Chat",
    version: 1,
    backend: "systemsculpt" as const,
    messages: Object.freeze([message]),
  });
  return Object.freeze({ runtime: "managed", lease, durableTurnId: "u", acceptedUserMessage: message, initialDurableSnapshot, turnBoundaryId: "b" });
}

describe("managed accepted request preparation", () => {
  it("adds local context and tools exactly once without a client-owned system prompt", async () => {
    const reads = { context: 0, tools: 0 };
    const result = await prepareManagedAcceptedChatRequest(operation(), {
      contextFiles: new Set(["context.md"]),
    }, {
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[], files: Set<string>, images: boolean) => {
          reads.context += 1;
          expect(files).toEqual(new Set(["context.md"]));
          expect(images).toBe(true);
          return messages;
        },
      } as never,
      getAvailableTools: async () => {
        reads.tools += 1;
        return [{ type: "function", function: { name: "search", description: "", parameters: {} } }];
      },
    });

    expect(reads).toEqual({ context: 1, tools: 1 });
    expect(JSON.stringify(result.messages)).toContain("PRIVATE_IMAGE");
    expect(result.messages.find((message) => message.role === "system")).toBeUndefined();
    expect(result.tools).toHaveLength(1);
  });

  it.each([0, 1, 3])("preserves established context output with %i normalized tools", async (toolCount) => {
    const contextFiles = new Set(["one.md", "two.md", "doc:report.pdf"]);
    const established = [
      ...operation().initialDurableSnapshot.messages,
      { role: "assistant" as const, content: "prior", message_id: "assistant" },
      { role: "user" as const, content: "oversized-".repeat(20_000), message_id: "large" },
    ];
    const tools = Array.from({ length: toolCount }, (_, index) => ({
      type: "function" as const,
      function: { name: `tool_${index}`, description: "", parameters: {} },
    }));
    const result = await prepareManagedAcceptedChatRequest(operation(), { contextFiles }, {
      contextFileService: {
        prepareMessagesWithContext: async () => established,
      } as never,
      getAvailableTools: async () => tools,
    });

    expect(result.messages).toEqual(established);
    expect(result.tools).toEqual(tools);
    expect(JSON.stringify(result)).toContain("oversized-");
  });

  it("hydrates durable attachment references only during accepted request preparation", async () => {
    const order: string[] = [];
    const result = await prepareManagedAcceptedChatRequest(operation(), {
      hydrateAttachments: async (messages) => {
        order.push("hydrate");
        return messages.map((message) => ({
          ...message,
          content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,HYDRATED" } }],
        }));
      },
    }, {
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[]) => {
          order.push("context");
          expect(JSON.stringify(messages)).toContain("HYDRATED");
          return messages;
        },
      } as never,
      getAvailableTools: async () => [],
    });

    expect(order).toEqual(["hydrate", "context"]);
    expect(JSON.stringify(result.messages)).toContain("HYDRATED");
  });

  it("rejects an attachment hydrator that changes durable message identity", async () => {
    await expect(prepareManagedAcceptedChatRequest(operation(), {
      hydrateAttachments: async (messages) => messages.map((message) => ({
        ...message,
        message_id: "different",
      })),
    }, {
      contextFileService: {
        prepareMessagesWithContext: async (messages: never[]) => messages,
      } as never,
      getAvailableTools: async () => [],
    })).rejects.toThrow("changed durable Chat message identity");
  });
});
