import { App, WorkspaceLeaf, Notice, TFile } from "obsidian";
import SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { SystemPromptService } from "../../services/SystemPromptService";
import { CHAT_VIEW_TYPE, ChatView } from "../../views/chatview/ChatView";
import { ChatState } from "../../types/index";
import { EmbeddingsView, EMBEDDINGS_VIEW_TYPE } from "../../views/EmbeddingsView";
import { BenchView, BENCH_VIEW_TYPE } from "../../views/benchview/BenchView";
import { BenchResultsView, BENCH_RESULTS_VIEW_TYPE } from "../../views/benchresults/BenchResultsView";

interface ChatViewState {
  state: ChatState;
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

  private async initializeInBackground() {
    if (this.isInitializing || this.isInitialized) return;
    this.isInitializing = true;

    const startTime = performance.now();
    try {
      // Only initialize what's needed for visible views
      const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
      const visibleLeaves = leaves.filter(leaf => !leaf.view.containerEl.hidden);

      for (const leaf of visibleLeaves) {
        const view = leaf.view as ChatView;
        const state = leaf.getViewState();
        if (this.isValidChatState(state)) {
          await this.restoreView(view, state.state);
        }
      }

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

      // Restore remaining chat views in the background
      const hiddenLeaves = leaves.filter(leaf => leaf.view.containerEl.hidden);
      if (hiddenLeaves.length > 0) {
        setTimeout(() => {
          for (const leaf of hiddenLeaves) {
            const view = leaf.view as ChatView;
            const state = leaf.getViewState();
            if (this.isValidChatState(state)) {
              this.restoreView(view, state.state).catch(error => {
              });
            }
          }
        }, 0);
      }

    } catch (error) {
    } finally {
      this.isInitializing = false;
    }
  }

  private async restoreView(view: ChatView, state: ChatState) {
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
      const view = leaf.view as ChatView;
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
      const validTypes = ["general-use", "concise", "agent", "custom"]; // Note: "agent" is allowed for individual chats when agent mode is enabled
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

  private async retrySetState(view: ChatView, state: any, maxRetries: number = 3): Promise<void> {
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
    this.plugin.registerView(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ChatView(leaf, this.plugin)
    );
    
    
    this.plugin.registerView(
      EMBEDDINGS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new EmbeddingsView(leaf, this.plugin)
    );

    this.plugin.registerView(
      BENCH_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new BenchView(leaf, this.plugin)
    );

    this.plugin.registerView(
      BENCH_RESULTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new BenchResultsView(leaf, this.plugin)
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

  unloadViews() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(EMBEDDINGS_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(BENCH_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(BENCH_RESULTS_VIEW_TYPE);
    this.ribbonManager.cleanup();
  }

}
