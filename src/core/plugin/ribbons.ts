import { App, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "./viewTypes";
import { generateDefaultChatTitle } from "../../utils/titleUtils";

type RibbonHandle = HTMLElement;

type AgentChatViewModule = typeof import("../../views/chatview/AgentChatView");

function loadAgentChatViewModule(): AgentChatViewModule {
  return require("../../views/chatview/AgentChatView");
}

export class RibbonManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbons: RibbonHandle[] = [];
  private isInitialized: boolean = false;
  private isDisposed: boolean = false;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
  }

  /**
   * Initialize the ribbon manager and register all ribbon icons
   */
  initialize() {
    // Disabled means inert (#134/#214): ribbon init is deferred (a setTimeout in
    // ViewManager), so this can fire after onunload flips the unloading flag.
    // Don't re-add icons to a plugin that is already tearing down.
    if (this.isDisposed || this.isInitialized || this.plugin?.isPluginUnloading?.()) {
      return;
    }
    this.isInitialized = true;
    this.registerRibbonIcons();
  }

  /**
   * Register the SystemSculpt ribbon actions without overriding Obsidian's
   * native ribbon ordering behavior.
   */
  private registerRibbonIcons() {
    this.registerRibbonIcon(
      "mic",
      "Audio Recorder",
      async () => {
        await this.toggleAudioRecorder();
      }
    );

    this.registerRibbonIcon(
      "search",
      "Open search",
      async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      }
    );

    this.registerRibbonIcon("trash", "Open janitor", () => {
      this.openJanitorModal();
    });

    this.registerRibbonIcon(
      "history",
      "Open history",
      () => {
        this.openSystemSculptHistoryModal();
      }
    );

    this.registerRibbonIcon(
      "message-square",
      "Open chat",
      async () => {
        await this.openChatView();
      }
    );

    this.registerRibbonIcon("network", "Open Similar Notes Panel", async () => {
      await this.openSimilarNotesView();
    });
  }

  private registerRibbonIcon(
    icon: string,
    title: string,
    callback: () => void
  ) {
    if (this.isDisposed || this.plugin?.isPluginUnloading?.()) {
      return;
    }
    const ribbon = this.plugin.addRibbonIcon(icon, title, callback) as RibbonHandle;
    if (ribbon) {
      this.ribbons.push(ribbon);
      this.plugin.register(() => {
        this.safeRemoveRibbon(ribbon);
      });
    }
    return ribbon;
  }

  private safeRemoveRibbon(ribbon: RibbonHandle) {
    try {
      if (ribbon) {
        ribbon.remove();
      }
    } catch (error) {
      // Best-effort cleanup; ignore failures.
    }
  }

  public cleanup() {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.ribbons.forEach((ribbon) => this.safeRemoveRibbon(ribbon));
    this.ribbons = [];
  }

  /**
   * Open a new SystemSculpt Chat view in a new tab
   */
  public async openChatView() {
    const { workspace } = this.app;
    const leaf = workspace.getLeaf("tab");

    // Set initial state with the default title
    await leaf.setViewState({
      type: CHAT_VIEW_TYPE,
      state: {
        chatId: "",
        chatTitle: generateDefaultChatTitle(),
      },
    });

    const { AgentChatView } = loadAgentChatViewModule();
    const view = new AgentChatView(leaf, this.plugin);
    await leaf.open(view);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * Open the SystemSculpt History modal
   */
  public openSystemSculptHistoryModal() {
    void import("../../views/history/SystemSculptHistoryModal").then(({ SystemSculptHistoryModal }) => {
      const modal = new SystemSculptHistoryModal(this.plugin);
      modal.open();
    }).catch(() => {
      new Notice("Unable to open history right now.", 5000);
    });
  }

  /**
   * Open the SystemSculpt Janitor modal
   */
  public openJanitorModal() {
    void import("../../modals/JanitorModal").then(({ JanitorModal }) => {
      new JanitorModal(this.app, this.plugin).open();
    }).catch(() => {
      new Notice("Unable to open janitor right now.", 5000);
    });
  }

  private async toggleAudioRecorder() {
    try {
      const recorderService = this.plugin.getRecorderService();
      await recorderService.toggleRecording();
    } catch {
      new Notice("Unable to toggle the audio recorder.", 8000);
    }
  }

  /**
   * Open the Similar Notes view in the right sidebar
   */
  public async openSimilarNotesView() {
    await this.plugin.getViewManager().activateEmbeddingsView();
  }
}
