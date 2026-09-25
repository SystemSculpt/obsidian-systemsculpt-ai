import { App, WorkspaceLeaf, Notice, ItemView } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { ChatState } from "../../types/index";
import { EmbeddingsView } from "../../views/EmbeddingsView";
import { SystemSculptStudioView } from "../../views/studio/SystemSculptStudioView";
import { AgentChatView } from "../../views/chatview/AgentChatView";
import { yieldToEventLoop } from "../../utils/yieldToEventLoop";
import { isMobileLayout } from "../../platform/mobileLayout";
import { restoreStudioReloadState } from "./StudioReloadState";
import {
  CHAT_VIEW_TYPE,
  EMBEDDINGS_VIEW_TYPE,
  SYSTEMSCULPT_STUDIO_VIEW_TYPE,
} from "./viewTypes";

const CHAT_VIEW_PRODUCER_QUIESCE_DEADLINE_MS = 1_000;
type AppWithViewRegistry = App & {
  viewRegistry?: {
    viewByType?: Record<string, unknown>;
  };
};

type ChatViewLike = ItemView & {
  isFullyLoaded: boolean;
  setState(state: ChatState): Promise<void>;
  quiesceIncidentProducers?: () => Promise<void>;
  leaf?: WorkspaceLeaf;
};

interface ChatViewState {
  state: ChatState;
}

