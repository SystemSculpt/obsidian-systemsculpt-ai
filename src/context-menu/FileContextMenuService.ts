import {
  App,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  Menu,
  WorkspaceLeaf,
  EventRef,
  normalizePath,
} from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  isAudioFileExtension,
  isAutoDocumentConversionFileExtension,
  isManagedDocumentConversionFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import { DocumentProcessingService } from "../services/DocumentProcessingService";
import {
  DocumentProcessingFlow,
  DocumentProcessingProgressEvent,
} from "../types/documentProcessing";
import { launchAudioTranscriptionPanel } from "../modals/AudioTranscriptionPanel";
import { errorLogger } from "../utils/errorLogger";
import type { PluginLogger } from "../utils/PluginLogger";
import {
  launchDocumentProcessingPanel,
  type DocumentProcessingPanelHandle,
  type DocumentProcessingPanelLauncher,
} from "../modals/DocumentProcessingPanel";
import { TranscriptionTitleService } from "../services/transcription/TranscriptionTitleService";
import { tryCopyImageFileToClipboard } from "../utils/clipboard";
import { getSurfaceOwnerWindow } from "../core/ui/surface";

const CHAT_TEXT_EXTENSIONS = new Set(["md", "txt", "markdown"]);
const CHAT_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "svg",
]);
const COPYABLE_IMAGE_EXTENSIONS = new Set([
  ...CHAT_IMAGE_EXTENSIONS,
  "bmp",
  "tiff",
  "tif",
]);

const CONVERT_MENU_TITLE = "Convert to Markdown";
const NEW_STUDIO_PROJECT_NAME = "New Studio Project";
const NEW_STUDIO_PROJECT_FILE_NAME = `${NEW_STUDIO_PROJECT_NAME}.systemsculpt`;

type ProcessingFlow = "document" | "audio";

type AgentChatViewModule = typeof import("../views/chatview/AgentChatView");

function loadAgentChatViewModule(): AgentChatViewModule {
  return require("../views/chatview/AgentChatView");
}

export interface DocumentProcessor {
  processDocument(
    file: TFile,
    options?: {
      onProgress?: (event: DocumentProcessingProgressEvent) => void;
      showNotices?: boolean;
      flow?: DocumentProcessingFlow;
      signal?: AbortSignal;
    }
  ): Promise<string>;
}

export interface ChatWithFileLauncher {
  open(file: TFile): Promise<void>;
}

interface FileContextMenuServiceOptions {
  app: App;
  plugin: SystemSculptPlugin;
  documentProcessor?: DocumentProcessor;
  chatLauncher?: ChatWithFileLauncher;
  pluginLogger?: PluginLogger | null;
  launchProcessingPanel?: DocumentProcessingPanelLauncher;
}

interface MenuContext {
  source: string;
  leafType?: string;
  multiSelectCount?: number;
}

class DefaultChatWithFileLauncher implements ChatWithFileLauncher {
  constructor(private readonly app: App, private readonly plugin: SystemSculptPlugin) {}

  async open(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    const { AgentChatView } = loadAgentChatViewModule();
    const view = new AgentChatView(leaf, this.plugin);
    await leaf.open(view);
    await this.focusLeaf(leaf, view.containerEl);
    await view.addFileToContext(file);
  }

