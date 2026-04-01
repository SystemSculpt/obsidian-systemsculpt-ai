/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { ContextFileService } from "../ContextFileService";
import { ChatMessage } from "../../types";

// Mock dependencies
jest.mock("../../utils/ImageProcessor", () => ({
  ImageProcessor: {
    processImage: jest.fn().mockResolvedValue("base64encodedimage"),
  },
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("../../utils/cryptoUtils", () => ({
  simpleHash: jest.fn((input) => `hash_${input.slice(0, 10)}`),
}));

jest.mock("../../utils/tooling", () => {
  const actual = jest.requireActual("../../utils/tooling");
  return {
    ...actual,
    buildToolResultMessagesFromToolCalls: jest.fn(actual.buildToolResultMessagesFromToolCalls),
    pruneToolMessagesNotFollowingToolCalls: jest.fn(actual.pruneToolMessagesNotFollowingToolCalls),
  };
});

describe("ContextFileService", () => {
  let service: ContextFileService;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = new App();
    service = new ContextFileService(mockApp);

    // Default mock behaviors
    (mockApp.vault.read as jest.Mock).mockResolvedValue("File content");
    (mockApp.vault.getFiles as jest.Mock).mockReturnValue([]);
    (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(null);
  });

  describe("getContextFileContents", () => {
    it("reads text file content", async () => {
      const mockFile = new TFile({ path: "notes/test.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Test content");

      const result = await service.getContextFileContents("[[notes/test.md]]");

      expect(result).toBe("Test content");
    });

    it("returns image data for image files", async () => {
      const mockFile = new TFile({ path: "images/photo.png", extension: "png" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.getContextFileContents("[[images/photo.png]]");

      expect(result).toEqual({ type: "image", base64: "base64encodedimage" });
    });

    it("handles wiki link format", async () => {
      const mockFile = new TFile({ path: "notes/test.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      await service.getContextFileContents("[[notes/test.md]]");

      expect(mockApp.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith("notes/test.md", "");
    });

    it("tries to find file by name if not found by path", async () => {
      const mockFile = new TFile({ path: "somewhere/test.md", extension: "md", name: "test.md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(null);
      (mockApp.vault.getFiles as jest.Mock).mockReturnValue([mockFile]);

      const result = await service.getContextFileContents("[[test.md]]");

      expect(result).toBe("File content");
    });

    it("returns null when file not found", async () => {
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(null);
      (mockApp.vault.getFiles as jest.Mock).mockReturnValue([]);

      const result = await service.getContextFileContents("[[nonexistent.md]]");

      expect(result).toBeNull();
    });

    it("returns null on error", async () => {
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockImplementation(() => {
        throw new Error("Access error");
      });

      const result = await service.getContextFileContents("[[test.md]]");

      expect(result).toBeNull();
    });

    it("handles jpg images", async () => {
      const mockFile = new TFile({ path: "images/photo.jpg", extension: "jpg" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.getContextFileContents("[[images/photo.jpg]]");

      expect(result).toEqual({ type: "image", base64: "base64encodedimage" });
    });

    it("handles jpeg images", async () => {
      const mockFile = new TFile({ path: "images/photo.jpeg", extension: "jpeg" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.getContextFileContents("[[images/photo.jpeg]]");

      expect(result).toEqual({ type: "image", base64: "base64encodedimage" });
    });

    it("handles webp images", async () => {
      const mockFile = new TFile({ path: "images/photo.webp", extension: "webp" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.getContextFileContents("[[images/photo.webp]]");

      expect(result).toEqual({ type: "image", base64: "base64encodedimage" });
    });
  });

  describe("buildContextMessageFromFile", () => {
    it("builds text context message", async () => {
      const mockFile = new TFile({ path: "notes/test.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Document content");

      const result = await service.buildContextMessageFromFile("[[notes/test.md]]", true);

      expect(result).not.toBeNull();
      expect(result?.role).toBe("user");
      expect(result?.content).toContain("Context from [[notes/test.md]]");
      expect(result?.content).toContain("Document content");
    });

    it("builds image context message when includeImages is true", async () => {
      const mockFile = new TFile({ path: "images/photo.png", extension: "png" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.buildContextMessageFromFile("[[images/photo.png]]", true);

      expect(result).not.toBeNull();
      expect(result?.role).toBe("user");
      expect(Array.isArray(result?.content)).toBe(true);
    });

    it("returns null for images when includeImages is false", async () => {
      const result = await service.buildContextMessageFromFile("[[images/photo.png]]", false);

      expect(result).toBeNull();
    });

    it("returns null when file not found", async () => {
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(null);
      (mockApp.vault.getFiles as jest.Mock).mockReturnValue([]);

      const result = await service.buildContextMessageFromFile("[[nonexistent.md]]", true);

      expect(result).toBeNull();
    });

    it("generates deterministic message_id", async () => {
      const mockFile = new TFile({ path: "notes/test.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result1 = await service.buildContextMessageFromFile("[[notes/test.md]]", true);
      const result2 = await service.buildContextMessageFromFile("[[notes/test.md]]", true);

      expect(result1?.message_id).toBe(result2?.message_id);
    });
  });

  describe("prepareMessagesWithContext", () => {
    it("keeps the transcript user-first when no server prompt is supplied", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      expect(result[0].role).toBe("user");
    });

    it("uses provided finalSystemPrompt", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true,
        "Custom system prompt"
      );

      expect(result[0].content).toBe("Custom system prompt");
    });

    it("adds context files before last user message", async () => {
      const mockFile = new TFile({ path: "notes/context.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Context content");

      const messages: ChatMessage[] = [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Second message" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(["[[notes/context.md]]"]),
        true
      );

      // Context should be before the last user message
      const contextIndex = result.findIndex((m) => m.content?.toString().includes("Context from"));
      const lastUserIndex = result.length - 1;
      expect(contextIndex).toBeLessThan(lastUserIndex);
    });

    it("handles document references", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(["doc:12345"]),
        true
      );

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.documentContext?.documentIds).toContain("12345");
    });

    it("preserves assistant tool calls when matching explicit tool results exist", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        {
          role: "assistant",
          content: "Using tool",
          message_id: "a1",
          tool_calls: [
            { id: "call-1", function: { name: "mcp-filesystem_read", arguments: "{}" } },
          ] as any,
        } as any,
        {
          role: "tool",
          message_id: "t1",
          tool_call_id: "call-1",
          content: "{\"ok\":true}",
        } as any,
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect((assistantMessage as any)?.tool_calls).toEqual([
        { id: "call-1", function: { name: "mcp-filesystem_read", arguments: "{}" } },
      ]);
      expect(result.find((m) => m.role === "tool")).toEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: "{\"ok\":true}",
        })
      );
    });

    it("synthesizes tool role messages from completed tool calls when explicit results are absent", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        {
          role: "assistant",
          content: "",
          message_id: "a1",
          tool_calls: [
            {
              id: "call-1",
              function: { name: "mcp-filesystem_read", arguments: "{}" },
              state: "completed",
              result: { success: true, data: { ok: true } },
            },
          ] as any,
        } as any,
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect((assistantMessage as any)?.tool_calls).toEqual([
        expect.objectContaining({ id: "call-1" }),
      ]);
      expect(result).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: JSON.stringify({ ok: true }),
        })
      );
    });

    it("drops unresolved tool_calls when no matching tool results exist", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        {
          role: "assistant",
          content: "",
          message_id: "a1",
          tool_calls: [{ id: "call-1", function: { name: "mcp-filesystem_read", arguments: "{}" } }] as any,
        } as any,
        { role: "user", content: "Continue", message_id: "u2" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect((assistantMessage as any)?.tool_calls).toBeUndefined();
      expect(result.filter((m) => m.role === "tool")).toHaveLength(0);
    });

    it("expands a compact assistant message into chronological assistant/tool transport rounds", async () => {
      const firstToolCall = {
        id: "call-1",
        messageId: "assistant-root",
        request: {
          id: "call-1",
          type: "function",
          function: {
            name: "mcp-filesystem_search",
            arguments: "{\"patterns\":[\"vault\"]}",
          },
        },
        state: "completed",
        result: {
          success: true,
          data: { results: ["alpha.md"] },
        },
      } as any;

      const secondToolCall = {
        id: "call-2",
        messageId: "assistant-root",
        request: {
          id: "call-2",
          type: "function",
          function: {
            name: "mcp-filesystem_read",
            arguments: "{\"paths\":[\"alpha.md\"]}",
          },
        },
        state: "completed",
        result: {
          success: true,
          data: { contents: ["Alpha content"] },
        },
      } as any;

      const messages: ChatMessage[] = [
        { role: "user", content: "Summarize the vault", message_id: "u1" } as any,
        {
          role: "assistant",
          content: "Final summary.",
          message_id: "assistant-root",
          tool_calls: [firstToolCall, secondToolCall],
          messageParts: [
            {
              id: "reasoning-1",
              type: "reasoning",
              timestamp: 1,
              data: "Need to search first.",
            },
            {
              id: "tool-call-1",
              type: "tool_call",
              timestamp: 2,
              data: firstToolCall,
            },
            {
              id: "reasoning-2",
              type: "reasoning",
              timestamp: 3,
              data: "Now read the hit.",
            },
            {
              id: "tool-call-2",
              type: "tool_call",
              timestamp: 4,
              data: secondToolCall,
            },
            {
              id: "content-1",
              type: "content",
              timestamp: 5,
              data: "Final summary.",
            },
          ],
        } as any,
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      expect(result.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
        "assistant",
      ]);

      const assistantMessages = result.filter((message) => message.role === "assistant");
      expect((assistantMessages[0] as any)?.tool_calls?.map((toolCall: any) => toolCall.id)).toEqual(["call-1"]);
      expect(assistantMessages[0]?.content).toBe("");
      expect((result[2] as any)?.tool_call_id).toBe("call-1");

      expect((assistantMessages[1] as any)?.tool_calls?.map((toolCall: any) => toolCall.id)).toEqual(["call-2"]);
      expect(assistantMessages[1]?.content).toBe("");
      expect((result[4] as any)?.tool_call_id).toBe("call-2");

      expect((assistantMessages[2] as any)?.tool_calls).toBeUndefined();
      expect(assistantMessages[2]?.content).toBe("Final summary.");
    });

    it("prunes orphan tool role messages that do not follow assistant tool calls", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        { role: "tool", content: "orphan tool result", tool_call_id: "orphan-call", message_id: "t0" } as any,
        {
          role: "assistant",
          content: "No tool",
          message_id: "a1",
        },
        { role: "user", content: "Continue", message_id: "u2" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      expect(result.filter((m) => m.role === "tool")).toHaveLength(0);
    });

    it("keeps context insertion and document refs aligned after orphan tool pruning", async () => {
      const mockFile = new TFile({ path: "notes/context.md", extension: "md" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Context content");

      const messages: ChatMessage[] = [
        { role: "user", content: "Earlier", message_id: "u1" },
        { role: "tool", content: "orphan tool result", tool_call_id: "orphan-call", message_id: "t0" } as any,
        { role: "assistant", content: "Intermediate", message_id: "a1" },
        { role: "user", content: "Latest", message_id: "u2" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(["[[notes/context.md]]", "doc:12345"]),
        true
      );

      const latestUserIndex = result.findIndex((m) => m.message_id === "u2");
      const contextIndex = result.findIndex((m) => String(m.content || "").includes("Context from [[notes/context.md]]"));
      expect(contextIndex).toBeGreaterThan(-1);
      expect(contextIndex).toBeLessThan(latestUserIndex);
      expect(result[latestUserIndex]?.documentContext?.documentIds).toEqual(["12345"]);
    });

    it("omits a system message when none is provided", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      expect(result[0].role).toBe("user");
      expect(result.find((message) => message.role === "system")).toBeUndefined();
    });

    it("injects Bases syntax guide when the latest user message references a .base file", async () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Open Projects.base and update filters" }];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true,
        "Custom system prompt"
      );

      expect(result[0].role).toBe("system");
      expect(String(result[0].content)).toContain("<obsidian_bases_syntax_guide>");
    });

    it("does not inject a Bases guide on its own when no server prompt override is provided", async () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Open Projects.base and update filters" }];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true
      );

      expect(result).toEqual(messages);
      expect(result.find((message) => message.role === "system")).toBeUndefined();
    });

    it("injects Bases syntax guide when a tool call targets a .base path", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Update the database view" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              request: {
                function: {
                  arguments: JSON.stringify({ path: "Views/Projects.base" }),
                },
              },
            },
          ] as any,
        } as any,
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        true,
        "Custom system prompt"
      );

      expect(result[0].role).toBe("system");
      expect(String(result[0].content)).toContain("<obsidian_bases_syntax_guide>");
    });
  });

});
