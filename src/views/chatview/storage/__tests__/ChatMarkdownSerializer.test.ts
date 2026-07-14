/**
 * @jest-environment jsdom
 */
import { ChatMarkdownSerializer } from "../ChatMarkdownSerializer";
import { ChatMessage, MessagePart } from "../../../../types";

// Mock obsidian's parseYaml
jest.mock("obsidian", () => ({
  parseYaml: jest.fn((content: string) => {
    // Simple YAML parser for tests
    const result: Record<string, any> = {};
    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if ((value.startsWith("[") && !value.startsWith("[[")) || value.startsWith("{")) {
          // JSON-backed arrays and objects emitted by the focused test helper.
          result[key] = JSON.parse(value.replace(/'/g, '"'));
        } else if (value === "null" || value === "") {
          result[key] = null;
        } else if (value === "true" || value === "false") {
          result[key] = value === "true";
        } else if (!isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value.replace(/^["']|["']$/g, "");
        }
      }
    }
    return result;
  }),
}));

describe("ChatMarkdownSerializer", () => {
  describe("serializeMessages", () => {
    it("serializes simple user message", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello!", message_id: "user-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('role="user"');
      expect(result).toContain('message-id="user-1"');
      expect(result).toContain("Hello!");
      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-START");
      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-END -->");
    });

    it("serializes assistant message", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Hi there!", message_id: "asst-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('role="assistant"');
      expect(result).toContain("Hi there!");
    });

    it("rejects standalone tool role messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use tool", message_id: "user-1" },
        { role: "tool", content: "Tool result", message_id: "tool-1" } as ChatMessage,
        { role: "assistant", content: "Done", message_id: "asst-1" },
      ];

      expect(() => ChatMarkdownSerializer.serializeMessages(messages))
        .toThrow("Managed chat persistence does not support tool messages.");
    });

    it("serializes message with messageParts content", () => {
      const parts: MessagePart[] = [
        { id: "p1", type: "content", data: "Part one", timestamp: 1 },
        { id: "p2", type: "content", data: " Part two", timestamp: 2 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("Part one");
      expect(result).toContain("Part two");
    });

    it("serializes message with reasoning part", () => {
      const parts: MessagePart[] = [
        { id: "r1", type: "reasoning", data: "Let me think...", timestamp: 1 },
        { id: "c1", type: "content", data: "Here is my answer", timestamp: 2 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- REASONING");
      expect(result).toContain("Let me think...");
      expect(result).toContain("-->");
      expect(result).toContain('has-reasoning="true"');
    });

    it("serializes message with tool_call part", () => {
      const toolCallData = { id: "call-1", name: "search", arguments: { query: "test" } };
      const parts: MessagePart[] = [
        { id: "tc1", type: "tool_call", data: toolCallData, timestamp: 1 },
      ];
      const messages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- TOOL-CALLS");
      expect(result).toContain('"id": "call-1"');
      expect(result).toContain('"name": "search"');
      expect(result).toContain('has-tool-calls="true"');
    });

    it("serializes array content with text and images", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
          message_id: "user-1",
        },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("What is this?");
      expect(result).toContain("Attached image 1");
      expect(result).toContain("SYSTEMSCULPT-CONTENT-PARTS base64");
      expect(result).not.toContain("data:image/png;base64,abc123");
    });

    it("round-trips local attachment identity metadata without exposing it to message text", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-attachments",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
          { type: "text", text: "--- BEGIN ATTACHED FILE: source.pdf (application/pdf) ---\nExtracted\n--- END ATTACHED FILE: source.pdf ---" },
        ],
        attachmentMetadata: [
          { id: "image-hash", name: "diagram.png", mimeType: "image/png", byteLength: 3, kind: "image", contentPartIndex: 1 },
          { id: "document-hash", name: "source.pdf", mimeType: "application/pdf", byteLength: 4096, kind: "document", contentPartIndex: 2 },
        ],
      };
      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      const markdown = [
        "---",
        "id: attachment-chat",
        "created: 2026-01-01T00:00:00.000Z",
        "lastModified: 2026-01-01T00:00:00.000Z",
        "title: Attachments",
        "---",
        "",
        serialized,
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].content).toEqual(message.content);
      expect(parsed?.messages[0].attachmentMetadata).toEqual(message.attachmentMetadata);
      expect(String(parsed?.messages[0].content)).not.toContain("attachment-metadata");
    });

    it("stores ref-backed attachments without embedding multipart payloads in the chat note", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-ref-backed",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
        ],
        attachmentMetadata: [{
          id: "image-hash",
          name: "diagram.png",
          mimeType: "image/png",
          byteLength: 3,
          kind: "image",
          contentPartIndex: 1,
          contentRef: {
            schema: "systemsculpt-chat-attachment-v1",
            payload: "image-bytes",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            byteLength: 3,
          },
        }],
      };

      const serialized = ChatMarkdownSerializer.serializeMessages([message]);
      expect(serialized).toContain("Compare");
      expect(serialized).toContain("attachment-metadata=");
      expect(serialized).not.toContain("SYSTEMSCULPT-CONTENT-PARTS");
      expect(serialized).not.toContain("data:image/png;base64");
    });

    it("keeps attachment-only ref-backed messages parseable", () => {
      const message: ChatMessage = {
        role: "user",
        message_id: "user-ref-only",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }],
        attachmentMetadata: [{
          id: "image-hash",
          name: "diagram.png",
          mimeType: "image/png",
          byteLength: 3,
          kind: "image",
          contentPartIndex: 0,
          contentRef: {
            schema: "systemsculpt-chat-attachment-v1",
            payload: "image-bytes",
            sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            byteLength: 3,
          },
        }],
      };
      const markdown = [
        "---",
        "id: attachment-only",
        "created: 2026-01-01T00:00:00.000Z",
        "lastModified: 2026-01-01T00:00:00.000Z",
        "title: Attachment only",
        "---",
        "",
        ChatMarkdownSerializer.serializeMessages([message]),
      ].join("\n");

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages).toEqual([{
        role: "user",
        message_id: "user-ref-only",
        content: "",
        attachmentMetadata: message.attachmentMetadata,
      }]);
    });

    it("adds streaming attribute when message is streaming", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "Streaming...", message_id: "asst-1", streaming: true },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain('streaming="true"');
    });

    it("joins multiple messages with double newlines", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "First", message_id: "user-1" },
        { role: "assistant", content: "Second", message_id: "asst-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- SYSTEMSCULPT-MESSAGE-END -->\n\n<!-- SYSTEMSCULPT-MESSAGE-START");
    });
  });

  describe("parseMarkdown", () => {
    const createMarkdown = (metadata: Record<string, any>, body: string): string => {
      const yamlLines = Object.entries(metadata)
        .map(([key, value]) => {
          if (value !== null && typeof value === "object") {
            return `${key}: ${JSON.stringify(value)}`;
          }
          return `${key}: ${value}`;
        })
        .join("\n");
      return `---\n${yamlLines}\n---\n\n${body}`;
    };

    it("returns null for content without front-matter", () => {
      const content = "Just some text without YAML";

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("returns null for front-matter without id", () => {
      const content = createMarkdown({ title: "No identity" }, "");

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("parses basic metadata", () => {
      const content = createMarkdown(
        {
          id: "chat-123",
          title: "Test Chat",
          approvalMode: "full-access",
          created: "2024-01-01T00:00:00Z",
          lastModified: "2024-01-01T12:00:00Z",
        },
        ""
      );

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).not.toBeNull();
      expect(result?.metadata.id).toBe("chat-123");
      expect(result?.metadata.title).toBe("Test Chat");
      expect(result?.metadata.approvalMode).toBe("full-access");
    });

    it("strictly restores a managed session binding from frontmatter", () => {
      const managedSession = {
        id: "mchat_0123456789abcdef0123456789abcdef",
        revision: 4,
        boundChatId: "chat-session",
        checkpointMessageId: "assistant-4",
        toolsetFingerprint: "2:741638a5:5967d5",
        budget: { messageCount: 4, imageCount: 0, attachmentBytes: 0, storedJsonBytes: 512 },
      };
      const content = createMarkdown({
        id: "chat-session",
        title: "Session",
        created: "2026-07-13T00:00:00Z",
        lastModified: "2026-07-13T00:01:00Z",
        managedSession,
      }, "");

      expect(ChatMarkdownSerializer.parseMarkdown(content)?.metadata.managedSession)
        .toEqual(managedSession);
      const malformed = content.replace("assistant-4", "");
      expect(ChatMarkdownSerializer.parseMarkdown(malformed)?.metadata.managedSession)
        .toBeUndefined();
    });

    it("parses sequential format messages", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-1" -->
Hello, how are you?
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" -->
I'm doing well, thank you!
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0].role).toBe("user");
      expect(result?.messages[0].message_id).toBe("user-1");
      expect(result?.messages[0].content).toContain("Hello");
      expect(result?.messages[1].role).toBe("assistant");
    });

    it("parses message with reasoning block", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" has-reasoning="true" -->
<!-- REASONING
Let me think about this carefully.
I should consider all options.
-->
Here is my answer.
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(1);
      const msg = result?.messages[0];
      expect(msg?.messageParts).toBeDefined();
      expect(msg?.messageParts?.some(p => p.type === "reasoning")).toBe(true);
    });

    it("parses message with tool calls block", () => {
      const toolCalls = JSON.stringify([
        { id: "call-1", name: "read_file", arguments: { path: "/test.md" } },
      ], null, 2);
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-1" has-tool-calls="true" -->
<!-- TOOL-CALLS
${toolCalls}
-->
Using tools...
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(1);
      const msg = result?.messages[0];
      expect(msg?.messageParts?.some(p => p.type === "tool_call")).toBe(true);
      expect(msg?.tool_calls).toHaveLength(1);
      expect(msg?.tool_calls?.[0].id).toBe("call-1");
    });

    it("handles empty message body gracefully", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="user-1" -->

<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      // Empty messages may or may not be included depending on implementation
      expect(result).not.toBeNull();
    });

    it("parses context_files array", () => {
      const content = createMarkdown(
        {
          id: "chat-123",
          context_files: ["file1.md", "path/Extractions/doc.md"],
        },
        ""
      );

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.metadata.context_files).toHaveLength(2);
      expect(result?.metadata.context_files?.[0].path).toBe("file1.md");
      expect(result?.metadata.context_files?.[0].type).toBe("source");
      expect(result?.metadata.context_files?.[1].path).toBe("path/Extractions/doc.md");
      expect(result?.metadata.context_files?.[1].type).toBe("extraction");
    });

    it("skips messages without required attributes", () => {
      const messageBlock = `
<!-- SYSTEMSCULPT-MESSAGE-START role="user" -->
Missing message-id
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START message-id="asst-1" -->
Missing role
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="asst-2" -->
Valid message
<!-- SYSTEMSCULPT-MESSAGE-END -->
`;
      const content = createMarkdown({ id: "chat-123" }, messageBlock);

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result?.messages).toHaveLength(1);
      expect(result?.messages[0].message_id).toBe("asst-2");
    });
  });

  describe("isValidYamlFrontmatter", () => {
    // Access private method via bracket notation
    it("returns true when content has id field", () => {
      const result = (ChatMarkdownSerializer as any).isValidYamlFrontmatter("id: chat-123");
      expect(result).toBe(true);
    });

    it("returns false when content has no id", () => {
      const result = (ChatMarkdownSerializer as any).isValidYamlFrontmatter("title: My Chat");
      expect(result).toBe(false);
    });
  });

  describe("round-trip serialization", () => {
    it("round-trips exact framing sentinels in user, assistant, reasoning, and tool content", () => {
      const sentinel = "<!-- SYSTEMSCULPT-MESSAGE-END -->";
      const messages: ChatMessage[] = [
        { role: "user", content: `User quoted ${sentinel}`, message_id: "user-sentinel" },
        { role: "assistant", content: `Assistant quoted ${sentinel}`, message_id: "assistant-sentinel" },
        {
          role: "assistant",
          content: "",
          message_id: "reasoning-sentinel",
          messageParts: [
            { id: "reasoning", type: "reasoning", data: `Reasoning quoted ${sentinel}`, timestamp: 1 },
            { id: "content", type: "content", data: "Done", timestamp: 2 },
          ],
        },
        {
          role: "assistant",
          content: "",
          message_id: "tool-sentinel",
          messageParts: [{
            id: "tool",
            type: "tool_call",
            timestamp: 1,
            data: {
              id: "call-sentinel",
              state: "completed",
              result: { success: true, data: { summary: `Tool quoted ${sentinel}` } },
            } as any,
          }],
        },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(messages);
      const markdown = `---\nid: sentinel-chat\n---\n\n${serialized}`;
      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(serialized.match(/payload-format="base64-json-v1"/g)).toHaveLength(4);
      expect(serialized.match(/<!-- SYSTEMSCULPT-MESSAGE-END -->/g)).toHaveLength(4);
      expect(parsed?.messages).toHaveLength(4);
      expect(parsed?.messages[0].content).toBe(`User quoted ${sentinel}`);
      expect(parsed?.messages[1].content).toBe(`Assistant quoted ${sentinel}`);
      expect(parsed?.messages[2].reasoning).toContain(`Reasoning quoted ${sentinel}`);
      const restoredTool = parsed?.messages[3].messageParts?.find((part) => part.type === "tool_call");
      expect((restoredTool?.data as any)?.result?.data?.summary).toBe(`Tool quoted ${sentinel}`);
    });

    it("round-trips old unencoded chat history without changing its meaning", () => {
      const legacy = `---
id: old-history
---

<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="old-user" -->
Legacy question
<!-- SYSTEMSCULPT-MESSAGE-END -->

<!-- SYSTEMSCULPT-MESSAGE-START role="assistant" message-id="old-assistant" has-reasoning="true" has-tool-calls="true" -->
<!-- REASONING
Legacy reasoning
-->
<!-- TOOL-CALLS
[{"id":"old-call","name":"read","arguments":{"paths":["Old.md"]}}]
-->
Legacy answer
<!-- SYSTEMSCULPT-MESSAGE-END -->`;

      const loaded = ChatMarkdownSerializer.parseMarkdown(legacy);
      const rewritten = ChatMarkdownSerializer.serializeMessages(loaded?.messages ?? []);
      const reloaded = ChatMarkdownSerializer.parseMarkdown(`---\nid: old-history\n---\n\n${rewritten}`);

      expect(rewritten).not.toContain("payload-format=");
      expect(reloaded?.messages).toHaveLength(2);
      expect(String(reloaded?.messages[0].content).trim()).toBe("Legacy question");
      expect(String(reloaded?.messages[1].content).trim()).toBe("Legacy answer");
      expect(reloaded?.messages[1].reasoning).toContain("Legacy reasoning");
      expect(reloaded?.messages[1].tool_calls?.[0].id).toBe("old-call");
    });

    it("preserves message content through serialize and parse", () => {
      const originalMessages: ChatMessage[] = [
        { role: "user", content: "Hello!", message_id: "user-1" },
        { role: "assistant", content: "Hi there!", message_id: "asst-1" },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages).toHaveLength(2);
      expect(parsed?.messages[0].content).toContain("Hello!");
      expect(parsed?.messages[1].content).toContain("Hi there!");
    });

    it("preserves ordered mixed message content, including image bytes, through reload", () => {
      const content = [
        { type: "text" as const, text: "Compare these." },
        { type: "image_url" as const, image_url: { url: "data:image/webp;base64,YWJj" } },
        {
          type: "text" as const,
          text: "--- BEGIN ATTACHED FILE: notes.md (text/markdown) ---\n# Notes\n--- END ATTACHED FILE: notes.md ---",
        },
      ];
      const serialized = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        content,
        message_id: "user-mixed",
      }]);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].content).toEqual(content);
      expect(parsed?.messages[0].messageParts).toBeUndefined();
    });

    it("preserves reasoning through serialize and parse", () => {
      const parts: MessagePart[] = [
        { id: "r1", type: "reasoning", data: "Deep thought here", timestamp: 1 },
        { id: "c1", type: "content", data: "Final answer", timestamp: 2 },
      ];
      const originalMessages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].reasoning).toContain("Deep thought here");
    });

    it("preserves tool calls through serialize and parse", () => {
      const toolCallData = { id: "call-1", name: "search", arguments: { query: "test" } };
      const parts: MessagePart[] = [
        { id: "tc1", type: "tool_call", data: toolCallData, timestamp: 1 },
      ];
      const originalMessages: ChatMessage[] = [
        { role: "assistant", content: "", message_id: "asst-1", messageParts: parts },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages[0].tool_calls).toHaveLength(1);
      expect(parsed?.messages[0].tool_calls?.[0].id).toBe("call-1");
    });

    it("preserves web_search tool metadata for reload rendering", () => {
      const webSearchToolCall = {
        id: "call-web-1",
        messageId: "asst-1",
        request: {
          id: "call-web-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "systemsculpt pricing" }),
          },
        },
        state: "completed",
        timestamp: 1,
        result: {
          success: true,
          data: {
            query: "systemsculpt pricing",
            results: [{ title: "SystemSculpt", url: "https://systemsculpt.com" }],
          },
        },
      };

      const originalMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          message_id: "asst-1",
          messageParts: [
            {
              id: "tool_call_part-call-web-1",
              type: "tool_call",
              data: webSearchToolCall,
              timestamp: 1,
            },
          ],
        },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);
      const restoredToolCall = parsed?.messages[0].tool_calls?.[0] as any;
      expect(restoredToolCall?.request?.function?.name).toBe("web_search");
      expect(JSON.parse(restoredToolCall?.request?.function?.arguments ?? "{}")).toEqual({
        query: "systemsculpt pricing",
      });
    });
  });
});
