import { App, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "./viewTypes";
import { generateDefaultChatTitle } from "../../utils/titleUtils";

type RibbonHandle = HTMLElement;

type ChatViewModule = typeof import("../../views/chatview/ChatView");

const SYSTEMSCULPT_RIBBON_DIVIDER_CLASS = "ss-systemsculpt-ribbon-divider";

function loadChatViewModule(): ChatViewModule {
  return require("../../views/chatview/ChatView");
}

export class RibbonManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbons: RibbonHandle[] = [];
  private systemSculptTopRibbons: RibbonHandle[] = [];
  private systemSculptSecondaryRibbons: RibbonHandle[] = [];
  private ribbonDivider: HTMLElement | null = null;
  private isInitialized: boolean = false;
  private isDisposed: boolean = false;
  private ribbonObserver: MutationObserver | null = null;
  private isNormalizingRibbons: boolean = false;
  private hasQueuedRibbonNormalization: boolean = false;

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
   * 1. YouTube Canvas
   * 2. Process Meeting Audio
   * 3. Audio Recorder
   * 4. SystemSculpt Search
   * 5. SystemSculpt Janitor
   * 6. SystemSculpt History
   * 7. SystemSculpt Chat
   * 8. Similar Notes
   */
  private registerRibbonIcons() {
    // 1. YouTube Canvas
    this.registerRibbonIcon(
      "youtube",
      "YouTube Canvas",
      async () => {
        const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
        new YouTubeCanvasModal(this.app, this.plugin).open();
      },
      { pinToTop: true }
    );

    // 2. Process Meeting Audio
    this.registerRibbonIcon(
      "file-audio",
      "Process Meeting Audio",
      async () => {
        const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
        const modal = new MeetingProcessorModal(this.plugin);
        modal.open();
      },
      { pinToTop: true }
    );

    // 3. Audio Recorder
    this.registerRibbonIcon(
      "mic",
      "Audio Recorder",
      async () => {
        await this.toggleAudioRecorder();
      },
      { pinToTop: true }
    );

    // 4. SystemSculpt Search
    this.registerRibbonIcon(
      "search",
      "Open SystemSculpt Search",
      async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      },
      { pinToTop: true }
    );

    // 5. Janitor
    this.registerRibbonIcon("trash", "Open SystemSculpt Janitor", () => {
      this.openJanitorModal();
    }, { pinToTop: true });

    // 6. SystemSculpt History
    this.registerRibbonIcon(
      "history",
      "Open SystemSculpt History",
      () => {
        this.openSystemSculptHistoryModal();
      },
      { pinToTop: true }
    );

    // 7. SystemSculpt Chat
    this.registerRibbonIcon(
      "message-square",
      "Open SystemSculpt Chat",
      async () => {
        await this.openChatView();
      },
      { pinToTop: true }
    );

    // 8. Similar Notes Panel
    this.registerRibbonIcon("network", "Open Similar Notes Panel", async () => {
      await this.openSimilarNotesView();
    }, { pinToEnd: true });

    this.startKeepingSystemSculptRibbonsTopmost();
  }

  private registerRibbonIcon(
    icon: string,
    title: string,
    callback: () => void,
    options?: {
      pinToTop?: boolean;
      pinToEnd?: boolean;
    }
  ) {
    if (this.isDisposed) {
      return;
    }
    const ribbon = this.plugin.addRibbonIcon(icon, title, callback) as RibbonHandle;
    if (ribbon) {
      if (options?.pinToTop) {
        this.systemSculptTopRibbons.push(ribbon);
      }
      if (options?.pinToEnd) {
        this.systemSculptSecondaryRibbons.push(ribbon);
      }
      this.ribbons.push(ribbon);
      this.plugin.register(() => {
        this.safeRemoveRibbon(ribbon);
      });
    }
    return ribbon;
  }

  private startKeepingSystemSculptRibbonsTopmost() {
    this.ensureRibbonDivider();
    this.normalizeSystemSculptTopRibbons();
    this.observeRibbonContainer();
  }

  private observeRibbonContainer() {
    if (this.ribbonObserver || this.isDisposed || typeof MutationObserver === "undefined") {
      return;
    }

    const container = this.findRibbonContainer();
    if (!container) {
      return;
    }

    this.ribbonObserver = new MutationObserver(() => {
      if (this.isDisposed || this.isNormalizingRibbons) {
        return;
      }
      this.queueRibbonNormalization();
    });

    this.ribbonObserver.observe(container, { childList: true });
    this.plugin.register(() => {
      this.disconnectRibbonObserver();
    });
  }

  private queueRibbonNormalization() {
    if (this.isDisposed || this.hasQueuedRibbonNormalization) {
      return;
    }

    this.hasQueuedRibbonNormalization = true;
    queueMicrotask(() => {
      this.hasQueuedRibbonNormalization = false;
      this.normalizeSystemSculptTopRibbons();
    });
  }

  private normalizeSystemSculptTopRibbons() {
    if (
      this.isDisposed ||
      this.isNormalizingRibbons ||
      (this.systemSculptTopRibbons.length === 0 && this.systemSculptSecondaryRibbons.length === 0)
    ) {
      return;
    }

    const container = this.findRibbonContainer();
    if (!container) {
      return;
    }

    this.isNormalizingRibbons = true;
    try {
      const connectedSystemSculptRibbons = this.systemSculptTopRibbons.filter((ribbon) => ribbon.isConnected);
      const connectedSecondaryRibbons = this.systemSculptSecondaryRibbons.filter((ribbon) => ribbon.isConnected);
      const divider = this.ensureRibbonDivider();
      const allRibbonChildren = Array.from(container.children) as HTMLElement[];
      const systemSculptRibbonSet = new Set(connectedSystemSculptRibbons);
      const systemSculptSecondaryRibbonSet = new Set(connectedSecondaryRibbons);
      const reorderedChildren: HTMLElement[] = [
        ...connectedSystemSculptRibbons,
        ...(divider ? [divider] : []),
        ...allRibbonChildren.filter((child) => (
          !systemSculptRibbonSet.has(child) &&
          !systemSculptSecondaryRibbonSet.has(child) &&
          child !== divider
        )),
        ...connectedSecondaryRibbons,
      ];

      const isAlreadyNormalized =
        allRibbonChildren.length === reorderedChildren.length &&
        allRibbonChildren.every((child, index) => child === reorderedChildren[index]);

      if (isAlreadyNormalized) {
        return;
      }

      for (const child of reorderedChildren) {
        container.append(child);
      }
    } finally {
      this.isNormalizingRibbons = false;
    }
  }

  private findRibbonContainer(): HTMLElement | null {
    return this.systemSculptTopRibbons.find((ribbon) => ribbon.parentElement)?.parentElement ?? null;
  }

  private ensureRibbonDivider(): HTMLElement | null {
    if (this.ribbonDivider || typeof document === "undefined") {
      return this.ribbonDivider;
    }

    const divider = document.createElement("div");
    divider.className = SYSTEMSCULPT_RIBBON_DIVIDER_CLASS;
    divider.setAttribute("aria-hidden", "true");
    this.ribbonDivider = divider;
    return divider;
  }

  private disconnectRibbonObserver() {
    try {
      this.ribbonObserver?.disconnect();
    } catch (error) {
      // Best-effort cleanup; ignore failures.
    }
    this.ribbonObserver = null;
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
    this.disconnectRibbonObserver();
    try {
      this.ribbonDivider?.remove();
    } catch (error) {
      // Best-effort cleanup; ignore failures.
    }
    this.ribbonDivider = null;
    this.ribbons.forEach((ribbon) => this.safeRemoveRibbon(ribbon));
    this.ribbons = [];
    this.systemSculptTopRibbons = [];
    this.systemSculptSecondaryRibbons = [];
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
