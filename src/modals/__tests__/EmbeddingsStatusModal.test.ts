/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { EmbeddingsStatusModal } from "../EmbeddingsStatusModal";

const createMockManager = (overrides: Record<string, any> = {}) => ({
  awaitReady: jest.fn().mockResolvedValue(undefined),
  isCurrentlyProcessing: jest.fn().mockReturnValue(false),
  getStats: jest.fn().mockReturnValue({
    total: 100,
    processed: 80,
    present: 80,
    needsProcessing: 20,
    failed: 0,
  }),
  getCurrentNamespaceDescriptor: jest.fn().mockReturnValue({
    provider: "systemsculpt",
    model: "text-embedding-3-small",
    schema: 2,
  }),
  processVault: jest.fn().mockResolvedValue({ status: "complete" }),
  retryFailedFiles: jest.fn().mockResolvedValue(undefined),
  suspendProcessing: jest.fn(),
  ...overrides,
});

const createMockEmitter = () => {
  const handlers: Record<string, Array<(payload?: any) => void>> = {};
  return {
    on: jest.fn((event: string, handler: (payload?: any) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return () => {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      };
    }),
    emit: jest.fn((event: string, payload?: any) => {
      handlers[event]?.forEach((h) => h(payload));
    }),
    _handlers: handlers,
  };
};

const createMockPlugin = (manager = createMockManager(), emitter = createMockEmitter()) => ({
  app: new App(),
  settings: {
    embeddingsEnabled: true,
  },
  embeddingsManager: manager,
  getOrCreateEmbeddingsManager: jest.fn().mockReturnValue(manager),
  emitter,
  manifest: { id: "systemsculpt-ai" },
});

