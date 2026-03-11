import { App, WorkspaceLeaf, Notice, TFile, ItemView } from "obsidian";
import SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { SystemPromptService } from "../../services/SystemPromptService";
import { ChatState } from "../../types/index";
import type { EmbeddingsView } from "../../views/EmbeddingsView";
import type { BenchView } from "../../views/benchview/BenchView";
import type { BenchResultsView } from "../../views/benchresults/BenchResultsView";
import type { SystemSculptStudioView } from "../../views/studio/SystemSculptStudioView";
import { yieldToEventLoop } from "../../utils/yieldToEventLoop";
import { PlatformContext } from "../../services/PlatformContext";
import {
  CHAT_VIEW_TYPE,
  EMBEDDINGS_VIEW_TYPE,
  BENCH_RESULTS_VIEW_TYPE,
  BENCH_VIEW_TYPE,
  SYSTEMSCULPT_STUDIO_VIEW_TYPE,
} from "./viewTypes";

type ChatViewModule = typeof import("../../views/chatview/ChatView");
type EmbeddingsViewModule = typeof import("../../views/EmbeddingsView");
type BenchViewModule = typeof import("../../views/benchview/BenchView");
type BenchResultsViewModule = typeof import("../../views/benchresults/BenchResultsView");
type StudioViewModule = typeof import("../../views/studio/SystemSculptStudioView");

type ChatViewLike = ItemView & {
  isFullyLoaded: boolean;
  setState(state: ChatState): Promise<void>;
  leaf?: WorkspaceLeaf;
};

function loadChatViewModule(): ChatViewModule {
  return require("../../views/chatview/ChatView");
}

function loadEmbeddingsViewModule(): EmbeddingsViewModule {
  return require("../../views/EmbeddingsView");
}

function loadBenchViewModule(): BenchViewModule {
  return require("../../views/benchview/BenchView");
}

function loadBenchResultsViewModule(): BenchResultsViewModule {
  return require("../../views/benchresults/BenchResultsView");
}

function loadStudioViewModule(): StudioViewModule {
  return require("../../views/studio/SystemSculptStudioView");
}

interface ChatViewState {
  state: ChatState;
}

class DesktopOnlyPlaceholderView extends ItemView {
  private readonly viewType: string;
  private readonly displayText: string;
  private readonly description: string;

  constructor(
    leaf: WorkspaceLeaf,
    options: { viewType: string; displayText: string; description: string }
  ) {
    super(leaf);
    this.viewType = options.viewType;
    this.displayText = options.displayText;
    this.description = options.description;
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return this.displayText;
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    const container = this.containerEl.createDiv({ cls: "systemsculpt-desktop-only-placeholder" });
    container.createEl("h3", { text: this.displayText });
    container.createEl("p", { text: this.description });
  }
}

