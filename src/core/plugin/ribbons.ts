import { App, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "./viewTypes";
import { generateDefaultChatTitle } from "../../utils/titleUtils";

type RibbonHandle = HTMLElement;

type ChatViewModule = typeof import("../../views/chatview/ChatView");

function loadChatViewModule(): ChatViewModule {
  return require("../../views/chatview/ChatView");
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
    if (this.isDisposed || this.isInitialized) {
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
      "youtube",
      "YouTube Canvas",
      async () => {
        const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
        new YouTubeCanvasModal(this.app, this.plugin).open();
      }
    );

    this.registerRibbonIcon(
      "file-audio",
      "Process Meeting Audio",
      async () => {
        const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
        const modal = new MeetingProcessorModal(this.plugin);
        modal.open();
      }
    );

    this.registerRibbonIcon(
      "mic",
      "Audio Recorder",
      async () => {
        await this.toggleAudioRecorder();
      }
    );

    this.registerRibbonIcon(
      "search",
      "Open SystemSculpt Search",
      async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      }
    );

    this.registerRibbonIcon("trash", "Open SystemSculpt Janitor", () => {
      this.openJanitorModal();
    });

    this.registerRibbonIcon(
      "history",
      "Open SystemSculpt History",
      () => {
        this.openSystemSculptHistoryModal();
      }
    );

    this.registerRibbonIcon(
      "message-square",
      "Open SystemSculpt Chat",
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
    if (this.isDisposed) {
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
        selectedModelId: this.plugin.settings.selectedModelId,
        chatTitle: generateDefaultChatTitle(),
      },
    });

    const { ChatView } = loadChatViewModule();
    const view = new ChatView(leaf, this.plugin);
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
      new Notice("Unable to open SystemSculpt History right now.", 5000);
    });
  }

  /**
   * Backward-compatible alias for older callers.
   */
  public openChatHistoryModal() {
    this.openSystemSculptHistoryModal();
  }

  /**
   * Open the SystemSculpt Janitor modal
   */
  public openJanitorModal() {
    void import("../../modals/JanitorModal").then(({ JanitorModal }) => {
      new JanitorModal(this.app, this.plugin).open();
    }).catch(() => {
      new Notice("Unable to open SystemSculpt Janitor right now.", 5000);
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