export class ViewManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbonManager: RibbonManager;
  private hasStarted: boolean = false;
  private isInitialized: boolean = false;
  private isInitializing: boolean = false;
  private restoreQueueHigh: WorkspaceLeaf[] = [];
  private restoreQueueLow: WorkspaceLeaf[] = [];
  private restoreQueuedLeaves: Set<WorkspaceLeaf> = new Set();
  private restorePromise: Promise<void> | null = null;
  private registeredViewTypes: Set<string> = new Set();

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.ribbonManager = new RibbonManager(plugin, app);
  }

  initialize() {
    if (this.hasStarted) {
      return;
    }
    this.registerView();

    // Initialize ribbon manager in the background
    window.setTimeout(() => this.ribbonManager.initialize(), 0);

    // Wait for layout to be ready before minimal initialization
    this.app.workspace.onLayoutReady(() => {
      void restoreStudioReloadState(this.app).catch(() => {
        new Notice("Studio could not restore an open tab yet. Its reload state has been retained.");
      });
      this.initializeInBackground().catch(() => undefined);
    });

    this.hasStarted = true;
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

        if (leaf.view.getViewType() !== CHAT_VIEW_TYPE) {
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

    const draining = promise.finally(() => {
      if (this.restorePromise === draining) {
        this.restorePromise = null;
      }
    });

    this.restorePromise = draining;
    return draining;
  }

  private async initializeInBackground() {
    if (this.isInitializing || this.isInitialized) return;
    this.isInitializing = true;

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

      this.isInitialized = true;

      if (hiddenLeaves.length > 0) {
        window.setTimeout(() => {
          for (const leaf of hiddenLeaves) {
            this.scheduleChatRestore(leaf, "low");
          }
        }, 0);
      }

      // Priority restore when the user activates a chat leaf.
      this.plugin.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (!leaf) return;
          if (leaf.view.getViewType() !== CHAT_VIEW_TYPE) return;
          const view = leaf.view as ChatViewLike;
          if (view.isFullyLoaded) return;
          this.scheduleChatRestore(leaf, "high");
        })
      );
    } catch {
      // Background initialization is retried by the next lifecycle entry point.
    } finally {
      this.isInitializing = false;
    }
  }

  private async restoreView(view: ChatViewLike, state: ChatState) {
    try {
      await view.setState(state);
    } catch {

      // Try fallback restoration with minimal state
      try {
        const minimalState = {
          chatId: state.chatId,
          chatTitle: state.chatTitle || "Recovered Chat"
        };
        await view.setState(minimalState);

        // Notify user of partial recovery
        new Notice("Chat was partially recovered due to an error", 5000);
      } catch {
        // If even fallback fails, detach the leaf
        view.leaf?.detach();
      }
    }
  }

  private registerViewType(viewType: string, viewCreator: (leaf: WorkspaceLeaf) => ItemView): void {
    if (this.registeredViewTypes.has(viewType)) {
      return;
    }

    const viewRegistry = (this.app as AppWithViewRegistry).viewRegistry?.viewByType;
    if (viewRegistry && Object.prototype.hasOwnProperty.call(viewRegistry, viewType)) {
      delete viewRegistry[viewType];
    }

    this.plugin.registerView(viewType, viewCreator);
    this.registeredViewTypes.add(viewType);
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
      const chatState = state.state;
      try {
        await this.retrySetState(view, chatState);
      } catch {
        // Clean up invalid leaf to prevent future errors
        leaf.detach();
      }
    }
  }

  private isValidChatState(state: unknown): state is ChatViewState {
    if (!state || typeof state !== "object" || !("state" in state)) {
      return false;
    }

    const chatState = state.state;
    if (!chatState || typeof chatState !== "object" || !("chatId" in chatState)) {
      return false;
    }

    if (typeof chatState.chatId !== "string" || !chatState.chatId) {
      return false;
    }

    const mutableChatState = chatState as Record<string, unknown>;

    // Validate data types if they exist, but don't create them yet
    if ("messages" in mutableChatState) {
      if (!Array.isArray(mutableChatState.messages)) {
        mutableChatState.messages = [];
      }
    }

    // Only initialize empty arrays if they don't exist at all
    if (!("messages" in mutableChatState)) {
      mutableChatState.messages = [];
    }

    return true;
  }

  private async retrySetState(view: ChatViewLike, state: ChatState, maxRetries: number = 3): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => window.setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }

        await view.setState(state);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(`Failed to restore chat after ${maxRetries} attempts: ${lastError?.message}`);
  }

  registerView() {
    this.registerViewType(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        return new AgentChatView(leaf, this.plugin);
      }
    );
    
    
    this.registerViewType(
      EMBEDDINGS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        return new EmbeddingsView(leaf, this.plugin);
      }
    );

    this.registerViewType(
      SYSTEMSCULPT_STUDIO_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        return new SystemSculptStudioView(leaf, this.plugin);
      }
    );
  }



  async activateEmbeddingsView(): Promise<EmbeddingsView> {
    // Check if we already have an embeddings view open
    const existingLeaves = this.app.workspace.getLeavesOfType(EMBEDDINGS_VIEW_TYPE);
    
    if (existingLeaves.length > 0) {
      // Activate existing view
      await this.app.workspace.revealLeaf(existingLeaves[0]);
      return existingLeaves[0].view as EmbeddingsView;
    }
    
    // Similar Notes is a primary, full-width workflow on mobile. Sidebars are
    // retained on desktop, where they can remain visible beside the note.
    const targetLeaf = isMobileLayout()
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getRightLeaf(false);
    if (!targetLeaf) {
      throw new Error("Failed to create Similar Notes leaf");
    }
    
    await targetLeaf.setViewState({
      type: EMBEDDINGS_VIEW_TYPE,
      active: true
    });
    
    await this.app.workspace.revealLeaf(targetLeaf);
    return targetLeaf.view as EmbeddingsView;
  }

  async activateSystemSculptStudioView(projectPath?: string): Promise<SystemSculptStudioView> {
    const normalizedTarget = String(projectPath || "").trim();
    if (normalizedTarget) {
      const existingLeaves = this.app.workspace.getLeavesOfType(SYSTEMSCULPT_STUDIO_VIEW_TYPE);
      for (const leaf of existingLeaves) {
        const state = leaf.getViewState();
        const file = typeof (state?.state as { file?: unknown })?.file === "string"
          ? ((state.state as { file?: string }).file || "")
          : "";
        if (file === normalizedTarget) {
          await this.app.workspace.revealLeaf(leaf);
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

    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as SystemSculptStudioView;
  }

  /** Waits until live ChatViews can no longer add incident evidence. */
  async quiesceChatViewProducers(): Promise<void> {
    const leaves = [...this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)];
    const barriers = Promise.allSettled(leaves.map(async (leaf) => {
      const view = leaf.view as ChatViewLike;
      if (typeof view.quiesceIncidentProducers !== "function") return;
      await view.quiesceIncidentProducers();
    })).then(() => undefined);
    let deadlineTimer: number | null = null;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = window.setTimeout(
        resolve,
        CHAT_VIEW_PRODUCER_QUIESCE_DEADLINE_MS,
      );
    });
    try {
      await Promise.race([barriers, deadline]);
    } finally {
      if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
    }
  }

  unloadViews() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(EMBEDDINGS_VIEW_TYPE);
    // Obsidian unregisters the view implementation. Keep its leaf in place so
    // the next plugin instance can restore the same tab and split layout.
    this.ribbonManager.cleanup();
  }

}
