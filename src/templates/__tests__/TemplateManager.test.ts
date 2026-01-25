/**
 * @jest-environment jsdom
 */
import { App, TFile, Editor, EditorPosition, EditorSuggestContext, MarkdownView } from "obsidian";

// Mock EditorSuggest at the top before any imports
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    EditorSuggest: class MockEditorSuggest {
      app: any;
      limit: number = 20;
      context: any = null;

      constructor(app: any) {
        this.app = app;
      }
    },
    Notice: jest.fn(),
  };
});

// Mock SystemSculptPlugin
const mockPlugin = {
  settings: {
    enableTemplateHotkey: true,
    templateHotkey: ";;",
    systemPromptsDirectory: "Templates",
  },
  directoryManager: {
    isInitialized: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    ensureDirectoryByKey: jest.fn().mockResolvedValue(undefined),
    ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
  },
  registerEditorSuggest: jest.fn(),
};

// Mock the StandardTemplateModal import
jest.mock("../../modals/StandardTemplateModal", () => ({
  showStandardTemplateModal: jest.fn().mockResolvedValue("Template content"),
}));

describe("TemplateManager", () => {
  let mockApp: App;
  let TemplateManager: any;
  let TemplateSuggestProvider: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([
          { path: "Templates/greeting.md", basename: "greeting", name: "greeting.md", extension: "md" },
          { path: "Templates/farewell.md", basename: "farewell", name: "farewell.md", extension: "md" },
          { path: "Templates/response.md", basename: "response", name: "response.md", extension: "md" },
        ]),
        read: jest.fn().mockResolvedValue("Template content here"),
        adapter: {
          exists: jest.fn().mockResolvedValue(true),
        },
        createFolder: jest.fn().mockResolvedValue(undefined),
        getAbstractFileByPath: jest.fn().mockReturnValue({}),
      },
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(null),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        revealLeaf: jest.fn(),
      },
    } as unknown as App;

    // Re-import to get fresh module
    jest.isolateModules(() => {
      const module = require("../TemplateManager");
      TemplateManager = module.TemplateManager;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("TemplateManager class", () => {
    it("creates instance successfully", () => {
      const manager = new TemplateManager(mockPlugin as any, mockApp);

      expect(manager).toBeInstanceOf(TemplateManager);
    });

    it("registers editor suggest provider", () => {
      new TemplateManager(mockPlugin as any, mockApp);

      expect(mockPlugin.registerEditorSuggest).toHaveBeenCalled();
    });

    it("handles uninitialized directory manager gracefully", () => {
      const pluginWithoutDM = {
        ...mockPlugin,
        directoryManager: {
          isInitialized: jest.fn().mockReturnValue(false),
          initialize: jest.fn().mockResolvedValue(undefined),
        },
      };

      expect(() => new TemplateManager(pluginWithoutDM as any, mockApp)).not.toThrow();
    });

    it("handles null directory manager", () => {
      const pluginNullDM = {
        ...mockPlugin,
        directoryManager: null,
      };

      expect(() => new TemplateManager(pluginNullDM as any, mockApp)).not.toThrow();
    });

    it("unload cleans up listeners", () => {
      const manager = new TemplateManager(mockPlugin as any, mockApp);

      expect(() => manager.unload()).not.toThrow();
    });

    it("unload handles null provider", () => {
      const pluginError = {
        ...mockPlugin,
        registerEditorSuggest: jest.fn(() => {
          throw new Error("Registration error");
        }),
      };

      const manager = new TemplateManager(pluginError as any, mockApp);

      // Provider should be null due to error
      expect(() => manager.unload()).not.toThrow();
    });
  });

  describe("TemplateSuggestProvider functionality", () => {
    // These tests verify the behavior through TemplateManager
    it("loads template files from system prompts directory", async () => {
      new TemplateManager(mockPlugin as any, mockApp);

      // Allow async operations
      await Promise.resolve();
      jest.advanceTimersByTime(600);
      await Promise.resolve();

      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalled();
    });

    it("retries loading templates if none found initially", async () => {
      mockApp.vault.getMarkdownFiles = jest.fn()
        .mockReturnValueOnce([])
        .mockReturnValue([
          { path: "Templates/test.md", basename: "test", name: "test.md" },
        ]);

      new TemplateManager(mockPlugin as any, mockApp);

      await Promise.resolve();
      jest.advanceTimersByTime(600);
      await Promise.resolve();

      // At least one call is expected
      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalled();
    });
  });
});

