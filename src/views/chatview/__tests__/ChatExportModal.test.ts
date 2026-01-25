/**
 * @jest-environment jsdom
 */
import { App, Modal, Setting, Notice } from "obsidian";
import { ChatExportModal } from "../ChatExportModal";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Modal: class MockModal {
      app: any;
      contentEl: HTMLElement;

      constructor(app: any) {
        this.app = app;
        this.contentEl = document.createElement("div");
      }

      open() {}
      close() {}
    },
    Setting: jest.fn().mockImplementation(() => ({
      setName: jest.fn().mockReturnThis(),
      setDesc: jest.fn().mockReturnThis(),
      addToggle: jest.fn().mockImplementation((cb) => {
        const toggleEl = document.createElement("div");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        toggleEl.appendChild(checkbox);
        cb({
          setValue: jest.fn().mockReturnThis(),
          onChange: jest.fn().mockReturnThis(),
          toggleEl,
        });
        return {
          settingEl: document.createElement("div"),
        };
      }),
      addButton: jest.fn().mockImplementation((cb) => {
        cb({
          setButtonText: jest.fn().mockReturnThis(),
          setCta: jest.fn().mockReturnThis(),
          onClick: jest.fn().mockReturnThis(),
        });
        return {
          settingEl: document.createElement("div"),
        };
      }),
      addText: jest.fn().mockImplementation((cb) => {
        const input = document.createElement("input");
        cb({
          setPlaceholder: jest.fn().mockReturnThis(),
          setValue: jest.fn().mockReturnThis(),
          onChange: jest.fn().mockReturnThis(),
          inputEl: input,
        });
        return {
          settingEl: document.createElement("div"),
          addText: jest.fn().mockReturnThis(),
        };
      }),
      settingEl: document.createElement("div"),
    })),
    Notice: jest.fn(),
  };
});

