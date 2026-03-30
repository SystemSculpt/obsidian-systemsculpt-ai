import { App, MarkdownView, Notice, Platform, WorkspaceLeaf, TFile, normalizePath } from "obsidian";
import SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { DebugLogger } from "../../utils/debugLogger";
import { errorLogger } from "../../utils/errorLogger";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { WORKFLOW_AUTOMATIONS } from "../../constants/workflowAutomations";
import { showConfirm } from "../ui/notifications";
import { PlatformContext } from "../../services/PlatformContext";
import type { ChatMessage } from "../../types";
import { CHAT_VIEW_TYPE, SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "./viewTypes";
import { STUDIO_PROJECT_EXTENSION } from "../../studio/types";

type StudioCommandViewLike = {
  getViewType(): string;
  getState(): unknown;
  fitSelectionInViewportFromCommand(): void;
  showGraphOverviewFromCommand(): void;
};

type ChatCommandViewLike = {
  messages: ChatMessage[];
  addFileToContext(file: TFile): Promise<void>;
  focusInput(): void;
  getChatHistoryFilePath?(): string | null;
  getChatTitle(): string;
  getMessages(): ChatMessage[];
  getViewType(): string;
  setTitle(title: string): Promise<void>;
};

type AutomationOption = {
  id: string;
  title: string;
  subtitle?: string;
};

type ChatViewModule = typeof import("../../views/chatview/ChatView");

async function loadTitleGenerationServiceModule(): Promise<
  typeof import("../../services/TitleGenerationService")
> {
  return await import("../../services/TitleGenerationService");
}

async function loadAutomationRunnerModalModule(): Promise<
  typeof import("../../modals/AutomationRunnerModal")
> {
  return await import("../../modals/AutomationRunnerModal");
}

async function loadAutomationBacklogModalModule(): Promise<
  typeof import("../../modals/AutomationBacklogModal")
> {
  return await import("../../modals/AutomationBacklogModal");
}

function loadChatViewModule(): ChatViewModule {
  return require("../../views/chatview/ChatView");
}

export class CommandManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private ribbonManager: RibbonManager;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.ribbonManager = new RibbonManager(plugin, app);
  }

  private getActiveChatView(): ChatCommandViewLike | null {
    const activeLeaf = (this.app.workspace as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf ?? null;
    const activeView = activeLeaf?.view as ChatCommandViewLike | undefined;
    if (activeView?.getViewType?.() !== CHAT_VIEW_TYPE) {
      return null;
    }

    return activeView;
  }

  registerCommands() {
    this.registerToggleAudioRecorder();
    this.registerOpenChat();
    this.registerOpenSystemSculptHistory();
    this.registerOpenJanitor();
    this.registerMeetingProcessor();
    this.registerTranscribeAudioFile();
    this.registerOpenSystemSculptSearch();
    this.registerReloadObsidian();
    this.registerOpenSettings();
    this.registerOpenCreditsBalance();
    this.registerChatWithFile();
    this.registerResumeChat();
    this.registerChangeChatTitle();
    this.registerOpenEmbeddingsView();
    this.registerQuickFileEdit();
    this.registerDebugCommands();
    this.registerEmbeddingsDatabaseCommands();
    this.registerRunAutomationCommand();
    this.registerAutomationBacklogCommand();
    this.registerYouTubeCanvas();
    this.registerSystemSculptStudioCommands();
  }


  private registerToggleAudioRecorder() {
    this.plugin.addCommand({
      id: "toggle-audio-recorder",
      name: "Toggle Audio Recorder",
      callback: async () => {
        const alreadyInitialized = this.plugin.hasRecorderService();
        const logger = this.plugin.getLogger();

        logger.debug("Toggle audio recorder command received", {
          source: "CommandManager",
          method: "toggleAudioRecorder",
          metadata: {
            alreadyInitialized
          }
        });

        try {
          const recorderService = this.plugin.getRecorderService();
          await recorderService.toggleRecording();

          logger.info("Audio recorder toggled", {
            source: "CommandManager",
            method: "toggleAudioRecorder",
            metadata: {
              alreadyInitialized
            }
          });
        } catch (error) {
          logger.error("Failed to toggle audio recorder", error, {
            source: "CommandManager",
            method: "toggleAudioRecorder",
            metadata: {
              alreadyInitialized
            }
          });

          new Notice("Unable to toggle the audio recorder.", 8000);
        }
      },
      hotkeys: [{ modifiers: ["Mod"], key: "r" }],
    });
  }

  private registerOpenChat() {
    this.plugin.addCommand({
      id: "open-systemsculpt-chat",
      name: "Open SystemSculpt Chat",
      callback: async () => {
        await this.ribbonManager.openChatView();
      },
    });
  }

  private registerOpenSystemSculptHistory() {
    this.plugin.addCommand({
      id: "open-systemsculpt-history",
      name: "Open SystemSculpt History",
      callback: () => {
        this.ribbonManager.openSystemSculptHistoryModal();
      },
    });

    this.plugin.addCommand({
      id: "open-chat-history",
      name: "Open SystemSculpt Chat History (Legacy Alias)",
      callback: () => {
        this.ribbonManager.openSystemSculptHistoryModal();
      },
    });
  }

  private registerOpenJanitor() {
    this.plugin.addCommand({
      id: "open-systemsculpt-janitor",
      name: "Open SystemSculpt Janitor",
      callback: () => {
        this.ribbonManager.openJanitorModal();
      },
    });
  }

  private registerMeetingProcessor() {
    this.plugin.addCommand({
      id: "open-meeting-processor",
      name: "Open Meeting Processor",
      callback: async () => {
        const { MeetingProcessorModal } = await import("../../modals/MeetingProcessorModal");
        const modal = new MeetingProcessorModal(this.plugin);
        modal.open();
      },
    });
  }

  private registerTranscribeAudioFile() {
    this.plugin.addCommand({
      id: "transcribe-audio-file",
      name: "Transcribe an audio file",
      callback: async () => {
        const { TranscribeAudioFileModal } = await import("../../modals/TranscribeAudioFileModal");
        const modal = new TranscribeAudioFileModal(this.plugin);
        modal.open();
      },
    });
  }

  private registerOpenSystemSculptSearch() {
    this.plugin.addCommand({
      id: "open-systemsculpt-search",
      name: "Open SystemSculpt Search",
      callback: async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      },
      hotkeys: [{ modifiers: ["Mod"], key: "k" }],
    });
  }

  private registerReloadObsidian() {
    this.plugin.addCommand({
      id: "reload-obsidian",
      name: "Reload Obsidian",
      callback: () => {
        window.location.reload();
      },
    });
  }

  private registerOpenSettings() {
    this.plugin.addCommand({
      id: "open-systemsculpt-settings",
      name: "Open SystemSculpt AI Settings",
      callback: () => {
        this.plugin.openSettingsTab("account");
      },
    });
  }

  private registerOpenCreditsBalance() {
    this.plugin.addCommand({
      id: "open-credits-balance",
      name: "Open Credits & Usage",
      callback: async () => {
        await this.plugin.openCreditsBalanceModal({
          settingsTab: "account",
        });
      },
    });
  }

  private registerChatWithFile() {
    this.plugin.addCommand({
      id: "chat-with-file",
      name: "Chat with File",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        const extension = activeFile.extension.toLowerCase();
        const supportedExtensions = [
          "md",
          "txt",
          "markdown",
          "pdf",
          "doc",
          "docx",
          "ppt",
          "pptx",
          "xls",
          "xlsx",
          "mp3",
          "wav",
          "m4a",
          "ogg",
          "webm",
          "jpg",
          "jpeg",
          "png",
          "webp",
          "svg",
        ];
        if (!supportedExtensions.includes(extension)) return false;
        if (!checking) {
          const leaf = this.app.workspace.getLeaf("tab");
          const { ChatView } = loadChatViewModule();
          const view = new ChatView(leaf, this.plugin);
          leaf.open(view).then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
            await view.addFileToContext(activeFile);
            view.focusInput();
          });
        }
        return true;
      },
    });
  }

  private registerResumeChat() {
    this.plugin.addCommand({
      id: "resume-chat-from-history",
      name: "Resume Chat from Current History File",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        
        // Check if we have an active file and if it's a chat history file
        if (!activeFile || !this.plugin.resumeChatService) return false;
        
        const isChatHistory = this.plugin.resumeChatService.isChatHistoryFile(activeFile);
        
        if (!checking && isChatHistory) {
          // Extract chat ID from the file
          const chatId = this.plugin.resumeChatService.extractChatId(activeFile);
          
          if (chatId) {
            // Resume the chat
            this.plugin.resumeChatService.openChat(chatId, activeFile.path);
          } else {
            new Notice("Could not extract chat ID from this file.", 5000);
          }
        }
        
        return isChatHistory;
      },
    });
  }


  /**
   * Register command to change/generate title for chats and notes
   */
  private registerChangeChatTitle() {
    this.plugin.addCommand({
      id: "change-chat-title",
      name: "Change/Generate Title",
      checkCallback: (checking: boolean) => {
        // First check if we're in a chat view
        const chatView = this.getActiveChatView();
        if (chatView) {
          if (chatView.messages.length === 0) return false;
          if (!checking) {
            (async () => {
              // Show initial notice
              const notice = new Notice("Generating title...", 0);

              try {
                const { TitleGenerationService } = await loadTitleGenerationServiceModule();
                const titleService = TitleGenerationService.getInstance(this.plugin);
                const title = await titleService.generateTitle(
                  chatView.getMessages(),
                  (title) => {
                    // No need to update UI during generation
                  },
                  (progress: number, status: string) => {
                    // Update notice text with progress
                    notice.setMessage(`Generating title... ${status}`);
                  }
                );

                if (title && title !== chatView.getChatTitle()) {
                  await chatView.setTitle(title);
                  notice.setMessage("Chat title updated successfully!");
                  notice.hide();
                } else {
                  notice.hide();
                }
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                notice.setMessage(`Failed to generate title: ${errorMessage}`);
                notice.hide();
              }
            })();
          }
          return true;
        }

        // If not in chat view, check if we're in a note or Studio workflow file
        const activeFile = this.resolveTitleTargetFile();
        if (!activeFile) {
          if (!checking) {
            new Notice("You need to be within a note, Studio workflow, or chat view to change the title.", 5000);
          }
          return false;
        }

        // Only allow for markdown notes and Studio workflow files
        if (!this.canGenerateTitleForFile(activeFile)) {
          if (!checking) {
            new Notice("Title generation is only available for markdown and .systemsculpt files.", 5000);
          }
          return false;
        }

        if (!checking) {
          (async () => {
            // Show initial notice
            const notice = new Notice("Generating title...", 0);

            try {
              const { TitleGenerationService } = await loadTitleGenerationServiceModule();
              const titleService = TitleGenerationService.getInstance(this.plugin);
              const title = await titleService.generateTitle(
                activeFile,
                (title) => {
                  // No need to update UI during generation
                },
                (progress: number, status: string) => {
                  // Update notice text with progress
                  notice.setMessage(`Generating title... ${status}`);
                }
              );

              if (title && title !== activeFile.basename) {
                try {
                  await this.renameTitleTargetFile(activeFile, title);
                  const successLabel = activeFile.extension.toLowerCase() === STUDIO_PROJECT_EXTENSION.slice(1)
                    ? "Studio project"
                    : "Note";
                  notice.setMessage(`${successLabel} title updated successfully!`);
                  notice.hide();
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  notice.setMessage(`Failed to rename file: ${errorMessage}`);
                  notice.hide();
                }
              } else {
                notice.hide();
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              notice.setMessage(`Failed to generate title: ${errorMessage}`);
              notice.hide();
            }
          })();
        }
        return true;
      },
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
    });
  }

  private registerOpenEmbeddingsView() {
    this.plugin.addCommand({
      id: "open-embeddings-view",
      name: "Open Similar Notes Panel",
      callback: async () => {
        try {
          await this.plugin.getViewManager().activateEmbeddingsView();
        } catch (error) {
          new Notice(`Error opening similar notes panel: ${error.message}`);
        }
      },
    });
  }

  private registerQuickFileEdit() {
    this.plugin.addCommand({
      id: "quick-file-edit",
      name: "Quick Edit (Active File)",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        if (!checking) {
          (async () => {
            const { showQuickEditWidget } = await import("../../components/QuickEditWidget");
            showQuickEditWidget(this.app, this.plugin);
          })();
        }
        return true;
      }
    });
  }

  private registerRunAutomationCommand() {
    this.plugin.addCommand({
      id: "run-workflow-automation",
      name: "Run Workflow Automation",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Open a note before running an automation.", 4000);
          return;
        }

        if (file.extension.toLowerCase() !== "md") {
          new Notice("Automations currently support markdown notes only.", 5000);
          return;
        }

        const options = this.buildAutomationOptions();
        if (options.length === 0) {
          new Notice("No automations available. Enable one under Settings → Workflow.", 5000);
          return;
        }

        const { AutomationRunnerModal } = await loadAutomationRunnerModalModule();
        const modal = new AutomationRunnerModal(this.app, this.plugin, file, options);
        modal.open();
      },
    });
  }

  private registerAutomationBacklogCommand() {
    this.plugin.addCommand({
      id: "open-automation-backlog",
      name: "Show Automation Backlog",
      callback: async () => {
        const { AutomationBacklogModal } = await loadAutomationBacklogModalModule();
        const modal = new AutomationBacklogModal(this.app, this.plugin);
        modal.open();
      },
    });
  }

  private buildAutomationOptions(): AutomationOption[] {
    const automationSettings = this.plugin.settings.workflowEngine?.automations || {};

    return WORKFLOW_AUTOMATIONS.map((definition) => {
      const state = automationSettings[definition.id];
      return {
        id: definition.id,
        title: definition.title,
        subtitle: state?.destinationFolder || definition.destinationPlaceholder,
      };
    });
  }

  private registerYouTubeCanvas() {
    this.plugin.addCommand({
      id: "open-youtube-canvas",
      name: "YouTube Canvas - Extract transcript and create note",
      callback: async () => {
        const { YouTubeCanvasModal } = await import("../../modals/YouTubeCanvasModal");
        new YouTubeCanvasModal(this.app, this.plugin).open();
      },
    });
  }

  private registerSystemSculptStudioCommands() {
    this.plugin.addCommand({
      id: "new-systemsculpt-studio-project",
      name: "New SystemSculpt Studio Project",
      callback: async () => {
        if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
          new Notice("SystemSculpt Studio is desktop-only.");
          return;
        }

        try {
          const project = await this.createAndOpenStudioProject();
          new Notice(`Created Studio project: ${project.name}`);
        } catch (error: any) {
          new Notice(`Unable to create Studio project: ${error?.message || error}`);
        }
      },
    });

    this.plugin.addCommand({
      id: "open-systemsculpt-studio",
      name: "Open SystemSculpt Studio",
      callback: async () => {
        if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
          new Notice("SystemSculpt Studio is desktop-only.");
          return;
        }

        try {
          const activeFile = this.app.workspace.getActiveFile();
          const activeStudioFile =
            activeFile && activeFile.extension.toLowerCase() === "systemsculpt" ? activeFile : null;

          const fallbackStudioFile =
            activeStudioFile ||
            this.app.vault
              .getFiles()
              .find((file) => file.extension.toLowerCase() === "systemsculpt");

          if (!fallbackStudioFile) {
            const project = await this.createAndOpenStudioProject();
            new Notice(`No Studio project found. Created and opened: ${project.name}`);
            return;
          }

          await this.plugin.getViewManager().activateSystemSculptStudioView(fallbackStudioFile.path);
        } catch (error: any) {
          new Notice(`Unable to open SystemSculpt Studio: ${error?.message || error}`);
        }
      },
    });

    this.plugin.addCommand({
      id: "run-systemsculpt-studio-project",
      name: "Run Current SystemSculpt Studio Project",
      callback: async () => {
        if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
          new Notice("SystemSculpt Studio is desktop-only.");
          return;
        }

        try {
          const studio = this.plugin.getStudioService();
          const activeFile = this.app.workspace.getActiveFile();
          if (activeFile && activeFile.extension.toLowerCase() === "systemsculpt") {
            await studio.openProject(activeFile.path);
          }

          if (!studio.getCurrentProjectPath()) {
            new Notice("Open a .systemsculpt file in the file explorer first.");
            return;
          }
          const result = await studio.runCurrentProject();
          if (result.status === "success") {
            new Notice(`Studio run complete: ${result.runId}`);
          } else {
            new Notice(`Studio run failed: ${result.error || result.runId}`);
          }
        } catch (error: any) {
          new Notice(`Unable to run Studio project: ${error?.message || error}`);
        }
      },
    });

    this.plugin.addCommand({
      id: "fit-systemsculpt-studio-selection-in-viewport",
      name: "SystemSculpt Studio: Fit Selection in Viewport",
      checkCallback: (checking: boolean) => {
        const activeStudioView = this.getActiveStudioView();
        if (!activeStudioView) {
          return false;
        }
        if (!checking) {
          activeStudioView.fitSelectionInViewportFromCommand();
        }
        return true;
      },
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "1" }],
    });

    this.plugin.addCommand({
      id: "overview-systemsculpt-studio-graph-in-viewport",
      name: "SystemSculpt Studio: Overview Graph in Viewport",
      checkCallback: (checking: boolean) => {
        const activeStudioView = this.getActiveStudioView();
        if (!activeStudioView) {
          return false;
        }
        if (!checking) {
          activeStudioView.showGraphOverviewFromCommand();
        }
        return true;
      },
    });

    this.plugin.addCommand({
      id: "copy-current-file-path",
      name: "Copy Current File Path",
      checkCallback: (checking: boolean) => {
        const currentFilePath = this.getCurrentActiveFilePath();
        if (!currentFilePath) {
          return false;
        }

        if (!checking) {
          void this.copyActiveFilePathToClipboard(currentFilePath);
        }
        return true;
      },
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
    });
  }

  private getActiveStudioView(): StudioCommandViewLike | null {
    const activeLeaf = (this.app.workspace as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf ?? null;
    const activeView = activeLeaf?.view as StudioCommandViewLike | undefined;
    if (activeView?.getViewType?.() !== SYSTEMSCULPT_STUDIO_VIEW_TYPE) {
      return null;
    }

    return activeView;
  }

  private async createAndOpenStudioProject(): Promise<{ name: string; path: string }> {
    const studio = this.plugin.getStudioService();
    const project = await studio.createProject();
    const projectPath = studio.getCurrentProjectPath();
    if (!projectPath) {
      throw new Error("Studio project was created but no project path was returned.");
    }

    await this.plugin.getViewManager().activateSystemSculptStudioView(projectPath);
    return { name: project.name, path: projectPath };
  }

  private getCurrentActiveFilePath(): string | null {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      return null;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && activeFile.path) {
      return activeFile.path;
    }

    const activeLeaf = (this.app.workspace as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf ?? null;
    const activeLeafPath = this.resolveLeafFilePath(activeLeaf);
    if (activeLeafPath) {
      return activeLeafPath;
    }

    const activeChatView = this.getActiveChatView();
    if (activeChatView) {
      const chatFilePath = this.resolveVaultFilePath(activeChatView.getChatHistoryFilePath?.());
      if (chatFilePath) {
        return chatFilePath;
      }
    }

    const activeStudioView = this.getActiveStudioView();
    if (activeStudioView) {
      const viewState = activeStudioView.getState();
      const stateFilePath = this.resolveVaultFilePath((viewState as { file?: unknown }).file);
      if (stateFilePath) {
        return stateFilePath;
      }

      try {
        const servicePath = this.resolveVaultFilePath(this.plugin.getStudioService().getCurrentProjectPath());
        if (servicePath) {
          return servicePath;
        }
      } catch {
        // Best-effort fallback only when Studio view is active.
      }
    }

    return null;
  }

  private resolveLeafFilePath(leaf: WorkspaceLeaf | null): string | null {
    if (!leaf) {
      return null;
    }

    const view = (leaf as { view?: { file?: { path?: unknown } } }).view;
    const pathFromView = this.resolveVaultFilePath(view?.file?.path);
    if (pathFromView) {
      return pathFromView;
    }

    const viewState = leaf.getViewState();
    const pathFromState = this.resolveVaultFilePath(
      (viewState as { state?: { file?: unknown }; file?: unknown })?.state?.file
        ?? (viewState as { file?: unknown })?.file,
    );
    if (pathFromState) {
      return pathFromState;
    }

    return null;
  }

  private resolveVaultFilePath(pathCandidate: unknown): string | null {
    if (typeof pathCandidate !== "string") {
      return null;
    }

    const normalizedPath = normalizePath(pathCandidate.trim().replace(/\\/g, "/")).replace(/^\/+/, "");
    if (!normalizedPath) {
      return null;
    }

    const getAbstractFileByPath = this.app.vault?.getAbstractFileByPath;
    if (typeof getAbstractFileByPath !== "function") {
      return null;
    }

    const abstractFile = getAbstractFileByPath.call(this.app.vault, normalizedPath);
    if (!(abstractFile instanceof TFile)) {
      return null;
    }

    return abstractFile.path || normalizedPath;
  }

  private canGenerateTitleForFile(file: TFile | null | undefined): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }
    const extension = String(file.extension || "").trim().toLowerCase();
    return extension === "md" || extension === STUDIO_PROJECT_EXTENSION.slice(1);
  }

  private resolveTitleTargetFile(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (this.canGenerateTitleForFile(activeFile)) {
      return activeFile as TFile;
    }

    const resolvedPath = this.getCurrentActiveFilePath();
    if (!resolvedPath) {
      return null;
    }

    const abstractFile = this.app.vault.getAbstractFileByPath(resolvedPath);
    return abstractFile instanceof TFile && this.canGenerateTitleForFile(abstractFile)
      ? abstractFile
      : null;
  }

  private buildSiblingFilePath(file: TFile, nextBasename: string): string {
    const folderPath = file.path.split("/").slice(0, -1).join("/");
    const extension = String(file.extension || "").trim().replace(/^\./, "");
    const fileName = extension ? `${nextBasename}.${extension}` : nextBasename;
    return folderPath ? `${folderPath}/${fileName}` : fileName;
  }

  private async renameTitleTargetFile(file: TFile, nextTitle: string): Promise<string> {
    const safeTitle = String(nextTitle || "").trim();
    if (!safeTitle) {
      throw new Error("Generated title is empty.");
    }

    const isStudioProject = String(file.extension || "").trim().toLowerCase() === STUDIO_PROJECT_EXTENSION.slice(1);
    if (isStudioProject) {
      const result = await this.plugin.getStudioService().renameProject(file.path, safeTitle);
      return result.newPath;
    }

    const newPath = this.buildSiblingFilePath(file, safeTitle);
    await this.app.fileManager.renameFile(file, newPath);
    return newPath;
  }

  private async copyActiveFilePathToClipboard(vaultFilePath: string): Promise<void> {
    const absolutePath = resolveAbsoluteVaultPath(this.app.vault.adapter, vaultFilePath);
    if (!absolutePath) {
      new Notice("Unable to resolve the full file path.");
      return;
    }

    const copied = await tryCopyToClipboard(absolutePath);
    if (!copied) {
      new Notice("Unable to copy file path to clipboard.");
      return;
    }

    new Notice("File path copied to clipboard.");
  }

  private registerDebugCommands() {}

  private getDebuggingGuideContent(): string {
    return `# SystemSculpt Diagnostics Guide

SystemSculpt no longer records plugin-specific logs. Use these steps when something looks off:

1. Make note of the action you just took and any notices Obsidian displayed.
2. Capture the workflow or screenshot that best shows the issue.
3. Share your SystemSculpt version, Obsidian version, and reproduction steps when you contact support.

Without dedicated logs, clear reproduction details are the quickest path to a fix.`;
  }

  private registerEmbeddingsDatabaseCommands() {
    // Diagnostic command for developers/debugging only - not shown in command palette 
    this.plugin.addCommand({
      id: "embeddings-database-stats",
      name: "Show Embeddings Database Statistics (Debug)",
      checkCallback: (checking: boolean) => {
        // Only show if embeddings are enabled
        const embeddingsEnabled = this.plugin.settings.embeddingsEnabled;
        if (!embeddingsEnabled) return false;
        
        if (!checking) {
          this.showEmbeddingsDatabaseStats();
        }
        return true;
      }
    });

    // User-visible: force refresh embeddings for current provider/model/schema
    this.plugin.addCommand({
      id: "rebuild-embeddings-current-model",
      name: "Rebuild Embeddings (Current Model)",
      checkCallback: (checking: boolean) => {
        // Only show if embeddings are enabled
        const enabled = this.plugin.settings.embeddingsEnabled;
        if (!enabled) return false;
        if (!checking) {
          (async () => {
            try {
              const { confirmed } = await showConfirm(
                this.app,
                "This will delete and rebuild embeddings for the current provider/model/schema only.",
                {
                  title: "Rebuild Embeddings",
                  primaryButton: "Rebuild",
                  secondaryButton: "Cancel",
                  icon: "alert-triangle",
                }
              );
              if (!confirmed) return;
              new Notice('Rebuilding embeddings for current model…', 4000);
              const manager = this.plugin.getOrCreateEmbeddingsManager();
              await manager.forceRefreshCurrentNamespace();
              new Notice('Embeddings rebuild complete.', 4000);
            } catch (e: any) {
              new Notice(`Failed to rebuild embeddings: ${e?.message || e}`, 8000);
            }
          })();
        }
        return true;
      }
    });
  }

  private async showEmbeddingsDatabaseStats(): Promise<void> {
    try {
      const { Notice } = require("obsidian");
      
      // Get embeddings manager for stats
      const embeddingsManager = this.plugin.getOrCreateEmbeddingsManager();
      if (!embeddingsManager) {
        new Notice("Embeddings manager not available", 5000);
        return;
      }
      
      // Get basic stats from embeddings manager
      const isProcessing = embeddingsManager.isCurrentlyProcessing();
      const stats = embeddingsManager.getStats();

      const statsText = [
        "Embeddings Statistics:",
        `Status: ${isProcessing ? "Processing" : "Idle"}`,
        `Total Files: ${stats.total}`,
        `Needs Processing: ${stats.needsProcessing}`,
        `With embeddings: ${stats.present}`,
        `Sealed: ${stats.processed}`
      ].filter(Boolean).join("\n");
      
      // Show user-friendly summary
      new Notice(statsText, 8000);
      
    } catch (error) {
      const { Notice } = require("obsidian");
      new Notice(`Error getting database stats: ${error.message}`, 5000);
    }
  }

}
