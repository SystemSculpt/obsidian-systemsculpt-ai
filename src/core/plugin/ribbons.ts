import { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { JanitorModal } from "../../modals/JanitorModal";
import { LoadChatModal } from "../../views/chatview/LoadChatModal";
import { ChatView, CHAT_VIEW_TYPE } from "../../views/chatview/ChatView";
import { ChatStorageService } from "../../views/chatview/ChatStorageService";
import { generateDefaultChatTitle } from "../../utils/titleUtils";

export class RibbonManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private chatStorage: ChatStorageService;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.chatStorage = new ChatStorageService(app, plugin.settings.chatsDirectory);
  }

  /**
   * Initialize the ribbon manager and register all ribbon icons
   */
  initialize() {
    this.registerRibbonIcons();
  }

  /**
   * Register all ribbon icons in the correct order:
   * 1. SystemSculpt Chat
   * 2. SystemSculpt Chat History
   * 3. SystemSculpt Janitor
   * 4. Similar Notes
   */
  private registerRibbonIcons() {
    // 1. SystemSculpt Chat
    this.plugin.addRibbonIcon(
      "message-square",
      "Open SystemSculpt Chat",
      async () => {
        await this.openChatView();
      }
    );

    // 2. Chat History
    this.plugin.addRibbonIcon(
      "history",
      "Open SystemSculpt Chat History",
      () => {
        this.openChatHistoryModal();
      }
    );

    // 3. Janitor
    this.plugin.addRibbonIcon("trash", "Open SystemSculpt Janitor", () => {
      this.openJanitorModal();
    });

    // 4. Similar Notes Panel
    this.plugin.addRibbonIcon("network", "Open Similar Notes Panel", async () => {
      await this.openSimilarNotesView();
    });

    // 5. SystemSculpt Search
    this.plugin.addRibbonIcon("search", "Open SystemSculpt Search", async () => {
      const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
      const modal = new SystemSculptSearchModal(this.plugin);
      modal.open();
    });

    // 6. Meeting Processor
    this.plugin.addRibbonIcon("file-audio", "Process Meeting Audio", async () => {
      const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
      const modal = new MeetingProcessorModal(this.plugin);
      modal.open();
    });

    // 7. YouTube Canvas
    this.plugin.addRibbonIcon("youtube", "YouTube Canvas", async () => {
      const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
      new YouTubeCanvasModal(this.app, this.plugin).open();
    });

  }

  public cleanup() {
    // No ribbon-specific cleanup required currently, but keep the hook for future use.
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

  
}
