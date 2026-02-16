import {
  App,
  Notice,
  TAbstractFile,
  TFile,
  Menu,
  WorkspaceLeaf,
  EventRef,
} from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  isAudioFileExtension,
  isDocumentFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import { DocumentProcessingService } from "../services/DocumentProcessingService";
import {
  DocumentProcessingFlow,
  DocumentProcessingProgressEvent,
} from "../types/documentProcessing";
import { showAudioTranscriptionModal } from "../modals/AudioTranscriptionModal";
import { ChatView } from "../views/chatview/ChatView";
import { errorLogger } from "../utils/errorLogger";
import type { PluginLogger } from "../utils/PluginLogger";
import {
  launchDocumentProcessingModal,
  type DocumentProcessingModalHandle,
  type DocumentProcessingModalLauncher,
} from "../modals/DocumentProcessingModal";
import { TranscriptionTitleService } from "../services/transcription/TranscriptionTitleService";
import { tryCopyImageFileToClipboard } from "../utils/clipboard";

const CHAT_TEXT_EXTENSIONS = new Set(["md", "txt", "markdown"]);
const CHAT_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
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

type ProcessingFlow = "document" | "audio";

export interface DocumentProcessor {
  processDocument(
    file: TFile,
    options?: {
      onProgress?: (event: DocumentProcessingProgressEvent) => void;
      addToContext?: boolean;
      showNotices?: boolean;
      flow?: DocumentProcessingFlow;
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
  launchProcessingModal?: DocumentProcessingModalLauncher;
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
    const view = new ChatView(leaf, this.plugin);
    await leaf.open(view);
    await this.focusLeaf(leaf);
    await view.addFileToContext(file);
  }

  private async focusLeaf(leaf: WorkspaceLeaf) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

export class FileContextMenuService {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly documentProcessor: DocumentProcessor;
  private readonly chatLauncher: ChatWithFileLauncher;
  private readonly pluginLogger: PluginLogger | null;
  private readonly launchProcessingModal: DocumentProcessingModalLauncher;
  private eventRefs: EventRef[] = [];
  private started = false;
  private awaitingLayoutReady = false;
  private cleanupRegistered = false;

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
    this.launchProcessingModal =
      options.launchProcessingModal ??
      ((modalOptions) =>
        launchDocumentProcessingModal({
          app: modalOptions.app ?? this.app,
          plugin: modalOptions.plugin ?? this.plugin,
          file: modalOptions.file,
          onCancel: modalOptions.onCancel,
          source: modalOptions.source,
        }));

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
    if (!(file instanceof TFile)) {
      return;
    }

    this.populateMenu(menu, file, { source, leafType: leaf?.view?.getViewType() });
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

  private populateMenu(menu: Menu, file: TFile, context: MenuContext): void {
    const extension = normalizeFileExtension(file.extension);
    this.logMenuOpen(file, extension, context);
    const shouldChat = this.shouldOfferChatWithFile(extension);
    const shouldCopyImage = this.shouldOfferCopyImage(extension);
    const shouldConvertDocument = isDocumentFileExtension(extension);
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

    menu.setUseNativeMenu(false);
    menu.addSeparator();

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
      isDocumentFileExtension(extension) ||
      isAudioFileExtension(extension) ||
      CHAT_IMAGE_EXTENSIONS.has(extension)
    );
  }

  private hasAnyActions(file: TFile): boolean {
    const ext = normalizeFileExtension(file.extension);
    return (
      this.shouldOfferChatWithFile(ext) ||
      this.shouldOfferCopyImage(ext) ||
      isDocumentFileExtension(ext) ||
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
        .setTitle("SystemSculpt - Chat with File")
        .setIcon("message-square")
        .setSection("systemsculpt")
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
        .setTitle("SystemSculpt - Copy Image to Clipboard")
        .setIcon("copy")
        .setSection("systemsculpt")
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
    const hasValidLicense = this.hasValidProcessingLicense();
    const title =
      flow === "document"
        ? this.buildConvertMenuTitle(hasValidLicense)
        : this.buildAudioMenuTitle(hasValidLicense);
    const icon = flow === "document" ? "file-text" : "file-audio";

    menu.addItem((item) => {
      item
        .setTitle(title)
        .setIcon(icon)
        .setSection("systemsculpt")
        .onClick(async () => {
          this.info("Convert to Markdown triggered", {
            filePath: file.path,
            flow,
            hasValidLicense,
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

  private hasValidProcessingLicense(): boolean {
    const { licenseKey, licenseValid } = this.plugin.settings ?? {};
    return Boolean(licenseKey?.trim() && licenseValid);
  }

  private buildConvertMenuTitle(hasValidLicense: boolean): string {
    return hasValidLicense ? CONVERT_MENU_TITLE : `${CONVERT_MENU_TITLE} (Pro)`;
  }

  private buildAudioMenuTitle(hasValidLicense: boolean): string {
    const base = "Convert Audio to Markdown";
    return hasValidLicense ? base : `${base} (Pro)`;
  }

  private async handleDocumentConversion(file: TFile): Promise<void> {
    const startedAt = Date.now();
    this.info("Document conversion started", { filePath: file.path });
    let modalHandle: DocumentProcessingModalHandle | null = null;

    try {
      modalHandle = this.launchProcessingModal({
        app: this.app,
        plugin: this.plugin,
        file,
        source: "context-menu",
      });

      const extractionPath = await this.documentProcessor.processDocument(file, {
        onProgress: (event) => {
          this.handleProgressEvent(file, event);
          modalHandle?.updateProgress(event);
        },
        showNotices: false,
        addToContext: false,
        flow: "document",
      });

      const durationMs = Date.now() - startedAt;
      await this.handleDocumentSuccess(file, extractionPath, durationMs);

      const openOutput = async () => {
        await this.openExtractionFile(extractionPath);
      };

      modalHandle?.markSuccess({
        extractionPath,
        durationMs,
        file,
        openOutput,
      });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      this.error("Document conversion failed", error, {
        filePath: file.path,
      });

      modalHandle?.markFailure({
        error,
        file,
      });

      if (message?.toLowerCase().includes("license")) {
        new Notice(
          "Document conversion requires an active SystemSculpt Pro license.",
          6000
        );
        return;
      }

      new Notice(`Document conversion failed: ${message}`, 6000);
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
    durationMs: number
  ): Promise<TFile | null> {
    this.info("Document conversion complete", {
      filePath: file.path,
      extractionPath,
      durationMs,
    });

    new Notice(`Converted ${file.name} to Markdown`, 4000);

    const output = await this.openExtractionFile(extractionPath);
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
      await this.handleAudioTranscription(file, true);
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
    await showAudioTranscriptionModal(this.app, {
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
