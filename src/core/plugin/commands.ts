import { App, Notice, WorkspaceLeaf, TFile, normalizePath } from "obsidian";
import SystemSculptPlugin from "../../main";
import { RibbonManager } from "./ribbons";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { hasHostCapability } from "../../platform/hostCapabilities";
import { showConfirm } from "../ui/notifications";
import { getSurfaceOwnerWindow, resolveSurfaceDomContext } from "../ui/surface";
import type { ChatMessage } from "../../types";
import { CHAT_VIEW_TYPE, SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "./viewTypes";
import { STUDIO_PROJECT_EXTENSION } from "../../studio/types";
import {
  isAudioFileExtension,
  isAutoDocumentConversionFileExtension,
  normalizeFileExtension,
} from "../../constants/fileTypes";
import type { AudioProcessorArtifactKind } from "../../features/audio-processor/types";

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

type AgentChatViewModule = typeof import("../../views/chatview/AgentChatView");
const AUDIO_PROCESSOR_UNAVAILABLE_NOTICE = "Audio Processor is temporarily unavailable.";

async function loadTitleGenerationServiceModule(): Promise<
  typeof import("../../services/TitleGenerationService")
> {
  return await import("../../services/TitleGenerationService");
}

function loadAgentChatViewModule(): AgentChatViewModule {
  return require("../../views/chatview/AgentChatView");
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
    this.registerTranscribeAudioFile();
    this.registerAudioProcessorCommands();
    this.registerOpenSystemSculptSearch();
    this.registerReloadObsidian();
    this.registerOpenSettings();
    this.registerOpenCreditsBalance();
    this.registerChatWithFile();
    this.registerResumeChat();
    this.registerChangeChatTitle();
    this.registerOpenEmbeddingsView();
    this.registerEmbeddingsDatabaseCommands();
    this.registerSystemSculptStudioCommands();
  }


  private registerToggleAudioRecorder() {
    this.plugin.addCommand({
      id: "toggle-audio-recorder",
      name: "Toggle audio recorder",
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
    });
  }

  private registerOpenChat() {
    this.plugin.addCommand({
      id: "open-systemsculpt-chat",
      name: "Open chat",
      callback: async () => {
        await this.ribbonManager.openChatView();
      },
    });
  }

  private registerOpenSystemSculptHistory() {
    this.plugin.addCommand({
      id: "open-systemsculpt-history",
      name: "Open history",
      callback: () => {
        this.ribbonManager.openSystemSculptHistoryModal();
      },
    });
  }

  private registerOpenJanitor() {
    this.plugin.addCommand({
      id: "open-systemsculpt-janitor",
      name: "Open janitor",
      callback: () => {
        this.ribbonManager.openJanitorModal();
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

  private registerAudioProcessorCommands() {
    void import("../../features/audio-processor")
      .then(({ resumeAudioProcessorJobs }) => resumeAudioProcessorJobs(this.plugin))
      .catch(() => undefined);

    this.plugin.addCommand({
      id: "open-audio-processor",
      name: "Open audio processor",
      callback: async () => {
        await this.openAudioProcessor("audio");
      },
    });

    this.plugin.addCommand({
      id: "process-youtube-video",
      name: "Process YouTube video",
      callback: async () => {
        await this.openAudioProcessor("youtube");
      },
    });

    this.registerAudioArtifactCommand("summary");
    this.registerAudioArtifactCommand("transcript");
  }

  private async openAudioProcessor(initialTab: "audio" | "youtube"): Promise<void> {
    const {
      AudioProcessorModal,
      canOpenAudioProcessor,
      resumeAudioProcessorJobs,
    } = await import("../../features/audio-processor");
    if (!await canOpenAudioProcessor(this.plugin)) {
      new Notice(AUDIO_PROCESSOR_UNAVAILABLE_NOTICE, 6000);
      return;
    }
    void resumeAudioProcessorJobs(this.plugin, { notifyOnDiscoveryFailure: true });
    new AudioProcessorModal(this.plugin, { initialTab }).open();
  }

  private registerAudioArtifactCommand(kind: AudioProcessorArtifactKind): void {
    const label = kind === "summary" ? "summary" : "transcript";
    this.plugin.addCommand({
      id: `save-audio-${kind}`,
      name: `Save audio ${label}`,
      checkCallback: (checking: boolean) => {
        const jobReference = this.getActiveAudioArtifactReference();
        if (!jobReference) return false;
        if (!checking) void this.saveAudioArtifact(jobReference, kind);
        return true;
      },
    });
  }

  private getActiveAudioArtifactReference(): {
    artifactJobId: string;
    deliveryJobId: string;
  } | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || normalizeFileExtension(activeFile.extension) !== "md") return null;
    const frontmatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
    const jobId = frontmatter?.["systemsculpt-audio-job-id"];
    const deliveryJobId = frontmatter?.["systemsculpt-audio-delivery-job-id"];
    const artifact = frontmatter?.["systemsculpt-audio-artifact"];
    if (
      typeof jobId !== "string"
      || !jobId.trim()
      || !["full", "summary", "transcript"].includes(artifact)
    ) return null;
    return {
      artifactJobId: jobId.trim(),
      deliveryJobId: typeof deliveryJobId === "string" && deliveryJobId.trim()
        ? deliveryJobId.trim()
        : jobId.trim(),
    };
  }

  private async saveAudioArtifact(
    jobReference: Readonly<{ artifactJobId: string; deliveryJobId: string }>,
    kind: AudioProcessorArtifactKind,
  ): Promise<void> {
    try {
      const { AudioProcessorService } = await import("../../features/audio-processor");
      const artifact = await new AudioProcessorService(this.plugin)
        .saveArtifactForJob(
          jobReference.deliveryJobId,
          jobReference.artifactJobId,
          kind,
        );
      await artifact.open();
      const label = kind === "summary" ? "Summary" : "Transcript";
      new Notice(`${label} saved to ${artifact.notePath}.`, 6000);
    } catch (error) {
      const fallback = kind === "summary"
        ? "Unable to save the audio summary."
        : "Unable to save the audio transcript.";
      new Notice(error instanceof Error ? error.message : fallback, 7000);
    }
  }

  private registerOpenSystemSculptSearch() {
    this.plugin.addCommand({
      id: "open-systemsculpt-search",
      name: "Open search",
      callback: async () => {
        const { SystemSculptSearchModal } = await import("../../modals/SystemSculptSearchModal");
        const modal = new SystemSculptSearchModal(this.plugin);
        modal.open();
      },
    });
  }

  private registerReloadObsidian() {
    this.plugin.addCommand({
      id: "reload-obsidian",
      name: "Reload Obsidian",
      callback: () => {
        resolveSurfaceDomContext().window.location.reload();
      },
    });
  }

  private registerOpenSettings() {
    this.plugin.addCommand({
      id: "open-systemsculpt-settings",
      name: "Open AI settings",
      callback: () => {
        this.plugin.openSettingsTab("account");
      },
    });
  }

  private registerOpenCreditsBalance() {
    this.plugin.addCommand({
      id: "open-credits-balance",
      name: "Open credits & usage",
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
      name: "Chat with file",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        const extension = normalizeFileExtension(activeFile.extension);
        const supported = ["md", "txt", "markdown", "jpg", "jpeg", "png", "webp", "svg"].includes(extension)
          || isAutoDocumentConversionFileExtension(extension)
          || isAudioFileExtension(extension);
        if (!supported) return false;
        if (!checking) {
          const leaf = this.app.workspace.getLeaf("tab");
          const { AgentChatView } = loadAgentChatViewModule();
          const view = new AgentChatView(leaf, this.plugin);
          leaf.open(view).then(async () => {
            await new Promise((resolve) => getSurfaceOwnerWindow(view.containerEl).setTimeout(resolve, 50));
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
      name: "Resume chat from current history file",
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
   * Register deterministic local title creation for chats and notes.
   */
  private registerChangeChatTitle() {
    this.plugin.addCommand({
      id: "change-chat-title",
      name: "Create title from content",
      checkCallback: (checking: boolean) => {
        // First check if we're in a chat view
        const chatView = this.getActiveChatView();
        if (chatView) {
          if (chatView.messages.length === 0) return false;
          if (!checking) {
            (async () => {
              // Show initial notice
              const notice = new Notice("Creating title from content...", 0);

              try {
                const { TitleGenerationService } = await loadTitleGenerationServiceModule();
                const titleService = TitleGenerationService.getInstance(this.plugin);
                const title = await titleService.generateTitle(
                  chatView.getMessages(),
                  () => {},
                  (_progress: number, status: string) => {
                    // Update notice text with progress
                    notice.setMessage(status);
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
                notice.setMessage(`Could not create title: ${errorMessage}`);
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
            new Notice("Titles can be created only for Markdown and .systemsculpt files.", 5000);
          }
          return false;
        }

        if (!checking) {
          (async () => {
            // Show initial notice
            const notice = new Notice("Creating title from content...", 0);

            try {
              const { TitleGenerationService } = await loadTitleGenerationServiceModule();
              const titleService = TitleGenerationService.getInstance(this.plugin);
              const title = await titleService.generateTitle(
                activeFile,
                () => {},
                (_progress: number, status: string) => {
                  // Update notice text with progress
                  notice.setMessage(status);
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
              notice.setMessage(`Could not create title: ${errorMessage}`);
              notice.hide();
            }
          })();
        }
        return true;
      },
    });
  }

  private registerOpenEmbeddingsView() {
    this.plugin.addCommand({
      id: "open-embeddings-view",
      name: "Open similar notes panel",
      callback: async () => {
        try {
          await this.plugin.getViewManager().activateEmbeddingsView();
        } catch (error) {
          new Notice(`Error opening similar notes panel: ${error.message}`);
        }
      },
    });
  }

  private registerSystemSculptStudioCommands() {
    this.plugin.addCommand({
      id: "new-systemsculpt-studio-project",
      name: "New Studio project",
      callback: async () => {
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
      name: "Open Studio",
      callback: async () => {
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
            new Notice(`Created Studio project: ${project.name}`);
            return;
          }

          await this.plugin.getViewManager().activateSystemSculptStudioView(fallbackStudioFile.path);
        } catch (error: any) {
          new Notice(`Unable to open Studio: ${error?.message || error}`);
        }
      },
    });

    this.plugin.addCommand({
      id: "run-systemsculpt-studio-project",
      name: "Run current Studio project",
      callback: async () => {
        try {
          const studio = this.plugin.getStudioService();
          const projectPath = this.resolveActiveStudioProjectPath();
          if (!projectPath) {
            new Notice("Open a .systemsculpt file in the file explorer first.");
            return;
          }
          const result = await studio.runProject(projectPath);
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
      name: "Studio: fit selection in viewport",
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
    });

    this.plugin.addCommand({
      id: "overview-systemsculpt-studio-graph-in-viewport",
      name: "Studio: overview graph in viewport",
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
      name: "Copy current file path",
      // This workflow intentionally ships with the documented product shortcut.
      // eslint-disable-next-line obsidianmd/commands/no-default-hotkeys
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
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

  /**
   * "Current Studio project" is a derived lookup: the focused .systemsculpt
   * file, or the project the active Studio view has loaded. There is no
   * global current-project pointer on the service anymore.
   */
  private resolveActiveStudioProjectPath(): string | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension.toLowerCase() === "systemsculpt") {
      return activeFile.path;
    }

    const activeStudioView = this.getActiveStudioView();
    if (activeStudioView) {
      const viewState = activeStudioView.getState() as { file?: unknown };
      const statePath = typeof viewState?.file === "string" ? viewState.file.trim() : "";
      if (statePath) {
        return statePath;
      }
    }

    return null;
  }

  private async createAndOpenStudioProject(): Promise<{ name: string; path: string }> {
    const studio = this.plugin.getStudioService();
    const created = await studio.createProjectFile();
    await this.plugin.getViewManager().activateSystemSculptStudioView(created.path);
    return { name: created.project.name, path: created.path };
  }

  private getCurrentActiveFilePath(): string | null {
    const activeLeaf = (this.app.workspace as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf ?? null;

    const activeChatView = this.getActiveChatView();
    if (activeChatView) {
      const chatFilePath = this.resolveVaultFilePath(activeChatView.getChatHistoryFilePath?.());
      return chatFilePath;
    }

    const activeStudioView = this.getActiveStudioView();
    if (activeStudioView) {
      const viewState = activeStudioView.getState();
      const stateFilePath = this.resolveVaultFilePath((viewState as { file?: unknown }).file);
      return stateFilePath;
    }

    const activeLeafPath = this.resolveLeafFilePath(activeLeaf);
    if (activeLeafPath) {
      return activeLeafPath;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && activeFile.path) {
      return activeFile.path;
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
      return activeFile;
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
    const absolutePath = hasHostCapability("absolute-paths")
      ? resolveAbsoluteVaultPath(this.app.vault.adapter, vaultFilePath)
      : null;
    const clipboardPath = absolutePath ?? vaultFilePath;

    const copied = await tryCopyToClipboard(clipboardPath);
    if (!copied) {
      new Notice("Unable to copy file path to clipboard.");
      return;
    }

    new Notice(absolutePath
      ? "Full file path copied to clipboard."
      : "Vault-relative file path copied to clipboard.");
  }

  private registerEmbeddingsDatabaseCommands() {
    // Diagnostic command for developers/debugging only - not shown in command palette 
    this.plugin.addCommand({
      id: "embeddings-database-stats",
      name: "Show embeddings database statistics (debug)",
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

    // User-visible: rebuild the immutable first-party index.
    this.plugin.addCommand({
      id: "rebuild-embeddings-current-model",
      name: "Rebuild SystemSculpt embeddings",
      checkCallback: (checking: boolean) => {
        // Only show if embeddings are enabled
        const enabled = this.plugin.settings.embeddingsEnabled;
        if (!enabled) return false;
        if (!checking) {
          void (async () => {
            try {
              const { confirmed } = await showConfirm(
                this.app,
                "This will delete and rebuild the current SystemSculpt embeddings index.",
                {
                  title: "Rebuild Embeddings",
                  primaryButton: "Rebuild",
                  secondaryButton: "Cancel",
                  icon: "alert-triangle",
                }
              );
              if (!confirmed) return;
              new Notice('Rebuilding SystemSculpt embeddings…', 4000);
              const manager = this.plugin.getOrCreateEmbeddingsManager();
              await manager.forceRefreshCurrentNamespace();
              new Notice('Embeddings rebuild complete.', 4000);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Failed to rebuild embeddings: ${message}`, 8000);
            }
          })();
        }
        return true;
      }
    });
  }

  private async showEmbeddingsDatabaseStats(): Promise<void> {
    try {
      // Get embeddings manager for stats
      const embeddingsManager = this.plugin.getOrCreateEmbeddingsManager();
      
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
      
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Error getting database stats: ${message}`, 5000);
    }
  }

}
