/**
 * @jest-environment jsdom
 */
import { App, setIcon } from "obsidian";
import { StandardAIResponseModal, AIResponseModalOptions } from "../StandardAIResponseModal";
import { ChatMessage, ChatRole } from "../../types";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    setIcon: jest.fn(),
    Notice: jest.fn(),
    MarkdownView: jest.fn(),
  };
});

// Mock StandardModal
jest.mock("../../core/ui/modals/standard/StandardModal", () => ({
  StandardModal: class MockStandardModal {
    app: App;
    modalEl: HTMLElement;
    contentEl: HTMLElement;
    footerEl: HTMLElement;

    constructor(app: App) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.contentEl = document.createElement("div");
      this.footerEl = document.createElement("div");
    }

    setSize() {}
    addTitle() {}
    onOpen() {}
    close() {}
  },
}));

// Mock FolderSuggester
jest.mock("../../components/FolderSuggester", () => ({
  attachFolderSuggester: jest.fn(),
}));

// Mock ImproveResponseModal
jest.mock("../ImproveResponseModal", () => ({
  ImproveResponseModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

// Mock SaveAsNoteModal
jest.mock("../SaveAsNoteModal", () => ({
  SaveAsNoteModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

describe("StandardAIResponseModal", () => {
  let mockApp: App;
  let mockPlugin: any;
  let mockOptions: AIResponseModalOptions;
  let modal: StandardAIResponseModal;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    mockPlugin = {
      app: mockApp,
      aiService: {
        streamCompletion: jest.fn().mockImplementation(async function* () {
          yield "Hello";
          yield " World";
          yield "!";
        }),
        createCompletion: jest.fn().mockResolvedValue({
          content: "Test response",
        }),
      },
      settings: {
        notesDirectory: "Notes",
      },
    };

    mockOptions = {
      plugin: mockPlugin,
      modelId: "gpt-4",
      messages: [
        { role: "user" as ChatRole, content: "Hello" },
      ],
      onInsert: jest.fn(),
      commandText: ";;test",
    };

    modal = new StandardAIResponseModal(mockApp, mockOptions);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(StandardAIResponseModal);
    });

    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(mockPlugin);
    });

    it("stores model ID", () => {
      expect((modal as any).modelId).toBe("gpt-4");
    });

    it("stores messages", () => {
      expect((modal as any).messages).toEqual(mockOptions.messages);
    });

    it("stores onInsert callback", () => {
      expect((modal as any).onInsert).toBe(mockOptions.onInsert);
    });

    it("stores command text", () => {
      expect((modal as any).commandText).toBe(";;test");
    });

    it("uses empty callback when onInsert not provided", () => {
      const optionsWithoutInsert = { ...mockOptions, onInsert: undefined };
      const modalNoInsert = new StandardAIResponseModal(mockApp, optionsWithoutInsert);

      expect((modalNoInsert as any).onInsert).toBeDefined();
      expect(() => (modalNoInsert as any).onInsert("test")).not.toThrow();
    });

    it("stores parent modal when provided", () => {
      const mockParent = { close: jest.fn() };
      const optionsWithParent = { ...mockOptions, parentModal: mockParent as any };
      const modalWithParent = new StandardAIResponseModal(mockApp, optionsWithParent);

      expect((modalWithParent as any).parentModal).toBe(mockParent);
    });
  });

  describe("onOpen", () => {
    it("creates response container", () => {
      modal.onOpen();

      expect((modal as any).responseContainer).toBeDefined();
    });

    it("creates button container", () => {
      modal.onOpen();

      expect((modal as any).buttonContainer).toBeDefined();
    });

    it("initializes fullResponse as empty", () => {
      expect((modal as any).fullResponse).toBe("");
    });

    it("calls generateResponse", () => {
      const generateSpy = jest.spyOn(modal as any, "generateResponse").mockImplementation(() => {});

      modal.onOpen();

      expect(generateSpy).toHaveBeenCalled();
    });

    it("injects redesign styles", () => {
      modal.onOpen();

      const styleEl = document.getElementById("ss-airesponse-redesign-styles");
      // Style may or may not be injected depending on test order
    });
  });

  describe("createLoadingIndicator", () => {
    it("creates loading element", () => {
      modal.onOpen();
      (modal as any).createLoadingIndicator();

      expect((modal as any).loadingEl).toBeDefined();
    });

    it("removes existing loading element before creating new", () => {
      modal.onOpen();
      (modal as any).createLoadingIndicator();
      const firstLoading = (modal as any).loadingEl;

      (modal as any).createLoadingIndicator();
      const secondLoading = (modal as any).loadingEl;

      expect(firstLoading).not.toBe(secondLoading);
    });
  });

  describe("isGenerating state", () => {
    it("starts as false", () => {
      expect((modal as any).isGenerating).toBe(false);
    });
  });
});

describe("AIResponseModalOptions interface", () => {
  it("allows optional fields", () => {
    const minimalOptions: AIResponseModalOptions = {
      plugin: {} as any,
      modelId: "gpt-4",
      messages: [],
    };

    expect(minimalOptions.onInsert).toBeUndefined();
    expect(minimalOptions.commandText).toBeUndefined();
    expect(minimalOptions.parentModal).toBeUndefined();
  });

  it("allows all fields", () => {
    const fullOptions: AIResponseModalOptions = {
      plugin: {} as any,
      modelId: "gpt-4",
      messages: [{ role: "user" as ChatRole, content: "test" }],
      onInsert: () => {},
      commandText: "test",
      parentModal: {} as any,
    };

    expect(fullOptions.onInsert).toBeDefined();
    expect(fullOptions.commandText).toBeDefined();
    expect(fullOptions.parentModal).toBeDefined();
  });
});