describe("EmbeddingsStatusModal", () => {
  let plugin: any;
  let modal: EmbeddingsStatusModal;
  let mockManager: any;
  let mockEmitter: any;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockManager = createMockManager();
    mockEmitter = createMockEmitter();
    plugin = createMockPlugin(mockManager, mockEmitter);
    modal = new EmbeddingsStatusModal(plugin.app, plugin);
  });

  afterEach(() => {
    modal.onClose();
    jest.useRealTimers();
  });

  describe("initialization", () => {
    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(plugin);
    });

    it("initializes with empty unsubscribes array", () => {
      expect((modal as any).unsubscribes).toEqual([]);
    });
  });

  describe("onOpen", () => {
    it("builds modal content", async () => {
      await modal.onOpen();

      expect((modal as any).statusContainerEl).not.toBeNull();
      expect((modal as any).providerInfoEl).not.toBeNull();
      expect((modal as any).statsGridEl).not.toBeNull();
    });

    it("creates action buttons", async () => {
      await modal.onOpen();

      expect((modal as any).processButton).not.toBeNull();
      expect((modal as any).stopButton).not.toBeNull();
      expect((modal as any).retryButton).not.toBeNull();
    });

    it("sets up event listeners", async () => {
      await modal.onOpen();

      expect(mockEmitter.on).toHaveBeenCalledWith("embeddings:processing-start", expect.any(Function));
      expect(mockEmitter.on).toHaveBeenCalledWith("embeddings:processing-progress", expect.any(Function));
      expect(mockEmitter.on).toHaveBeenCalledWith("embeddings:processing-complete", expect.any(Function));
      expect(mockEmitter.on).toHaveBeenCalledWith("embeddings:error", expect.any(Function));
      expect(mockEmitter.on).toHaveBeenCalledWith("embeddings:recovered", expect.any(Function));
    });

    it("starts periodic updates", async () => {
      await modal.onOpen();

      expect((modal as any).updateIntervalId).not.toBeNull();
    });

    it("calls updateDisplay initially", async () => {
      await modal.onOpen();

      expect(mockManager.getStats).toHaveBeenCalled();
    });
  });

  describe("onClose", () => {
    it("clears update interval", async () => {
      await modal.onOpen();
      modal.onClose();

      expect((modal as any).updateIntervalId).toBeNull();
    });

    it("unsubscribes event listeners", async () => {
      await modal.onOpen();
      const unsubCount = (modal as any).unsubscribes.length;

      modal.onClose();

      expect((modal as any).unsubscribes.length).toBe(0);
      expect(unsubCount).toBeGreaterThan(0);
    });
  });

  describe("stats display", () => {
    it("renders total files count", async () => {
      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).toContain("100");
      expect(statsGrid?.textContent).toContain("Total Files");
    });

    it("renders processed count", async () => {
      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).toContain("80");
      expect(statsGrid?.textContent).toContain("Processed");
    });

    it("renders pending count", async () => {
      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).toContain("20");
      expect(statsGrid?.textContent).toContain("Pending");
    });

    it("calculates correct percentage", async () => {
      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).toContain("80%");
    });

    it("shows failed count when failed > 0", async () => {
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 75,
        present: 75,
        needsProcessing: 20,
        failed: 5,
      });

      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).toContain("5");
      expect(statsGrid?.textContent).toContain("Failed");
    });

    it("hides failed count when failed is 0", async () => {
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 80,
        present: 80,
        needsProcessing: 20,
        failed: 0,
      });

      await modal.onOpen();

      const statsGrid = (modal as any).statsGridEl;
      expect(statsGrid?.textContent).not.toContain("Failed");
    });
  });

  describe("provider info display", () => {
    it("renders provider name", async () => {
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("SystemSculpt");
    });

    it("renders schema version", async () => {
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("v2");
    });

    it("formats custom provider name", async () => {
      mockManager.getCurrentNamespaceDescriptor.mockReturnValue({
        provider: "custom",
        model: "nomic-embed-text",
        schema: 2,
      });

      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("Custom");
    });

    it("shows model name for custom provider", async () => {
      mockManager.getCurrentNamespaceDescriptor.mockReturnValue({
        provider: "custom",
        model: "nomic-embed-text",
        schema: 2,
      });

      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("nomic-embed-text");
    });

    it("truncates long model names", () => {
      const longModel = "very-long-model-name-that-exceeds-thirty-characters";
      const formatted = (modal as any).formatModelName(longModel);
      expect(formatted.length).toBeLessThanOrEqual(30);
      expect(formatted.endsWith("...")).toBe(true);
    });

    it("shows Ready status when not processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(false);
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("Ready");
    });

    it("shows Processing status when processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("Processing");
    });
  });

  describe("progress display", () => {
    it("hides progress section when not processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(false);
      await modal.onOpen();

      expect((modal as any).progressSectionEl?.style.display).toBe("none");
    });

    it("shows progress section when processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      await modal.onOpen();

      expect((modal as any).progressSectionEl?.style.display).toBe("block");
    });

    it("updates progress bar width", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 50,
        present: 50,
        needsProcessing: 50,
        failed: 0,
      });

      await modal.onOpen();

      expect((modal as any).progressBarEl?.style.width).toBe("50%");
    });

    it("updates progress text", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 50,
        present: 50,
        needsProcessing: 50,
        failed: 0,
      });

      await modal.onOpen();

      expect((modal as any).progressTextEl?.textContent).toContain("50 of 100");
    });
  });

  describe("action buttons", () => {
    it("shows Process Vault button when not processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(false);
      await modal.onOpen();

      expect((modal as any).processButton?.style.display).toBe("flex");
    });

    it("hides Process Vault button when processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      await modal.onOpen();

      expect((modal as any).processButton?.style.display).toBe("none");
    });

    it("disables Process Vault button when nothing to process", async () => {
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 100,
        present: 100,
        needsProcessing: 0,
        failed: 0,
      });
      await modal.onOpen();

      expect((modal as any).processButton?.disabled).toBe(true);
    });

    it("shows Stop button when processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      await modal.onOpen();

      expect((modal as any).stopButton?.style.display).toBe("flex");
    });

    it("hides Stop button when not processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(false);
      await modal.onOpen();

      expect((modal as any).stopButton?.style.display).toBe("none");
    });

    it("shows Retry Failed button when failed > 0 and not processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(false);
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 90,
        present: 90,
        needsProcessing: 5,
        failed: 5,
      });
      await modal.onOpen();

      expect((modal as any).retryButton?.style.display).toBe("flex");
    });

    it("hides Retry Failed button when failed is 0", async () => {
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 80,
        present: 80,
        needsProcessing: 20,
        failed: 0,
      });
      await modal.onOpen();

      expect((modal as any).retryButton?.style.display).toBe("none");
    });

    it("hides Retry Failed button when processing", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 80,
        present: 80,
        needsProcessing: 15,
        failed: 5,
      });
      await modal.onOpen();

      expect((modal as any).retryButton?.style.display).toBe("none");
    });
  });

  describe("button actions", () => {
    it("calls processVault on Process button click", async () => {
      await modal.onOpen();

      (modal as any).processButton?.click();
      await Promise.resolve();

      expect(mockManager.processVault).toHaveBeenCalled();
    });

    it("calls retryFailedFiles on Retry button click", async () => {
      mockManager.getStats.mockReturnValue({
        total: 100,
        processed: 90,
        present: 90,
        needsProcessing: 5,
        failed: 5,
      });
      await modal.onOpen();

      (modal as any).retryButton?.click();
      await Promise.resolve();

      expect(mockManager.retryFailedFiles).toHaveBeenCalled();
    });

    it("calls suspendProcessing on Stop button click", async () => {
      mockManager.isCurrentlyProcessing.mockReturnValue(true);
      await modal.onOpen();

      (modal as any).stopButton?.click();

      expect(mockManager.suspendProcessing).toHaveBeenCalled();
    });
  });

  describe("event handling", () => {
    it("updates display on processing-start event", async () => {
      await modal.onOpen();
      mockManager.getStats.mockClear();

      mockEmitter.emit("embeddings:processing-start");
      await Promise.resolve();

      expect(mockManager.getStats).toHaveBeenCalled();
    });

    it("updates display on processing-progress event", async () => {
      await modal.onOpen();
      mockManager.getStats.mockClear();

      mockEmitter.emit("embeddings:processing-progress");
      await Promise.resolve();

      expect(mockManager.getStats).toHaveBeenCalled();
    });

    it("updates display on processing-complete event", async () => {
      await modal.onOpen();
      mockManager.getStats.mockClear();

      mockEmitter.emit("embeddings:processing-complete");
      await Promise.resolve();

      expect(mockManager.getStats).toHaveBeenCalled();
    });

    it("displays error on error event", async () => {
      await modal.onOpen();

      mockEmitter.emit("embeddings:error", { error: { message: "Test error" } });

      expect((modal as any).isInErrorState).toBe(true);
      expect((modal as any).currentErrorMessage).toBe("Test error");
      expect((modal as any).errorSectionEl?.style.display).toBe("flex");
    });

    it("clears error on recovered event", async () => {
      await modal.onOpen();

      mockEmitter.emit("embeddings:error", { error: { message: "Test error" } });
      mockEmitter.emit("embeddings:recovered");

      expect((modal as any).isInErrorState).toBe(false);
      expect((modal as any).currentErrorMessage).toBeNull();
      expect((modal as any).errorSectionEl?.style.display).toBe("none");
    });

    it("clears error on processing-start event", async () => {
      await modal.onOpen();

      mockEmitter.emit("embeddings:error", { error: { message: "Test error" } });
      mockEmitter.emit("embeddings:processing-start");
      await Promise.resolve();

      expect((modal as any).isInErrorState).toBe(false);
    });
  });

  describe("periodic updates", () => {
    it("updates stats every 2000ms", async () => {
      await modal.onOpen();
      mockManager.getStats.mockClear();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mockManager.getStats).toHaveBeenCalled();
    });

    it("stops updates on close", async () => {
      await modal.onOpen();
      modal.onClose();
      mockManager.getStats.mockClear();

      jest.advanceTimersByTime(2000);

      expect(mockManager.getStats).not.toHaveBeenCalled();
    });
  });

  describe("not initialized state", () => {
    it("shows initializing message when embeddings enabled but no manager", async () => {
      plugin.embeddingsManager = null;
      modal = new EmbeddingsStatusModal(plugin.app, plugin);
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("initializing");
    });

    it("shows not enabled message when embeddings disabled", async () => {
      plugin.embeddingsManager = null;
      plugin.settings.embeddingsEnabled = false;
      modal = new EmbeddingsStatusModal(plugin.app, plugin);
      await modal.onOpen();

      const providerInfo = (modal as any).providerInfoEl;
      expect(providerInfo?.textContent).toContain("not enabled");
    });

    it("disables process button when not initialized", async () => {
      plugin.embeddingsManager = null;
      modal = new EmbeddingsStatusModal(plugin.app, plugin);
      await modal.onOpen();

      expect((modal as any).processButton?.disabled).toBe(true);
    });
  });

  describe("formatProviderName", () => {
    it("formats systemsculpt as SystemSculpt", () => {
      expect((modal as any).formatProviderName("systemsculpt")).toBe("SystemSculpt");
    });

    it("formats custom as Custom", () => {
      expect((modal as any).formatProviderName("custom")).toBe("Custom");
    });

    it("formats openai as OpenAI", () => {
      expect((modal as any).formatProviderName("openai")).toBe("OpenAI");
    });

    it("formats ollama as Ollama", () => {
      expect((modal as any).formatProviderName("ollama")).toBe("Ollama");
    });

    it("returns unknown provider as-is", () => {
      expect((modal as any).formatProviderName("newprovider")).toBe("newprovider");
    });
  });

  describe("formatModelName", () => {
    it("returns model name for short names", () => {
      expect((modal as any).formatModelName("text-embedding-3-small")).toBe("text-embedding-3-small");
    });

    it("returns 'Not configured' for unknown", () => {
      expect((modal as any).formatModelName("unknown")).toBe("Not configured");
    });

    it("returns 'Not configured' for empty string", () => {
      expect((modal as any).formatModelName("")).toBe("Not configured");
    });
  });
});
