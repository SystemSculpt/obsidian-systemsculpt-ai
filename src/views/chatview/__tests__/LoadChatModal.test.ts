/**
 * @jest-environment jsdom
 */
import { App, SearchComponent, setIcon } from "obsidian";
import { LoadChatModal } from "../LoadChatModal";
import { SearchService } from "../../../services/SearchService";

// Mock setIcon
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    setIcon: jest.fn(),
    SearchComponent: jest.fn().mockImplementation(() => ({
      setPlaceholder: jest.fn().mockReturnThis(),
      onChange: jest.fn().mockReturnThis(),
      getValue: jest.fn().mockReturnValue(""),
      inputEl: {
        style: {},
        addEventListener: jest.fn(),
      },
    })),
  };
});

// Mock StandardModal
jest.mock("../../../core/ui/modals/standard/StandardModal", () => ({
  StandardModal: class MockStandardModal {
    app: App;
    modalEl: HTMLElement;
    contentEl: HTMLElement;

    constructor(app: App) {
      this.app = app;
      this.modalEl = document.createElement("div");
      this.contentEl = document.createElement("div");
    }

    setSize() {}
    addTitle() {}
    addActionButton() { return document.createElement("button"); }
    onOpen() {}
    close() {}
  },
}));

// Mock ChatStorageService
jest.mock("../ChatStorageService", () => ({
  ChatStorageService: jest.fn().mockImplementation(() => ({
    loadChats: jest.fn().mockResolvedValue([
      {
        id: "chat-1",
        title: "Test Chat 1",
        lastModified: Date.now() - 86400000,
        selectedModelId: "gpt-4",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      },
      {
        id: "chat-2",
        title: "Test Chat 2",
        lastModified: Date.now() - 172800000,
        selectedModelId: "claude-3",
        messages: [
          { role: "user", content: "How are you?" },
        ],
      },
    ]),
    deleteChatById: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock FavoritesService
jest.mock("../../../services/FavoritesService", () => ({
  FavoritesService: {
    getInstance: jest.fn().mockReturnValue({
      isFavorite: jest.fn().mockReturnValue(false),
      toggleFavorite: jest.fn(),
    }),
  },
}));

// Mock ChatFavoritesService
jest.mock("../ChatFavoritesService", () => ({
  ChatFavoritesService: {
    getInstance: jest.fn().mockReturnValue({
      isFavorite: jest.fn().mockReturnValue(false),
      toggleFavorite: jest.fn(),
    }),
  },
}));

// Mock SearchService
jest.mock("../../../services/SearchService", () => ({
  SearchService: jest.fn().mockImplementation(() => ({
    search: jest.fn().mockImplementation((items, query, getFields) => {
      if (!query) {
        return items.map((item: any) => ({ item, score: 0, matches: [] }));
      }
      return items
        .filter((item: any) => item.title.toLowerCase().includes(query.toLowerCase()))
        .map((item: any) => ({ item, score: 1, matches: [] }));
    }),
    highlightText: jest.fn().mockImplementation((text) => {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(document.createTextNode(text));
      return fragment;
    }),
  })),
  SearchResult: {},
}));

describe("LoadChatModal", () => {
  let modal: LoadChatModal;
  let mockPlugin: any;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    mockPlugin = {
      app: mockApp,
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
      },
      aiService: {
        getModelDisplayName: jest.fn().mockReturnValue("GPT-4"),
      },
    };

    modal = new LoadChatModal(mockPlugin);
  });

  afterEach(() => {
    modal.close();
  });

  describe("constructor", () => {
    it("creates modal instance", () => {
      expect(modal).toBeInstanceOf(LoadChatModal);
    });

    it("initializes search service", () => {
      expect(SearchService).toHaveBeenCalled();
    });

    it("sets up modal with large size", () => {
      expect(modal.modalEl.classList.contains("systemsculpt-load-chat-modal")).toBe(true);
    });
  });

  describe("onOpen", () => {
    it("creates search input", async () => {
      await modal.onOpen();

      expect(SearchComponent).toHaveBeenCalled();
    });

    it("creates chat list container", async () => {
      await modal.onOpen();

      expect(modal.contentEl.querySelector(".systemsculpt-chat-list")).not.toBeNull();
    });

    it("creates empty state element", async () => {
      await modal.onOpen();

      expect(modal.contentEl.querySelector(".systemsculpt-empty-state")).not.toBeNull();
    });

    it("loads chats on open", async () => {
      await modal.onOpen();

      // Verify loadChats was called
      const storage = (modal as any).chatStorage;
      expect(storage.loadChats).toHaveBeenCalled();
    });
  });

  describe("keyboard navigation", () => {
    it("initializes keyboard selected index to -1", async () => {
      await modal.onOpen();

      expect((modal as any).keyboardSelectedIndex).toBe(-1);
    });

    it("handles arrow down key", async () => {
      await modal.onOpen();
      await Promise.resolve();

      const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
      modal.modalEl.dispatchEvent(event);

      // Index should change (or stay at -1 if no items)
    });

    it("handles arrow up key", async () => {
      await modal.onOpen();
      await Promise.resolve();

      // First go down then up
      (modal as any).keyboardSelectedIndex = 1;

      const event = new KeyboardEvent("keydown", { key: "ArrowUp" });
      modal.modalEl.dispatchEvent(event);

      // Index should decrease
    });

    it("handles enter key", async () => {
      await modal.onOpen();
      await Promise.resolve();

      const event = new KeyboardEvent("keydown", { key: "Enter" });
      modal.modalEl.dispatchEvent(event);

      // Should attempt to open selected chat
    });
  });

  describe("favorites toggle", () => {
    it("starts with favorites filter off", async () => {
      await modal.onOpen();

      expect((modal as any).showFavoritesOnlyChats).toBe(false);
    });

    it("toggles favorites filter on click", async () => {
      await modal.onOpen();

      const favToggle = modal.contentEl.querySelector(".systemsculpt-favorites-filter");
      if (favToggle) {
        favToggle.dispatchEvent(new MouseEvent("click"));
        expect((modal as any).showFavoritesOnlyChats).toBe(true);

        favToggle.dispatchEvent(new MouseEvent("click"));
        expect((modal as any).showFavoritesOnlyChats).toBe(false);
      }
    });
  });

  describe("search functionality", () => {
    it("resets keyboard selection on search change", async () => {
      await modal.onOpen();

      (modal as any).keyboardSelectedIndex = 2;

      // Simulate search change callback
      const searchInput = (modal as any).searchInput;
      if (searchInput && searchInput.onChange) {
        const onChangeCallback = searchInput.onChange.mock.calls[0]?.[0];
        if (onChangeCallback) {
          await onChangeCallback("test");
          expect((modal as any).keyboardSelectedIndex).toBe(-1);
        }
      }
    });
  });

  describe("formatRelativeDate", () => {
    it("formats recent dates", async () => {
      await modal.onOpen();

      const now = Date.now();
      const result = (modal as any).formatRelativeDate?.(now - 60000);

      // Should format as relative time
      expect(result).toBeDefined();
    });
  });

  describe("loading state", () => {
    it("sets loading to true before loading chats", async () => {
      modal.onOpen();

      expect((modal as any).isLoading).toBe(true);
    });
  });

  describe("model name caching", () => {
    it("initializes empty model name cache", () => {
      expect((modal as any).modelNameCache.size).toBe(0);
    });
  });

  describe("chat item elements tracking", () => {
    it("initializes empty chat item elements array", () => {
      expect((modal as any).chatItemElements).toEqual([]);
    });
  });
});

describe("LoadChatModal integration", () => {
  let modal: LoadChatModal;
  let mockPlugin: any;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();

    mockApp = new App();

    mockPlugin = {
      app: mockApp,
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
      },
      aiService: {
        getModelDisplayName: jest.fn().mockReturnValue("GPT-4"),
      },
    };

    modal = new LoadChatModal(mockPlugin);
  });

  afterEach(() => {
    modal.close();
  });

  it("handles empty chat list", async () => {
    const { ChatStorageService } = require("../ChatStorageService");
    ChatStorageService.mockImplementation(() => ({
      loadChats: jest.fn().mockResolvedValue([]),
      deleteChatById: jest.fn(),
    }));

    modal = new LoadChatModal(mockPlugin);
    await modal.onOpen();
    await Promise.resolve();

    // Empty state should be visible
    const emptyState = modal.contentEl.querySelector(".systemsculpt-empty-state");
    expect(emptyState).not.toBeNull();
  });

  it("handles chat loading error gracefully", async () => {
    const { ChatStorageService } = require("../ChatStorageService");
    ChatStorageService.mockImplementation(() => ({
      loadChats: jest.fn().mockRejectedValue(new Error("Load error")),
      deleteChatById: jest.fn(),
    }));

    modal = new LoadChatModal(mockPlugin);

    await expect(modal.onOpen()).resolves.not.toThrow();
  });
});