export class ViewManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbonManager: RibbonManager;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  private deferredViews: Map<string, () => void> = new Map();
  private initializationTimeout: number = 10000; // Increased from 2000ms to 10000ms for network operations
  private restoreQueueHigh: WorkspaceLeaf[] = [];
  private restoreQueueLow: WorkspaceLeaf[] = [];
  private restoreQueuedLeaves: Set<WorkspaceLeaf> = new Set();
  private restorePromise: Promise<void> | null = null;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.ribbonManager = new RibbonManager(plugin, app);
  }

  initialize() {
    // Register views immediately - this is critical
    this.registerView();

    // Initialize ribbon manager in the background
    setTimeout(() => this.ribbonManager.initialize(), 0);

    // Wait for layout to be ready before minimal initialization
    this.app.workspace.onLayoutReady(() => {
      try { (window as any).FreezeMonitor?.mark?.('view-manager:onLayoutReady'); } catch {}
      this.initializeInBackground().catch(error => {
      });
    });
  }

  private scheduleChatRestore(leaf: WorkspaceLeaf, priority: "high" | "low"): void {
    if (this.restoreQueuedLeaves.has(leaf)) {
      return;
    }

    this.restoreQueuedLeaves.add(leaf);
    if (priority === "high") {
      this.restoreQueueHigh.push(leaf);
    } else {
      this.restoreQueueLow.push(leaf);
    }

    void this.processRestoreQueue();
  }

  private processRestoreQueue(): Promise<void> {
    if (this.restorePromise) {
      return this.restorePromise;
    }

    const promise = (async () => {
      while (this.restoreQueueHigh.length > 0 || this.restoreQueueLow.length > 0) {
        const leaf = this.restoreQueueHigh.shift() ?? this.restoreQueueLow.shift();
        if (!leaf) continue;
        this.restoreQueuedLeaves.delete(leaf);

        if ((leaf.view as any)?.getViewType?.() !== CHAT_VIEW_TYPE) {
          continue;
        }

        const view = leaf.view as ChatViewLike;
        if (view.isFullyLoaded) {
          continue;
        }

        const state = leaf.getViewState();
        if (!this.isValidChatState(state)) {
          continue;
        }

        await this.restoreView(view, state.state);
        await yieldToEventLoop(0);
      }
    })();

    this.restorePromise = promise.finally(() => {
      if (this.restorePromise === promise) {
        this.restorePromise = null;
      }
    });

    return this.restorePromise;
  }

  private async initializeInBackground() {
    if (this.isInitializing || this.isInitialized) return;
    this.isInitializing = true;

    const startTime = performance.now();
    try {
      // Only initialize what's needed for visible views
      const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
      const visibleLeaves = leaves.filter(leaf => !leaf.view.containerEl.hidden);
      const hiddenLeaves = leaves.filter(leaf => leaf.view.containerEl.hidden);

      for (const leaf of visibleLeaves) {
        this.scheduleChatRestore(leaf, "high");
      }

      // Restore the currently-visible chats first so the UI is ready quickly.
      await this.processRestoreQueue();

      // Lazy-load change: do not fetch models here. We will fetch
      // on-demand when user opens the model selection or triggers a run.

      this.isInitialized = true;

      // Process any deferred views
      for (const [id, initFn] of this.deferredViews) {
        try {
          initFn();
        } catch (error) {
        }
      }
      this.deferredViews.clear();

      if (hiddenLeaves.length > 0) {
        setTimeout(() => {
          for (const leaf of hiddenLeaves) {
            this.scheduleChatRestore(leaf, "low");
          }
        }, 0);
      }

      // Priority restore when the user activates a chat leaf.
      this.plugin.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (!leaf) return;
          if ((leaf.view as any)?.getViewType?.() !== CHAT_VIEW_TYPE) return;
          const view = leaf.view as ChatViewLike;
          if (view.isFullyLoaded) return;
          this.scheduleChatRestore(leaf, "high");
        })
      );
    } catch (error) {
    } finally {
      this.isInitializing = false;
    }
  }

  private async restoreView(view: ChatViewLike, state: ChatState) {
    try {
      await view.setState(state);
    } catch (error) {

      // Try fallback restoration with minimal state
      try {
        const minimalState = {
          chatId: state.chatId,
          selectedModelId: state.selectedModelId || this.plugin.settings.selectedModelId,
          chatTitle: state.chatTitle || "Recovered Chat"
        };
        await view.setState(minimalState);

        // Notify user of partial recovery
        new Notice("Chat was partially recovered due to an error", 5000);
      } catch (fallbackError) {
        // If even fallback fails, detach the leaf
        view.leaf?.detach();
      }
    }
  }

  private async initializeModels() {
    try {
      const models = await this.plugin.modelService.getModels();
      return models;
    } catch (error) {
      // Continue with initialization - models can load on demand
      return [];
    }
  }

  // Method to defer a view initialization
  public deferViewInitialization(id: string, initFn: () => void) {
    if (this.isInitialized) {
      // If already initialized, run immediately
      initFn();
    } else {
      // Otherwise store for later
      this.deferredViews.set(id, initFn);
    }
  }

  async restoreChatViews() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (leaves.length === 0) {
      return;
    }

    for (const leaf of leaves) {
      const view = leaf.view as ChatViewLike;
      const state = leaf.getViewState();

      if (!this.isValidChatState(state)) {
        continue;
      }

      // At this point we know state.state exists and is valid
      const chatState = state.state as ChatState;
      try {
        await this.retrySetState(view, chatState);
      } catch (error) {
        // Clean up invalid leaf to prevent future errors
        leaf.detach();
      }
    }
  }

  private isValidChatState(state: any): state is ChatViewState {
    // Must have at least a chatId
    if (!state?.state?.chatId) {
      return false;
    }

    const chatId = state.state.chatId;

    // Validate data types if they exist, but don't create them yet
    if ("messages" in state.state) {
      if (!Array.isArray(state.state.messages)) {
        state.state.messages = [];
      }
    }

    // Validate system prompt type if present
    if ("systemPromptType" in state.state) {
      const validTypes = ["general-use", "concise", "agent", "custom"]; // Keep "agent" only so older chat states migrate cleanly.
      // Make case-insensitive comparison
      if (!validTypes.includes(state.state.systemPromptType?.toLowerCase())) {
        state.state.systemPromptType = "general-use";
      } else {
        // Normalize case to ensure consistency
        const normalizedType = state.state.systemPromptType.toLowerCase();
        if (normalizedType !== state.state.systemPromptType) {
          state.state.systemPromptType = normalizedType;
        }
      }
    }

    // Only initialize empty arrays if they don't exist at all
    if (!("messages" in state.state)) {
      state.state.messages = [];
    }

    return true;
  }

  private async retrySetState(view: ChatViewLike, state: any, maxRetries: number = 3): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }

        await view.setState(state);
        if (attempt > 1) {
        }
        return;
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(`Failed to restore chat after ${maxRetries} attempts: ${lastError?.message}`);
  }

  registerView() {
    const platform = PlatformContext.get();
    this.plugin.registerView(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        const { ChatView } = loadChatViewModule();
        return new ChatView(leaf, this.plugin);
      }
    );
    
    
    this.plugin.registerView(
      EMBEDDINGS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        const { EmbeddingsView } = loadEmbeddingsViewModule();
        return new EmbeddingsView(leaf, this.plugin);
      }
    );

    this.plugin.registerView(
      BENCH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        if (!platform.supportsDesktopOnlyFeatures()) {
          return new DesktopOnlyPlaceholderView(leaf, {
            viewType: BENCH_VIEW_TYPE,
            displayText: "Bench",
            description: "Bench is desktop-only right now.",
          });
        }
        const { BenchView } = loadBenchViewModule();
        return new BenchView(leaf, this.plugin);
      }
    );

    this.plugin.registerView(
      BENCH_RESULTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        if (!platform.supportsDesktopOnlyFeatures()) {
          return new DesktopOnlyPlaceholderView(leaf, {
            viewType: BENCH_RESULTS_VIEW_TYPE,
            displayText: "Bench Results",
            description: "Bench results are desktop-only right now.",
          });
        }
        const { BenchResultsView } = loadBenchResultsViewModule();
        return new BenchResultsView(leaf, this.plugin);
      }
    );

    this.plugin.registerView(
      SYSTEMSCULPT_STUDIO_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        if (!platform.supportsDesktopOnlyFeatures()) {
          return new DesktopOnlyPlaceholderView(leaf, {
            viewType: SYSTEMSCULPT_STUDIO_VIEW_TYPE,
            displayText: "SystemSculpt Studio",
            description: "SystemSculpt Studio is desktop-only right now.",
          });
        }
        const { SystemSculptStudioView } = loadStudioViewModule();
        return new SystemSculptStudioView(leaf, this.plugin);
      }
    );
  }



  async activateEmbeddingsView(): Promise<EmbeddingsView> {
    // Check if we already have an embeddings view open
    const existingLeaves = this.app.workspace.getLeavesOfType(EMBEDDINGS_VIEW_TYPE);
    
    if (existingLeaves.length > 0) {
      // Activate existing view
      this.app.workspace.revealLeaf(existingLeaves[0]);
      return existingLeaves[0].view as EmbeddingsView;
    }
    
    // Create new view in right sidebar
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (!rightLeaf) {
      throw new Error("Failed to create right sidebar leaf");
    }
    
    await rightLeaf.setViewState({
      type: EMBEDDINGS_VIEW_TYPE,
      active: true
    });
    
    this.app.workspace.revealLeaf(rightLeaf);
    return rightLeaf.view as EmbeddingsView;
  }

  async activateBenchView(): Promise<BenchView> {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      throw new Error("Bench is desktop-only.");
    }

    const existingLeaves = this.app.workspace.getLeavesOfType(BENCH_VIEW_TYPE);
    if (existingLeaves.length > 0) {
      this.app.workspace.revealLeaf(existingLeaves[0]);
      return existingLeaves[0].view as BenchView;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: BENCH_VIEW_TYPE,
      active: true
    });

    this.app.workspace.revealLeaf(leaf);
    return leaf.view as BenchView;
  }

  async activateBenchResultsView(): Promise<BenchResultsView> {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      throw new Error("Bench results are desktop-only.");
    }

    const existingLeaves = this.app.workspace.getLeavesOfType(BENCH_RESULTS_VIEW_TYPE);
    if (existingLeaves.length > 0) {
      this.app.workspace.revealLeaf(existingLeaves[0]);
      return existingLeaves[0].view as BenchResultsView;
    }

    // Open in right sidebar for quick reference
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (!rightLeaf) {
      throw new Error("Failed to create right sidebar leaf");
    }

    await rightLeaf.setViewState({
      type: BENCH_RESULTS_VIEW_TYPE,
      active: true,
    });

    this.app.workspace.revealLeaf(rightLeaf);
    return rightLeaf.view as BenchResultsView;
  }

  async activateSystemSculptStudioView(projectPath?: string): Promise<SystemSculptStudioView> {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      throw new Error("SystemSculpt Studio is desktop-only.");
    }

    const normalizedTarget = String(projectPath || "").trim();
    if (normalizedTarget) {
      const existingLeaves = this.app.workspace.getLeavesOfType(SYSTEMSCULPT_STUDIO_VIEW_TYPE);
      for (const leaf of existingLeaves) {
        const state = leaf.getViewState();
        const file = typeof (state?.state as { file?: unknown })?.file === "string"
          ? ((state.state as { file?: string }).file || "")
          : "";
        if (file === normalizedTarget) {
          this.app.workspace.revealLeaf(leaf);
          return leaf.view as SystemSculptStudioView;
        }
      }
    }

    const leaf = this.app.workspace.getLeaf("tab");
    const viewState: Record<string, unknown> = {};
    if (normalizedTarget) {
      viewState.file = normalizedTarget;
    }
    await leaf.setViewState({
      type: SYSTEMSCULPT_STUDIO_VIEW_TYPE,
      active: true,
      state: viewState,
    });

    this.app.workspace.revealLeaf(leaf);
    return leaf.view as SystemSculptStudioView;
  }

  unloadViews() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(EMBEDDINGS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(BENCH_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(BENCH_RESULTS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(SYSTEMSCULPT_STUDIO_VIEW_TYPE);
    this.ribbonManager.cleanup();
  }

}