  private async focusLeaf(leaf: WorkspaceLeaf, host: HTMLElement) {
    await new Promise((resolve) => getSurfaceOwnerWindow(host).setTimeout(resolve, 50));
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

export class FileContextMenuService {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly documentProcessor: DocumentProcessor;
  private readonly chatLauncher: ChatWithFileLauncher;
  private readonly pluginLogger: PluginLogger | null;
  private readonly launchProcessingPanel: DocumentProcessingPanelLauncher;
  private eventRefs: EventRef[] = [];
  private started = false;
  private awaitingLayoutReady = false;
  private cleanupRegistered = false;
  private activeDocumentConversion: AbortController | null = null;

  constructor(options: FileContextMenuServiceOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.documentProcessor =
      options.documentProcessor ??
      DocumentProcessingService.getInstance(this.app, this.plugin);
    this.chatLauncher =
      options.chatLauncher ?? new DefaultChatWithFileLauncher(this.app, this.plugin);
    this.pluginLogger =
      options.pluginLogger ??
      (typeof (this.plugin as any).getPluginLogger === "function"
        ? (this.plugin as any).getPluginLogger()
        : null);
    this.launchProcessingPanel = options.launchProcessingPanel ?? launchDocumentProcessingPanel;

    this.start();
  }

  start(): void {
    if (this.started) {
      return;
    }

    if (!this.cleanupRegistered) {
      this.plugin.register(() => this.stop());
      this.cleanupRegistered = true;
    }

    const workspaceAny = this.app.workspace as any;
    const bindHandlers = () => {
      if (this.started) {
        return;
      }

      const fileRef = this.app.workspace.on(
        "file-menu",
        (menu, file, source, leaf) => this.handleFileMenu(menu, file, source, leaf)
      );

      const filesRef = this.app.workspace.on(
        "files-menu",
        (menu, files, source, leaf) => this.handleFilesMenu(menu, files, source, leaf)
      );

      this.eventRefs = [fileRef, filesRef];
      this.eventRefs.forEach((ref) => this.plugin.registerEvent(ref));
      this.started = true;
      this.awaitingLayoutReady = false;

      this.info("File context menu service started", {
        layoutReady: Boolean(workspaceAny?.layoutReady),
      });
    };

    if (workspaceAny?.layoutReady) {
      bindHandlers();
      return;
    }

    if (typeof workspaceAny?.onLayoutReady === "function") {
      if (this.awaitingLayoutReady) {
        this.debug("Layout ready listener already registered");
        return;
      }

      this.awaitingLayoutReady = true;
      workspaceAny.onLayoutReady(() => {
        this.awaitingLayoutReady = false;
        bindHandlers();
      });

      this.info("File context menu service awaiting layout ready", {
        layoutReady: false,
      });
      return;
    }

    this.debug("Workspace missing onLayoutReady hook, binding immediately", {
      typeofOnLayoutReady: typeof workspaceAny?.onLayoutReady,
    });
    bindHandlers();
  }

  stop(): void {
    this.activeDocumentConversion?.abort();
    this.activeDocumentConversion = null;
    if (!this.started) {
      return;
    }

    for (const ref of this.eventRefs) {
      this.app.workspace.offref(ref);
    }
    this.eventRefs = [];
    this.started = false;
    this.awaitingLayoutReady = false;
    this.cleanupRegistered = false;

    this.info("File context menu service stopped");
  }

  private handleFileMenu(
    menu: Menu,
    file: TAbstractFile,
    source: string,
    leaf?: WorkspaceLeaf
  ): void {
    const context = { source, leafType: leaf?.view?.getViewType() };
    if (file instanceof TFolder) {
      this.populateFolderMenu(menu, file, context);
      return;
    }

    if (!(file instanceof TFile)) {
      return;
    }

    this.populateMenu(menu, file, context);
  }

  private handleFilesMenu(
    menu: Menu,
    files: TAbstractFile[],
    source: string,
    leaf?: WorkspaceLeaf
  ): void {
    this.info("Files menu opened", {
      source,
      leafType: leaf?.view?.getViewType(),
      selectionCount: files.length,
    });

    const convertibleFiles = files.filter((candidate): candidate is TFile =>
      candidate instanceof TFile && this.hasAnyActions(candidate)
    );

    if (convertibleFiles.length !== 1) {
      this.info("Skipping SystemSculpt menu for selection", {
        source,
        leafType: leaf?.view?.getViewType(),
        selectionCount: files.length,
        convertibleCount: convertibleFiles.length,
      });
      return;
    }

    this.populateMenu(menu, convertibleFiles[0], {
      source,
      leafType: leaf?.view?.getViewType(),
      multiSelectCount: files.length,
    });
  }

  private populateFolderMenu(menu: Menu, folder: TFolder, context: MenuContext): void {
    menu.addItem((item) => {
      item
        .setTitle("New Studio project")
        .setIcon("workflow")
        .setSection("action")
        .onClick(async () => {
          await this.createStudioProjectInFolder(folder, context);
        });
    });
  }

  private async createStudioProjectInFolder(
    folder: TFolder,
    context: MenuContext,
  ): Promise<void> {
    const folderPath = folder.isRoot() ? "" : folder.path;
    const projectPath = normalizePath(
      folderPath
        ? `${folderPath}/${NEW_STUDIO_PROJECT_FILE_NAME}`
        : NEW_STUDIO_PROJECT_FILE_NAME,
    );

    this.info("New Studio project triggered", {
      folderPath: folder.path,
      projectPath,
      source: context.source,
    });

    let created: Awaited<ReturnType<ReturnType<SystemSculptPlugin["getStudioService"]>["createProjectFile"]>>;
    try {
      created = await this.plugin.getStudioService().createProjectFile({
        name: NEW_STUDIO_PROJECT_NAME,
        projectPath,
      });
    } catch (error) {
      this.error("New Studio project failed", error, {
        folderPath: folder.path,
        projectPath,
        source: context.source,
      });
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Unable to create Studio project: ${message}`);
      return;
    }

    try {
      await this.plugin.getViewManager().activateSystemSculptStudioView(created.path);
      new Notice(`Created Studio project: ${created.project.name}`);
    } catch (error) {
      this.error("Opening new Studio project failed", error, {
        folderPath: folder.path,
        projectPath: created.path,
        source: context.source,
      });
      new Notice(`Created Studio project, but couldn't open it: ${created.path}`);
    }
  }

  private populateMenu(menu: Menu, file: TFile, context: MenuContext): void {
    const extension = normalizeFileExtension(file.extension);
    this.logMenuOpen(file, extension, context);
    const shouldChat = this.shouldOfferChatWithFile(extension);
    const shouldCopyImage = this.shouldOfferCopyImage(extension);
    const shouldConvertDocument = isManagedDocumentConversionFileExtension(extension);
    const shouldConvertAudio = isAudioFileExtension(extension);

    this.debug("Evaluating menu population", {
      filePath: file.path,
      extension,
      source: context.source,
      leafType: context.leafType,
      multiSelectCount: context.multiSelectCount,
      shouldChat,
      shouldCopyImage,
      shouldConvertDocument,
      shouldConvertAudio,
    });

    if (!shouldChat && !shouldCopyImage && !shouldConvertDocument && !shouldConvertAudio) {
      return;
    }

    if (shouldChat) {
      this.addChatWithFileMenuItem(menu, file, context);
    }

    if (shouldCopyImage) {
      this.addCopyImageToClipboardMenuItem(menu, file, context);
    }

    if (shouldConvertDocument) {
      this.addProcessIntoMarkdownMenuItem(menu, file, "document", context);
    }

    if (shouldConvertAudio) {
      this.addProcessIntoMarkdownMenuItem(menu, file, "audio", context);
    }
  }

  private logMenuOpen(file: TFile, extension: string, context: MenuContext): void {
    this.info("File menu opened", {
      filePath: file.path,
      extension,
      rawExtension: file.extension,
      source: context.source,
      leafType: context.leafType,
      multiSelectCount: context.multiSelectCount ?? 1,
    });
  }

  private shouldOfferChatWithFile(extension: string): boolean {
    if (!extension) {
      return false;
    }

    return (
      CHAT_TEXT_EXTENSIONS.has(extension) ||
      isAutoDocumentConversionFileExtension(extension) ||
      isAudioFileExtension(extension) ||
      CHAT_IMAGE_EXTENSIONS.has(extension)
    );
  }

  private hasAnyActions(file: TFile): boolean {
    const ext = normalizeFileExtension(file.extension);
    return (
      this.shouldOfferChatWithFile(ext) ||
      this.shouldOfferCopyImage(ext) ||
      isManagedDocumentConversionFileExtension(ext) ||
      isAudioFileExtension(ext)
    );
  }

  private shouldOfferCopyImage(extension: string): boolean {
    if (!extension) return false;
    return COPYABLE_IMAGE_EXTENSIONS.has(extension);
  }

  private addChatWithFileMenuItem(menu: Menu, file: TFile, context: MenuContext): void {
    menu.addItem((item) => {
      item
        .setTitle("Chat with file")
        .setIcon("message-square")
        .setSection("action")
        .onClick(async () => {
          this.info("Chat with file triggered", {
            filePath: file.path,
            source: context.source,
          });

          try {
            await this.chatLauncher.open(file);
            this.info("Chat with file completed", { filePath: file.path });
          } catch (error) {
            this.error("Chat with file failed", error, { filePath: file.path });
            new Notice("Failed to open chat with file", 5000);
          }
        });
    });
  }

  private addCopyImageToClipboardMenuItem(menu: Menu, file: TFile, context: MenuContext): void {
    menu.addItem((item) => {
      item
        .setTitle("Copy image to clipboard")
        .setIcon("copy")
        .setSection("action")
        .onClick(async () => {
          this.info("Copy image to clipboard triggered", {
            filePath: file.path,
            source: context.source,
          });

          const copied = await tryCopyImageFileToClipboard(this.app, file);
          if (copied) {
            new Notice("Image copied to clipboard.");
          } else {
            new Notice("Unable to copy image to clipboard.");
          }
        });
    });
  }

  private addProcessIntoMarkdownMenuItem(
    menu: Menu,
    file: TFile,
    flow: ProcessingFlow,
    context: MenuContext
  ): void {
    const title = flow === "document" ? CONVERT_MENU_TITLE : "Convert Audio to Markdown";
    const icon = flow === "document" ? "file-text" : "file-audio";

    menu.addItem((item) => {
      item
        .setTitle(title)
        .setIcon(icon)
        .setSection("action")
        .onClick(async () => {
          this.info("Convert to Markdown triggered", {
            filePath: file.path,
            flow,
            source: context.source,
          });

          if (flow === "document") {
            await this.handleDocumentConversion(file);
          } else {
            await this.handleAudioConversion(file);
          }
        });
    });
  }

  private async handleDocumentConversion(file: TFile): Promise<void> {
    const startedAt = Date.now();
    this.info("Document conversion started", { filePath: file.path });
    let progressPanel: DocumentProcessingPanelHandle | null = null;
    const controller = new AbortController();
    this.activeDocumentConversion?.abort();
    this.activeDocumentConversion = controller;

    try {
      progressPanel = this.launchProcessingPanel({
        plugin: this.plugin,
        file,
        onCancel: () => controller.abort(),
      });

      const extractionPath = await this.documentProcessor.processDocument(file, {
        onProgress: (event) => {
          if (controller.signal.aborted) return;
          this.handleProgressEvent(file, event);
          if (controller.signal.aborted) return;
          progressPanel?.updateProgress(event);
        },
        showNotices: false,
        flow: "document",
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      const durationMs = Date.now() - startedAt;
      await this.handleDocumentSuccess(file, extractionPath, durationMs, controller.signal);
      if (controller.signal.aborted || this.activeDocumentConversion !== controller) return;

      const openOutput = async () => {
        await this.openExtractionFile(extractionPath);
      };

      if (controller.signal.aborted || this.activeDocumentConversion !== controller) return;
      progressPanel?.markSuccess({
        extractionPath,
        durationMs,
        file,
        openOutput,
      });
    } catch (error: any) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      this.error("Document conversion failed", error, {
        filePath: file.path,
      });

      progressPanel?.markFailure({
        error,
        file,
      });

      if (message?.toLowerCase().includes("license")) {
        new Notice(
          "Document conversion requires an active SystemSculpt license.",
          6000
        );
        return;
      }

      new Notice(`Document conversion failed: ${message}`, 6000);
    } finally {
      if (this.activeDocumentConversion === controller) {
        this.activeDocumentConversion = null;
      }
    }
  }

  private handleProgressEvent(
    file: TFile,
    event: DocumentProcessingProgressEvent
  ): void {
    this.debug("Document conversion progress", {
      filePath: file.path,
      stage: event.stage,
      progress: event.progress,
      label: event.label,
    });
  }

  private async handleDocumentSuccess(
    file: TFile,
    extractionPath: string,
    durationMs: number,
    signal?: AbortSignal
  ): Promise<TFile | null> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.info("Document conversion complete", {
      filePath: file.path,
      extractionPath,
      durationMs,
    });

    new Notice(`Converted ${file.name} to Markdown`, 4000);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const output = await this.openExtractionFile(extractionPath);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return output;
  }

  private async openExtractionFile(extractionPath: string): Promise<TFile | null> {
    const output = this.app.vault.getAbstractFileByPath(extractionPath);
    if (!(output instanceof TFile)) {
      return null;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(output);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return output;
  }

  private async handleAudioConversion(file: TFile): Promise<void> {
    this.info("Audio conversion started", { filePath: file.path });

    try {
      await this.handleAudioTranscription(file, false);
      this.info("Audio conversion completed", { filePath: file.path });
    } catch (error) {
      this.error("Audio conversion failed", error, { filePath: file.path });
      new Notice("Audio conversion failed.", 6000);
    }
  }

  private async handleAudioTranscription(
    file: TFile,
    timestamped: boolean
  ): Promise<void> {
    launchAudioTranscriptionPanel(this.app, {
      file,
      timestamped,
      plugin: this.plugin,
      onTranscriptionComplete: async (text: string) => {
        const baseName = file.basename;
        const fileExtension = timestamped ? "srt" : "md";
        const folderPath = file.parent?.path ?? "";
        const outputBasename = timestamped
          ? baseName
          : TranscriptionTitleService.getInstance(this.plugin).buildFallbackBasename(baseName);
        const outputPath = folderPath ? `${folderPath}/${outputBasename}.${fileExtension}` : `${outputBasename}.${fileExtension}`;

        const content = text;

        const existingFile = this.app.vault.getAbstractFileByPath(outputPath);
        let transcriptionFile: TFile;

        if (existingFile instanceof TFile) {
          await this.app.vault.modify(existingFile, content);
          transcriptionFile = existingFile;
        } else {
          transcriptionFile = await this.app.vault.create(outputPath, content);
        }

        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(transcriptionFile);
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      },
    });
  }

  private info(message: string, metadata?: Record<string, unknown>): void {
    errorLogger.info(message, {
      source: "FileContextMenuService",
      metadata,
    });
    this.pluginLogger?.info(message, {
      source: "FileContextMenuService",
      metadata,
    });
  }

  private debug(message: string, metadata?: Record<string, unknown>): void {
    errorLogger.debug(message, {
      source: "FileContextMenuService",
      metadata,
    });
    this.pluginLogger?.debug(message, {
      source: "FileContextMenuService",
      metadata,
    });
  }

  private error(
    message: string,
    error: unknown,
    metadata?: Record<string, unknown>
  ): void {
    errorLogger.error(message, error, {
      source: "FileContextMenuService",
      metadata,
    });
    if (this.pluginLogger) {
      this.pluginLogger.error(
        message,
        undefined,
        {
          source: "FileContextMenuService",
          metadata: {
            ...(metadata ?? {}),
            error: error instanceof Error ? error.message : String(error),
          },
        }
      );
    }
  }
}
