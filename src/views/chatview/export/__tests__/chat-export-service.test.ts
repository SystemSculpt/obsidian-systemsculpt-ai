import { TFile } from "obsidian";
import { ChatExportService } from "../ChatExportService";

const createChatView = () => {
  const app: any = {
    metadataCache: {
      getFirstLinkpathDest: jest.fn(),
    },
    vault: {
      read: jest.fn(async () => "Note content"),
    },
  };

  const chatView: any = {
    app,
    plugin: { settings: {} },
    chatTitle: "Test Chat",
    chatId: "chat-1",
    chatVersion: 2,
    webSearchEnabled: true,
    contextManager: {
      getContextFiles: jest.fn(() => new Set(["[[Note]]", "[[Image.png]]", "doc:extract.md"])),
    },
    messages: [],
  };

  return { app, chatView };
};

describe("ChatExportService", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("builds export context with summary and context files", async () => {
    const { app, chatView } = createChatView();

    const toolCall = {
      id: "call-1",
      messageId: "3",
      request: {
        id: "call-1",
        type: "function",
        function: { name: "search", arguments: "{}" },
      },
      state: "completed",
      timestamp: 2,
      result: { success: true, data: { matches: [] } },
    };

    chatView.messages = [
      { role: "user", content: "Hello", message_id: "1" },
      {
        role: "assistant",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
        message_id: "2",
      },
      {
        role: "assistant",
        content: "Result",
        tool_calls: [toolCall],
        messageParts: [
          { id: "reasoning-1", type: "reasoning", timestamp: 1, data: "thinking" },
          { id: "tool-1", type: "tool_call", timestamp: 2, data: toolCall },
          { id: "content-1", type: "content", timestamp: 3, data: "Result" },
        ],
        message_id: "3",
      },
    ];

    app.metadataCache.getFirstLinkpathDest.mockImplementation((path: string) => {
      if (path === "Note") return new TFile({ path: "Note.md" });
      if (path === "Image.png") return new TFile({ path: "Image.png" });
      return null;
    });

    const service = new ChatExportService(chatView);
    const result = await service.export({
      includeContextFiles: true,
      includeContextFileContents: true,
    });

    expect(result.context.summary.totalMessages).toBe(3);
    expect(result.context.summary.userMessages).toBe(1);
    expect(result.context.summary.assistantMessages).toBe(2);
    expect(result.context.summary.toolCallCount).toBe(1);
    expect(result.context.summary.reasoningBlockCount).toBe(1);
    expect(result.context.summary.imageCount).toBe(1);

    const contextFiles = result.context.contextFiles;
    expect(contextFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Note", content: "Note content" }),
        expect.objectContaining({ path: "Image.png" }),
      ])
    );
  });
});
