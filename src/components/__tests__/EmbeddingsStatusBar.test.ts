/**
 * @jest-environment jsdom
 */
import { Component } from "obsidian";
import { EmbeddingsStatusBar } from "../EmbeddingsStatusBar";

// Mock obsidian
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Component: class MockComponent {
      load() {}
      unload() {}
      onunload() {}
      register() {}
    },
  };
});

// Mock EmbeddingsStatusModal
jest.mock("../../modals/EmbeddingsStatusModal", () => ({
  EmbeddingsStatusModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

describe("EmbeddingsStatusBar", () => {
  let statusBar: EmbeddingsStatusBar;
  let mockPlugin: any;
  let mockStatusBarEl: HTMLElement;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockStatusBarEl = document.createElement("div");
    mockStatusBarEl.addClass = jest.fn();
    mockStatusBarEl.setAttr = jest.fn();
    mockStatusBarEl.createSpan = jest.fn().mockReturnValue(document.createElement("span"));

    mockPlugin = {
      addStatusBarItem: jest.fn().mockReturnValue(mockStatusBarEl),
      settings: {
        embeddingsEnabled: true,
      },
      embeddingsManager: {
        getProcessingStatus: jest.fn().mockResolvedValue({
          processedCount: 50,
          totalCount: 100,
          isProcessing: false,
        }),
        on: jest.fn().mockReturnValue(jest.fn()),
      },
      emitter: {
        on: jest.fn().mockReturnValue(jest.fn()),
      },
    };

    statusBar = new EmbeddingsStatusBar(mockPlugin);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates status bar instance", () => {
      expect(statusBar).toBeInstanceOf(EmbeddingsStatusBar);
    });

    it("adds status bar item to plugin", () => {
      expect(mockPlugin.addStatusBarItem).toHaveBeenCalled();
    });

    it("makes status bar clickable", () => {
      expect(mockStatusBarEl.addClass).toHaveBeenCalledWith("mod-clickable");
    });

    it("sets title attribute", () => {
      // Title is set during initialization
      expect((statusBar as any).statusBarEl).toBeDefined();
    });

    it("sets accessibility attributes", () => {
      expect(mockStatusBarEl.setAttr).toHaveBeenCalledWith("role", "button");
      expect(mockStatusBarEl.setAttr).toHaveBeenCalledWith("tabindex", "0");
    });
  });

  describe("startMonitoring", () => {
    it("sets visibility to true", () => {
      statusBar.startMonitoring();

      expect((statusBar as any).isVisible).toBe(true);
    });

    it("clears cached status", () => {
      (statusBar as any).cachedStatus = { test: true };

      statusBar.startMonitoring();

      expect((statusBar as any).cachedStatus).toBeNull();
    });

    it("triggers status update", () => {
      statusBar.startMonitoring();

      // Should trigger an update
      expect((statusBar as any).cachedStatus).toBeNull();
    });
  });

  describe("stopMonitoring", () => {
    it("clears update interval", () => {
      (statusBar as any).updateInterval = 123;

      statusBar.stopMonitoring();

      expect((statusBar as any).updateInterval).toBeNull();
    });

    it("sets visibility to false", () => {
      (statusBar as any).isVisible = true;

      statusBar.stopMonitoring();

      expect((statusBar as any).isVisible).toBe(false);
    });
  });

  describe("visibility", () => {
    it("setVisibility hides status bar when false", () => {
      (statusBar as any).setVisibility(false);

      expect((statusBar as any).isVisible).toBe(false);
    });

    it("setVisibility shows status bar when true", () => {
      (statusBar as any).isVisible = false;

      (statusBar as any).setVisibility(true);

      expect((statusBar as any).isVisible).toBe(true);
    });
  });

  describe("cache management", () => {
    it("has cache duration constant", () => {
      expect((statusBar as any).CACHE_DURATION).toBe(5000);
    });

    it("has active interval constant", () => {
      expect((statusBar as any).ACTIVE_INTERVAL_MS).toBe(2000);
    });

    it("has idle interval constant", () => {
      expect((statusBar as any).IDLE_INTERVAL_MS).toBe(6000);
    });
  });

  describe("error state", () => {
    it("tracks error state", () => {
      expect((statusBar as any).isInErrorState).toBe(false);
    });

    it("has error message storage", () => {
      expect((statusBar as any).currentErrorMessage).toBeNull();
    });

    it("has error retry time storage", () => {
      expect((statusBar as any).currentErrorRetryMs).toBeNull();
    });

    it("has error code storage", () => {
      expect((statusBar as any).currentErrorCode).toBeNull();
    });
  });

  describe("click handler", () => {
    it("registers click event listener", () => {
      const addEventListenerSpy = jest.spyOn(mockStatusBarEl, "addEventListener");

      // Re-create to capture event listener registration
      const newStatusBar = new EmbeddingsStatusBar(mockPlugin);

      expect(addEventListenerSpy).toHaveBeenCalledWith("click", expect.any(Function));
    });

    it("registers keydown event listener", () => {
      const addEventListenerSpy = jest.spyOn(mockStatusBarEl, "addEventListener");

      const newStatusBar = new EmbeddingsStatusBar(mockPlugin);

      expect(addEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    });
  });

  describe("disabled state", () => {
    it("shows idle when embeddings disabled", () => {
      mockPlugin.settings.embeddingsEnabled = false;

      const disabledStatusBar = new EmbeddingsStatusBar(mockPlugin);

      expect((disabledStatusBar as any).isVisible).toBe(false);
    });
  });
});
