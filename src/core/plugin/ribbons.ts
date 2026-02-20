import { App, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { JanitorModal } from "../../modals/JanitorModal";
import { LoadChatModal } from "../../views/chatview/LoadChatModal";
import { ChatView, CHAT_VIEW_TYPE } from "../../views/chatview/ChatView";
import { generateDefaultChatTitle } from "../../utils/titleUtils";

type RibbonHandle = {
  remove?: () => void;
};

export class RibbonManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbons: RibbonHandle[] = [];
  private videoRecorderRibbonEl: HTMLElement | null = null;
  private videoRecorderToggleUnsubscribe: (() => void) | null = null;
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
   * Register all ribbon icons in the correct order:
   * 1. SystemSculpt Chat
   * 2. SystemSculpt Chat History
   * 3. SystemSculpt Janitor
   * 4. Similar Notes
   * 5. SystemSculpt Search
   * 6. Meeting Processor
   * 7. YouTube Canvas
   * 8. Video Recorder Toggle
   */
  private registerRibbonIcons() {
    // 1. SystemSculpt Chat
    this.registerRibbonIcon(
      "message-square",
      "Open SystemSculpt Chat",
      async () => {
        await this.openChatView();
      }
    );

    // 2. Chat History
    this.registerRibbonIcon(
      "history",
      "Open SystemSculpt Chat History",
      () => {
        this.openChatHistoryModal();
      }
    );

    // 3. Janitor
    this.registerRibbonIcon("trash", "Open SystemSculpt Janitor", () => {
      this.openJanitorModal();
    });

    // 4. Similar Notes Panel
    this.registerRibbonIcon("network", "Open Similar Notes Panel", async () => {
      await this.openSimilarNotesView();
    });

    // 5. SystemSculpt Search
    this.registerRibbonIcon("search", "Open SystemSculpt Search", async () => {
      const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
      const modal = new SystemSculptSearchModal(this.plugin);
      modal.open();
    });

    // 6. Meeting Processor
    this.registerRibbonIcon("file-audio", "Process Meeting Audio", async () => {
      const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
      const modal = new MeetingProcessorModal(this.plugin);
      modal.open();
    });

    // 7. YouTube Canvas
    this.registerRibbonIcon("youtube", "YouTube Canvas", async () => {
      const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
      new YouTubeCanvasModal(this.app, this.plugin).open();
    });

    // 8. Video Recorder Toggle
    const videoRibbon = this.registerRibbonIcon(
      "video",
      "Start Obsidian Video Recording",
      () => {
        void this.toggleVideoRecorderFromRibbon();
      }
    ) as HTMLElement | null;
    this.videoRecorderRibbonEl = videoRibbon;
    this.bindVideoRecorderRibbonState(videoRibbon);

  }

  private registerRibbonIcon(icon: string, title: string, callback: () => void) {
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
      if (ribbon?.remove) {
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
    this.videoRecorderToggleUnsubscribe?.();
    this.videoRecorderToggleUnsubscribe = null;
    this.videoRecorderRibbonEl = null;
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

    const view = new ChatView(leaf, this.plugin);
    await leaf.open(view);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * Open the SystemSculpt Chat History modal
   */
  public openChatHistoryModal() {
    const modal = new LoadChatModal(this.plugin);
    modal.open();
  }

  /**
   * Open the SystemSculpt Janitor modal
   */
  public openJanitorModal() {
    new JanitorModal(this.app, this.plugin).open();
  }

  /**
   * Open the Similar Notes view in the right sidebar
   */
  public async openSimilarNotesView() {
    await this.plugin.getViewManager().activateEmbeddingsView();
  }

  private async toggleVideoRecorderFromRibbon(): Promise<void> {
    try {
      const service = this.plugin.ensureVideoRecorderService?.();
      if (!service) {
        new Notice("Video recorder service is unavailable.", 5000);
        return;
      }
      await service.toggleRecording();
    } catch (error) {
      new Notice(`Unable to toggle video recorder: ${error instanceof Error ? error.message : String(error)}`, 7000);
    }
  }

  private bindVideoRecorderRibbonState(ribbon: HTMLElement | null): void {
    if (!ribbon || typeof this.plugin.ensureVideoRecorderService !== "function") {
      return;
    }

    try {
      const service = this.plugin.ensureVideoRecorderService();
      const updateState = (recording: boolean) => {
        ribbon.classList.toggle("ss-ribbon-video-recording", recording);
        ribbon.setAttribute(
          "aria-label",
          recording ? "Stop Obsidian Video Recording" : "Start Obsidian Video Recording"
        );
        ribbon.setAttribute(
          "title",
          recording ? "Stop Obsidian Video Recording" : "Start Obsidian Video Recording"
        );
      };

      updateState(service.isRecordingActive());
      this.videoRecorderToggleUnsubscribe?.();
      this.videoRecorderToggleUnsubscribe = service.onToggle(updateState);
    } catch {
      // Ribbon still works as a toggle even if service binding fails during init.
    }
  }

  
}
