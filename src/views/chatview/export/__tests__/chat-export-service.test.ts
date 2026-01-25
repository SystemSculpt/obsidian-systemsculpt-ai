import { TFile } from "obsidian";
import { ChatExportService } from "../ChatExportService";
import { SystemPromptService } from "../../../../services/SystemPromptService";

jest.mock("../../../../services/SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn(),
  },
}));

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
    selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    currentModelName: "SystemSculpt Agent",
    webSearchEnabled: true,
    systemPromptType: "general-use",
    systemPromptPath: "",
    agentMode: false,
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
      type: "function",
      function: { name: "mcp-filesystem_search", arguments: "{}" },
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
        reasoning: "thinking",
        tool_calls: [toolCall],
        message_id: "3",
      },
    ];

    const promptService = {
      getSystemPromptContent: jest.fn(async () => "PROMPT"),
      combineWithAgentPrefix: jest.fn(async () => "COMBINED"),
    };
    (SystemPromptService.getInstance as jest.Mock).mockReturnValue(promptService);

    app.metadataCache.getFirstLinkpathDest.mockImplementation((path: string) => {
      if (path === "Note") return new TFile({ path: "Note.md" });
      if (path === "Image.png") return new TFile({ path: "Image.png" });
      return null;
    });

    const service = new ChatExportService(chatView);
    const result = await service.export({
      includeContextFiles: true,
      includeContextFileContents: true,
      includeSystemPrompt: true,
    });

    expect(result.context.systemPrompt?.content).toBe("COMBINED");
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

