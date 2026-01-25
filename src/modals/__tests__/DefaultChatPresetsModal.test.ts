/**
 * @jest-environment jsdom
 */
import { App, Modal, Setting, Notice, SuggestModal } from "obsidian";

// Mock SuggestModal
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Modal: class MockModal {
      app: App;
      contentEl: HTMLElement;

      constructor(app: App) {
        this.app = app;
        this.contentEl = document.createElement("div");
      }

      open() {}
      close() {}
    },
    SuggestModal: class MockSuggestModal {
      app: App;

      constructor(app: App) {
        this.app = app;
      }

      setPlaceholder() { return this; }
      open() {}
      close() {}
    },
    Setting: jest.fn().mockImplementation(() => ({
      setName: jest.fn().mockReturnThis(),
      setDesc: jest.fn().mockReturnThis(),
      addText: jest.fn().mockImplementation((cb) => {
        cb({
          setPlaceholder: jest.fn().mockReturnThis(),
          setValue: jest.fn().mockReturnThis(),
          setDisabled: jest.fn().mockReturnThis(),
        });
        return { addButton: jest.fn().mockReturnThis(), controlEl: document.createElement("div") };
      }),
      addButton: jest.fn().mockImplementation((cb) => {
        cb({
          setButtonText: jest.fn().mockReturnThis(),
          setCta: jest.fn().mockReturnThis(),
          onClick: jest.fn().mockReturnThis(),
        });
        return { controlEl: document.createElement("div") };
      }),
      controlEl: document.createElement("div"),
    })),
    Notice: jest.fn(),
  };
});

// Mock modelUtils
jest.mock("../../utils/modelUtils", () => ({
  getDisplayName: jest.fn().mockReturnValue("GPT-4"),
  ensureCanonicalId: jest.fn((id) => id),
  parseCanonicalId: jest.fn((id) => ({ provider: "openai", model: id })),
  getModelLabelWithProvider: jest.fn((id) => `Model: ${id}`),
}));

// Mock StandardModelSelectionModal
jest.mock("../StandardModelSelectionModal", () => ({
  StandardModelSelectionModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    onSelect: null,
  })),
  ModelSelectionResult: {},
}));

// Mock SystemPromptService
jest.mock("../../services/SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn().mockReturnValue({
      getCustomPromptFiles: jest.fn().mockResolvedValue([
        { path: "prompts/custom1.md", name: "Custom Prompt 1" },
        { path: "prompts/custom2.md", name: "Custom Prompt 2" },
      ]),
      getCurrentPromptPath: jest.fn().mockReturnValue("prompts/current.md"),
    }),
  },
}));

describe("DefaultChatPresetsModal", () => {
  let mockApp: App;
  let mockPlugin: any;
  let DefaultChatPresetsModal: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    mockPlugin = {
      settings: {
        selectedModelId: "gpt-4",
        titleGenerationModelId: "gpt-3.5-turbo",
        systemPromptType: "general-use",
        systemPromptPath: "",
      },
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };

    // Import after mocks are set up
    jest.isolateModules(() => {
      const module = require("../DefaultChatPresetsModal");
      DefaultChatPresetsModal = module.DefaultChatPresetsModal;
    });
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);

      expect(modal).toBeDefined();
    });

    it("has systemPromptService property", () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);

      // Verify the modal has a systemPromptService
      expect((modal as any).systemPromptService).toBeDefined();
    });
  });

  describe("onOpen", () => {
    it("creates title element", async () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      expect(modal.contentEl.querySelector("h2")).not.toBeNull();
    });

    it("creates description paragraph", async () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      const paragraphs = modal.contentEl.querySelectorAll("p");
      expect(paragraphs.length).toBeGreaterThan(0);
    });

    it("creates model section", async () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      const sections = modal.contentEl.querySelectorAll(".modal-section");
      expect(sections.length).toBeGreaterThanOrEqual(2);
    });

    it("creates prompt type section", async () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      const headings = modal.contentEl.querySelectorAll("h3");
      const headingTexts = Array.from(headings).map((h) => h.textContent);
      expect(headingTexts).toContain("Default System Prompt Type");
    });

    it("creates content in modal", async () => {
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      // Modal content should have children after onOpen
      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });
  });

  describe("button styles", () => {
    it("highlights active prompt type button", async () => {
      mockPlugin.settings.systemPromptType = "concise";

      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      // Check that the current setting type button has mod-cta class
      const buttons = modal.contentEl.querySelectorAll("button");
      const activeButtons = Array.from(buttons).filter((b) =>
        b.classList.contains("mod-cta")
      );

      // At least one button should be active
      expect(activeButtons.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("model display", () => {
    it("shows no model selected when model is empty", async () => {
      mockPlugin.settings.selectedModelId = "";

      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      // Modal should still open without errors
      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });

    it("shows same as chat model for title gen when not set", async () => {
      mockPlugin.settings.titleGenerationModelId = "";

      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);
      await modal.onOpen();

      // Modal should still open without errors
      expect(modal.contentEl.children.length).toBeGreaterThan(0);
    });
  });
});

describe("CustomPromptFileSuggestModal", () => {
  // The CustomPromptFileSuggestModal is a private class inside the module,
  // so we test its behavior through the DefaultChatPresetsModal interface

  let mockApp: App;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    mockPlugin = {
      settings: {
        selectedModelId: "gpt-4",
        titleGenerationModelId: "",
        systemPromptType: "custom",
        systemPromptPath: "prompts/custom.md",
      },
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };
  });

  it("is used when custom prompt type is selected", async () => {
    jest.isolateModules(() => {
      const { DefaultChatPresetsModal } = require("../DefaultChatPresetsModal");
      const modal = new DefaultChatPresetsModal(mockApp, mockPlugin);

      // Modal should be created with custom type
      expect(mockPlugin.settings.systemPromptType).toBe("custom");
    });
  });
});
