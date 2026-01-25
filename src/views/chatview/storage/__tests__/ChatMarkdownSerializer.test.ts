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
        if (value.startsWith("[")) {
          // Array
          result[key] = JSON.parse(value.replace(/'/g, '"'));
        } else if (value === "null" || value === "") {
          result[key] = null;
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

    it("filters out tool role messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use tool", message_id: "user-1" },
        { role: "tool", content: "Tool result", message_id: "tool-1" } as ChatMessage,
        { role: "assistant", content: "Done", message_id: "asst-1" },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("Use tool");
      expect(result).toContain("Done");
      expect(result).not.toContain("Tool result");
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

    it("serializes legacy format with tool_calls array", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Using tools",
          message_id: "asst-1",
          tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }],
        },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- TOOL-CALLS");
      expect(result).toContain("read_file");
      expect(result).toContain('has-tool-calls="true"');
    });

    it("serializes legacy format with reasoning string", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "The answer is 42",
          message_id: "asst-1",
          reasoning: "I calculated this carefully",
        },
      ];

      const result = ChatMarkdownSerializer.serializeMessages(messages);

      expect(result).toContain("<!-- REASONING");
      expect(result).toContain("I calculated this carefully");
      expect(result).toContain('has-reasoning="true"');
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
      expect(result).toContain("![Image Context](data:image/png;base64,abc123)");
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
          if (Array.isArray(value)) {
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
      const content = createMarkdown({ model: "gpt-4" }, "");

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).toBeNull();
    });

    it("parses basic metadata", () => {
      const content = createMarkdown(
        {
          id: "chat-123",
          model: "gpt-4",
          title: "Test Chat",
          created: "2024-01-01T00:00:00Z",
          lastModified: "2024-01-01T12:00:00Z",
        },
        ""
      );

      const result = ChatMarkdownSerializer.parseMarkdown(content);

      expect(result).not.toBeNull();
      expect(result?.metadata.id).toBe("chat-123");
      expect(result?.metadata.model).toBe("gpt-4");
      expect(result?.metadata.title).toBe("Test Chat");
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

    it("returns true when content has model field", () => {
      const result = (ChatMarkdownSerializer as any).isValidYamlFrontmatter("model: gpt-4");
      expect(result).toBe(true);
    });

    it("returns false when content has neither id nor model", () => {
      const result = (ChatMarkdownSerializer as any).isValidYamlFrontmatter("title: My Chat");
      expect(result).toBe(false);
    });
  });

  describe("round-trip serialization", () => {
    it("preserves message content through serialize and parse", () => {
      const originalMessages: ChatMessage[] = [
        { role: "user", content: "Hello!", message_id: "user-1" },
        { role: "assistant", content: "Hi there!", message_id: "asst-1" },
      ];

      const serialized = ChatMarkdownSerializer.serializeMessages(originalMessages);
      const markdown = `---
id: test-chat
model: gpt-4
---

${serialized}`;

      const parsed = ChatMarkdownSerializer.parseMarkdown(markdown);

      expect(parsed?.messages).toHaveLength(2);
      expect(parsed?.messages[0].content).toContain("Hello!");
      expect(parsed?.messages[1].content).toContain("Hi there!");
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
  });
});
