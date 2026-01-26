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

jest.mock("../SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn(() => ({
      getSystemPromptContent: jest.fn().mockResolvedValue("System prompt content"),
    })),
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

jest.mock("../../utils/tooling", () => ({
  mapAssistantToolCallsForApi: jest.fn((toolCalls) =>
    toolCalls.map((tc: any) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.request?.name, arguments: JSON.stringify(tc.request?.arguments || {}) },
    }))
  ),
  buildToolResultMessagesFromToolCalls: jest.fn((toolCalls) =>
    toolCalls
      .filter((tc: any) => tc.result)
      .map((tc: any) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(tc.result),
      }))
  ),
  pruneToolMessagesNotFollowingToolCalls: jest.fn((messages) => ({ messages, dropped: 0 })),
}));

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

    it("handles gif images", async () => {
      const mockFile = new TFile({ path: "images/anim.gif", extension: "gif" });
      (mockApp.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

      const result = await service.getContextFileContents("[[images/anim.gif]]");

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
    it("adds system message at the beginning", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false,
        true
      );

      expect(result[0].role).toBe("system");
    });

    it("uses provided finalSystemPrompt", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false,
        true,
        undefined,
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
        undefined,
        undefined,
        false,
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
        undefined,
        undefined,
        false,
        true
      );

      const userMessage = result.find((m) => m.role === "user");
      expect(userMessage?.documentContext?.documentIds).toContain("12345");
    });

    it("strips tool calls when agent mode is off", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool" },
        {
          role: "assistant",
          content: "Using tool",
          tool_calls: [{ id: "call-1", request: { name: "test", arguments: {} } }] as any,
        },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false, // agent mode off
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect(assistantMessage?.tool_calls).toBeUndefined();
    });

    it("includes tool calls when agent mode is on", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", request: { name: "test", arguments: {} }, result: { success: true } },
          ] as any,
        },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        true, // agent mode on
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect(assistantMessage?.tool_calls).toBeDefined();
    });

    it("keeps tool messages that follow tool_calls when results are not available", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        {
          role: "assistant",
          content: "",
          message_id: "a1",
          tool_calls: [{ id: "call-1", request: { name: "test", arguments: {} } }] as any,
        } as any,
        {
          role: "tool",
          message_id: "t1",
          tool_call_id: "call-1",
          content: "{\"ok\":true}",
        } as any,
        { role: "user", content: "Continue", message_id: "u2" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        true,
        true
      );

      const assistantIndex = result.findIndex((m) => m.role === "assistant" && Array.isArray((m as any).tool_calls));
      expect(assistantIndex).toBeGreaterThan(-1);
      expect(result[assistantIndex + 1]?.role).toBe("tool");
      expect((result[assistantIndex + 1] as any).tool_call_id).toBe("call-1");
    });

    it("drops tool_calls when no matching tool results exist", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Use a tool", message_id: "u1" },
        {
          role: "assistant",
          content: "",
          message_id: "a1",
          tool_calls: [{ id: "call-1", request: { name: "test", arguments: {} } }] as any,
        } as any,
        { role: "user", content: "Continue", message_id: "u2" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        true,
        true
      );

      const assistantMessage = result.find((m) => m.role === "assistant");
      expect((assistantMessage as any)?.tool_calls).toBeUndefined();
    });

    it("filters out tool role messages", async () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
        { role: "tool", content: "Tool result" } as any,
        { role: "assistant", content: "Response" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false,
        true
      );

      const toolMessages = result.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(0);
    });

    it("uses fallback system prompt when none configured", async () => {
      const { SystemPromptService } = require("../SystemPromptService");
      SystemPromptService.getInstance.mockReturnValue({
        getSystemPromptContent: jest.fn().mockRejectedValue(new Error("Not found")),
      });

      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false,
        true
      );

      expect(result[0].role).toBe("system");
      expect(result[0].content).toContain("helpful AI assistant");
    });

    it("injects Bases syntax guide when the latest user message references a .base file", async () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Open Projects.base and update filters" }];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        false,
        true,
        undefined,
        "Custom system prompt"
      );

      expect(result[0].role).toBe("system");
      expect(String(result[0].content)).toContain("<obsidian_bases_syntax_guide>");
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
        undefined,
        undefined,
        false,
        true,
        undefined,
        "Custom system prompt"
      );

      expect(result[0].role).toBe("system");
      expect(String(result[0].content)).toContain("<obsidian_bases_syntax_guide>");
    });
  });

  describe("optimizeToolResultsContext", () => {
    it("filters tool messages when exceeding limit", () => {
      const mockToolCallManager = {
        getMaxToolResultsInContext: () => 2,
        getToolResultsForContext: () => [
          { id: "call-2" },
          { id: "call-3" },
        ],
      };

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Request" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1" },
            { id: "call-2" },
            { id: "call-3" },
          ] as any,
        },
        { role: "tool", tool_call_id: "call-1", content: "Result 1" } as any,
        { role: "tool", tool_call_id: "call-2", content: "Result 2" } as any,
        { role: "tool", tool_call_id: "call-3", content: "Result 3" } as any,
      ];

      service.optimizeToolResultsContext(messages, mockToolCallManager);

      const toolMessages = messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(2);
      expect((toolMessages[0] as any).tool_call_id).toBe("call-2");
      expect((toolMessages[1] as any).tool_call_id).toBe("call-3");
    });

    it("prunes assistant tool_calls to match kept results", () => {
      const mockToolCallManager = {
        getMaxToolResultsInContext: () => 1,
        getToolResultsForContext: () => [{ id: "call-2" }],
      };

      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Using tools",
          tool_calls: [{ id: "call-1" }, { id: "call-2" }] as any,
        },
        { role: "tool", tool_call_id: "call-1", content: "Result 1" } as any,
        { role: "tool", tool_call_id: "call-2", content: "Result 2" } as any,
      ];

      service.optimizeToolResultsContext(messages, mockToolCallManager);

      const assistantMessage = messages.find((m) => m.role === "assistant");
      expect((assistantMessage as any).tool_calls).toHaveLength(1);
      expect((assistantMessage as any).tool_calls[0].id).toBe("call-2");
    });

    it("removes assistant message with no remaining tool_calls and no content", () => {
      const mockToolCallManager = {
        getMaxToolResultsInContext: () => 1,
        getToolResultsForContext: () => [{ id: "other-call" }],
      };

      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-1" }] as any,
        },
        { role: "tool", tool_call_id: "call-1", content: "Result 1" } as any,
        { role: "tool", tool_call_id: "other-call", content: "Result 2" } as any,
      ];

      service.optimizeToolResultsContext(messages, mockToolCallManager);

      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(0);
    });

    it("keeps assistant message with content but removes tool_calls", () => {
      const mockToolCallManager = {
        getMaxToolResultsInContext: () => 1,
        getToolResultsForContext: () => [{ id: "other-call" }],
      };

      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "I'm using a tool",
          tool_calls: [{ id: "call-1" }] as any,
        },
        { role: "tool", tool_call_id: "call-1", content: "Result 1" } as any,
        { role: "tool", tool_call_id: "other-call", content: "Result 2" } as any,
      ];

      service.optimizeToolResultsContext(messages, mockToolCallManager);

      const assistantMessage = messages.find((m) => m.role === "assistant");
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage?.content).toBe("I'm using a tool");
      expect((assistantMessage as any).tool_calls).toBeUndefined();
    });

    it("uses default max of 15 when not provided", () => {
      const mockToolCallManager = {
        getToolResultsForContext: () => [],
      };

      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
      ];

      // Should not throw
      expect(() => {
        service.optimizeToolResultsContext(messages, mockToolCallManager);
      }).not.toThrow();
    });
  });

  describe("hydrateToolCalls", () => {
    it("merges tool call data from manager", async () => {
      const mockToolCallManager = {
        getToolCall: jest.fn((id) => {
          if (id === "call-1") {
            return {
              id: "call-1",
              request: { name: "test_tool", arguments: { key: "value" } },
              result: { success: true },
              state: "completed",
            };
          }
          return undefined;
        }),
        getToolResultsForContext: jest.fn(() => []),
      };

      const messages: ChatMessage[] = [
        { role: "user", content: "Use tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-1" }] as any,
        },
      ];

      const result = await service.prepareMessagesWithContext(
        messages,
        new Set(),
        undefined,
        undefined,
        true, // agent mode
        true,
        mockToolCallManager
      );

      expect(mockToolCallManager.getToolCall).toHaveBeenCalledWith("call-1");
    });
  });
});