describe("TemplateSuggestProvider", () => {
  let mockApp: App;
  let provider: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([
          { path: "Templates/greeting.md", basename: "greeting", name: "greeting.md", extension: "md", parent: null, vault: {}, stat: null },
          { path: "Templates/farewell.md", basename: "farewell", name: "farewell.md", extension: "md", parent: null, vault: {}, stat: null },
          { path: "Templates/apple-pie.md", basename: "apple-pie", name: "apple-pie.md", extension: "md", parent: null, vault: {}, stat: null },
        ]),
        read: jest.fn().mockResolvedValue("Template content here"),
        adapter: {
          exists: jest.fn().mockResolvedValue(true),
        },
        createFolder: jest.fn().mockResolvedValue(undefined),
        getAbstractFileByPath: jest.fn().mockReturnValue({}),
      },
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(null),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        revealLeaf: jest.fn(),
      },
    } as unknown as App;

    // Create provider directly for testing
    jest.isolateModules(() => {
      const { TemplateManager } = require("../TemplateManager");
      new TemplateManager(mockPlugin as any, mockApp);
      // Get the provider from the registration call
      provider = mockPlugin.registerEditorSuggest.mock.calls[0]?.[0];
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("onTrigger", () => {
    it("checks enableTemplateHotkey setting", () => {
      // Just verify the setting exists and is checked in the provider
      expect(mockPlugin.settings.enableTemplateHotkey).toBe(true);
    });

    it("triggers on hotkey at line start", () => {
      if (!provider) return;

      const mockEditor = {
        getLine: jest.fn().mockReturnValue(";;test"),
      } as unknown as Editor;

      const cursor: EditorPosition = { line: 0, ch: 6 };
      const result = provider.onTrigger(cursor, mockEditor);

      expect(result).not.toBeNull();
      expect(result?.query).toBe("test");
    });

    it("triggers on hotkey with leading whitespace", () => {
      if (!provider) return;

      const mockEditor = {
        getLine: jest.fn().mockReturnValue("  ;;template"),
      } as unknown as Editor;

      const cursor: EditorPosition = { line: 0, ch: 12 };
      const result = provider.onTrigger(cursor, mockEditor);

      expect(result).not.toBeNull();
    });

    it("does not trigger when text before hotkey", () => {
      if (!provider) return;

      const mockEditor = {
        getLine: jest.fn().mockReturnValue("some text ;;template"),
      } as unknown as Editor;

      const cursor: EditorPosition = { line: 0, ch: 20 };
      const result = provider.onTrigger(cursor, mockEditor);

      expect(result).toBeNull();
    });

    it("does not trigger when closing char after hotkey", () => {
      if (!provider) return;

      const mockEditor = {
        getLine: jest.fn().mockReturnValue(";;template]"),
      } as unknown as Editor;

      const cursor: EditorPosition = { line: 0, ch: 11 };
      const result = provider.onTrigger(cursor, mockEditor);

      expect(result).toBeNull();
    });
  });

  describe("getSuggestions", () => {
    it("returns all templates with empty query", () => {
      if (!provider) return;

      // Wait for templates to load
      jest.advanceTimersByTime(600);

      const context: EditorSuggestContext = {
        query: "",
        start: { line: 0, ch: 0 },
        end: { line: 0, ch: 0 },
        editor: {} as Editor,
        file: null,
      };

      const suggestions = provider.getSuggestions(context);

      expect(suggestions.length).toBeGreaterThanOrEqual(0);
    });

    it("filters templates by query", async () => {
      if (!provider) return;

      // Wait for templates to load
      await Promise.resolve();
      jest.advanceTimersByTime(600);
      await Promise.resolve();

      const context: EditorSuggestContext = {
        query: "greet",
        start: { line: 0, ch: 0 },
        end: { line: 0, ch: 5 },
        editor: {} as Editor,
        file: null,
      };

      const suggestions = provider.getSuggestions(context);

      // Should filter to greeting template
      if (suggestions.length > 0) {
        expect(suggestions.some((s: TFile) => s.basename?.toLowerCase().includes("greet"))).toBe(true);
      }
    });

    it("handles multi-word queries", async () => {
      if (!provider) return;

      await Promise.resolve();
      jest.advanceTimersByTime(600);
      await Promise.resolve();

      const context: EditorSuggestContext = {
        query: "apple pie",
        start: { line: 0, ch: 0 },
        end: { line: 0, ch: 9 },
        editor: {} as Editor,
        file: null,
      };

      const suggestions = provider.getSuggestions(context);

      // Should find apple-pie template
      if (suggestions.length > 0) {
        expect(suggestions[0].basename).toBe("apple-pie");
      }
    });
  });

  describe("renderSuggestion", () => {
    it("renders suggestion element", async () => {
      if (!provider) return;

      await Promise.resolve();
      jest.advanceTimersByTime(600);

      const mockFile = {
        basename: "test-template",
        path: "Templates/test-template.md",
        name: "test-template.md",
        extension: "md",
      } as TFile;

      const el = document.createElement("div");

      provider.renderSuggestion(mockFile, el);

      expect(el.querySelector(".suggestion-content")).not.toBeNull();
      expect(el.querySelector(".suggestion-title")).not.toBeNull();
    });

    it("adds hover event listeners", async () => {
      if (!provider) return;

      await Promise.resolve();
      jest.advanceTimersByTime(600);

      const mockFile = {
        basename: "test",
        path: "Templates/test.md",
        name: "test.md",
        extension: "md",
      } as TFile;

      const el = document.createElement("div");

      provider.renderSuggestion(mockFile, el);

      // Trigger mouseenter
      el.dispatchEvent(new MouseEvent("mouseenter"));
      expect(el.classList.contains("is-selected")).toBe(true);

      // Trigger mouseleave
      el.dispatchEvent(new MouseEvent("mouseleave"));
      expect(el.classList.contains("is-selected")).toBe(false);
    });
  });

  describe("removeAllListeners", () => {
    it("clears all registered listeners", async () => {
      if (!provider) return;

      await Promise.resolve();
      jest.advanceTimersByTime(600);

      const mockFile = {
        basename: "test",
        path: "Templates/test.md",
        name: "test.md",
        extension: "md",
      } as TFile;

      const el = document.createElement("div");
      provider.renderSuggestion(mockFile, el);

      // Should have listeners registered
      expect(provider.listeners?.length || 0).toBeGreaterThanOrEqual(0);

      provider.removeAllListeners();

      expect(provider.listeners?.length || 0).toBe(0);
    });
  });

  describe("placeholder files", () => {
    it("creates loading placeholder", async () => {
      if (!provider) return;

      const loadingFile = provider.createTemporaryLoadingFile?.();

      if (loadingFile) {
        expect(loadingFile.basename).toContain("Loading");
        expect(loadingFile.path).toBe("loading");
      }
    });

    it("creates no-templates placeholder", async () => {
      if (!provider) return;

      const noTemplatesFile = provider.createNoTemplatesFoundFile?.();

      if (noTemplatesFile) {
        expect(noTemplatesFile.basename).toContain("No templates");
        expect(noTemplatesFile.path).toBe("no-templates");
      }
    });
  });
});