// Mock FolderSuggester
jest.mock("../../../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

// Mock errorLogger
jest.mock("../../../utils/errorLogger", () => ({
  errorLogger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock titleUtils
jest.mock("../../../utils/titleUtils", () => ({
  sanitizeChatTitle: jest.fn((title) => title?.replace(/[^a-zA-Z0-9]/g, "_") || "untitled"),
}));

// Mock chatExport types
jest.mock("../../../types/chatExport", () => ({
  createDefaultChatExportOptions: jest.fn().mockReturnValue({
    includeMetadata: true,
    includeSystemPrompt: true,
    includeContextFiles: true,
    includeConversation: true,
    includeUserMessages: true,
    includeAssistantMessages: true,
    includeToolMessages: true,
    includeReasoning: true,
    includeToolCalls: true,
    includeToolCallArguments: false,
    includeToolCallResults: false,
    includeContextFileContents: false,
    includeImages: true,
  }),
  normalizeChatExportOptions: jest.fn((opts) => opts || {}),
}));

describe("ChatExportModal", () => {
  let mockPlugin: any;
  let mockChatView: any;
  let modal: ChatExportModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      app: new App(),
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        chatExportPreferences: null,
      },
    };

    mockChatView = {
      chatId: "test-chat-123",
      getChatTitle: jest.fn().mockReturnValue("Test Chat Title"),
      exportChat: jest.fn().mockResolvedValue({
        content: "# Exported Chat\n\nContent here...",
        context: {
          summary: {
            totalMessages: 10,
            userMessages: 5,
            assistantMessages: 5,
            toolMessages: 2,
            toolCallCount: 3,
            reasoningBlockCount: 1,
            imageCount: 0,
          },
        },
      }),
    };

    modal = new ChatExportModal(mockPlugin, mockChatView);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(ChatExportModal);
    });

    it("initializes state with default folder", () => {
      expect((modal as any).state.folder).toBe("SystemSculpt/Chats");
    });

    it("uses preferences when available", () => {
      mockPlugin.settings.chatExportPreferences = {
        lastFolder: "Custom/Folder",
        lastFileName: "custom-export",
        options: { includeMetadata: false },
        openAfterExport: false,
      };

      const customModal = new ChatExportModal(mockPlugin, mockChatView);

      expect((customModal as any).state.folder).toBe("Custom/Folder");
      expect((customModal as any).state.openAfterExport).toBe(false);
    });

    it("defaults openAfterExport to true", () => {
      expect((modal as any).state.openAfterExport).toBe(true);
    });
  });

  describe("onOpen", () => {
    it("creates title element", async () => {
      await modal.onOpen();

      const heading = modal.contentEl.querySelector("h2");
      expect(heading).not.toBeNull();
      expect(heading?.textContent).toBe("Export Chat");
    });

    it("calls renderSummary", async () => {
      const renderSummarySpy = jest.spyOn(modal as any, "renderSummary");

      await modal.onOpen();

      expect(renderSummarySpy).toHaveBeenCalled();
    });

    it("calls renderOptions", async () => {
      const renderOptionsSpy = jest.spyOn(modal as any, "renderOptions");

      await modal.onOpen();

      expect(renderOptionsSpy).toHaveBeenCalled();
    });

    it("calls renderDestinationInputs", async () => {
      const renderDestinationInputsSpy = jest.spyOn(modal as any, "renderDestinationInputs");

      await modal.onOpen();

      expect(renderDestinationInputsSpy).toHaveBeenCalled();
    });

    it("calls renderActions", async () => {
      const renderActionsSpy = jest.spyOn(modal as any, "renderActions");

      await modal.onOpen();

      expect(renderActionsSpy).toHaveBeenCalled();
    });
  });

  describe("resolvePreferences", () => {
    it("returns default options when no preferences set", () => {
      const prefs = (modal as any).resolvePreferences();

      expect(prefs).toBeDefined();
      expect(prefs.options).toBeDefined();
    });

    it("returns saved preferences when available", () => {
      mockPlugin.settings.chatExportPreferences = {
        lastFolder: "Custom/Path",
        options: { includeMetadata: true },
      };

      const customModal = new ChatExportModal(mockPlugin, mockChatView);
      const prefs = (customModal as any).resolvePreferences();

      expect(prefs.lastFolder).toBe("Custom/Path");
    });
  });

  describe("renderSummary", () => {
    it("calls exportChat to get summary", async () => {
      await modal.onOpen();

      expect(mockChatView.exportChat).toHaveBeenCalled();
    });

    it("displays message counts", async () => {
      await modal.onOpen();

      // Should have called exportChat and rendered summary
      expect(mockChatView.exportChat).toHaveBeenCalledWith((modal as any).state.options);
    });

    it("handles export error gracefully", async () => {
      const { errorLogger } = require("../../../utils/errorLogger");
      mockChatView.exportChat.mockRejectedValue(new Error("Export failed"));

      await modal.onOpen();

      expect(errorLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to render chat summary"),
        expect.any(Object)
      );
    });
  });

  describe("renderOptions", () => {
    it("creates section headings", async () => {
      await modal.onOpen();

      const headings = modal.contentEl.querySelectorAll("h3, h4");
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  describe("generateDefaultFileName", () => {
    it("generates filename from chat title", () => {
      const fileName = (modal as any).generateDefaultFileName();

      // Should be defined (actual format depends on implementation)
      expect(fileName).toBeDefined();
    });
  });

  describe("state management", () => {
    it("tracks folder in state", () => {
      expect((modal as any).state.folder).toBeDefined();
    });

    it("tracks fileName in state", () => {
      expect((modal as any).state.fileName).toBeDefined();
    });

    it("tracks options in state", () => {
      expect((modal as any).state.options).toBeDefined();
    });
  });
});

describe("ChatExportModal option groups", () => {
  let mockPlugin: any;
  let mockChatView: any;
  let modal: ChatExportModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      app: new App(),
      settings: {
        chatsDirectory: "Chats",
        chatExportPreferences: null,
      },
    };

    mockChatView = {
      chatId: "test-123",
      getChatTitle: jest.fn().mockReturnValue("Test"),
      exportChat: jest.fn().mockResolvedValue({
        content: "",
        context: {
          summary: {
            totalMessages: 5,
            userMessages: 2,
            assistantMessages: 3,
            toolMessages: 0,
            toolCallCount: 0,
            reasoningBlockCount: 0,
            imageCount: 0,
          },
        },
      }),
    };

    modal = new ChatExportModal(mockPlugin, mockChatView);
  });

  it("includes Overview group options", async () => {
    await modal.onOpen();

    // Overview group should include metadata, system prompt, context files
    expect((modal as any).state.options.includeMetadata).toBeDefined();
    expect((modal as any).state.options.includeSystemPrompt).toBeDefined();
    expect((modal as any).state.options.includeContextFiles).toBeDefined();
  });

  it("includes Conversation group options", async () => {
    await modal.onOpen();

    expect((modal as any).state.options.includeConversation).toBeDefined();
    expect((modal as any).state.options.includeUserMessages).toBeDefined();
    expect((modal as any).state.options.includeAssistantMessages).toBeDefined();
  });

  it("includes Details group options", async () => {
    await modal.onOpen();

    expect((modal as any).state.options.includeReasoning).toBeDefined();
    expect((modal as any).state.options.includeToolCalls).toBeDefined();
  });
});
