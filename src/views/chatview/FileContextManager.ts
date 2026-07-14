import { App, Notice, TFile } from "obsidian";
import { DocumentContextManager } from "../../services/DocumentContextManager";
import { ContextSelectionModal } from "../../modals/ContextSelectionModal";
import type SystemSculptPlugin from "../../main";
import type { DocumentProcessingProgressEvent } from "../../types/documentProcessing";

type ProcessingEntry = {
  file: TFile;
  event: DocumentProcessingProgressEvent;
  updatedAt: number;
  removalTimeoutId: number | null;
  removalTimerWindow: Window | null;
};

export const FILE_CONTEXT_STATE_CHANGED_EVENT = "systemsculpt:file-context-state-changed";

export interface FileContextStateChangedEvent {
  manager: FileContextManager;
  kind: "context" | "processing";
}

interface FileContextManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  onContextChange: () => Promise<void>;
  getOwnerWindow: () => Window;
}

export class FileContextManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly onContextChange: () => Promise<void>;
  private readonly getOwnerWindow: () => Window;

  private contextFiles = new Set<string>();

  private processing = new Map<string, ProcessingEntry>();

  constructor(options: FileContextManagerOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.onContextChange = options.onContextChange;
    this.getOwnerWindow = options.getOwnerWindow;
  }

  public destroy(): void {
    this.clearProcessingEntries();
  }

  private clearProcessingEntries(): void {
    for (const entry of this.processing.values()) {
      if (entry.removalTimeoutId !== null) {
        entry.removalTimerWindow?.clearTimeout(entry.removalTimeoutId);
      }
    }
    this.processing.clear();
  }

  private emitContextChanged(): void {
    this.emitStateChanged("context");
  }

  private emitProcessingChanged(): void {
    this.emitStateChanged("processing");
  }

  private emitStateChanged(kind: FileContextStateChangedEvent["kind"]): void {
    (this.app.workspace as any).trigger(FILE_CONTEXT_STATE_CHANGED_EVENT, {
      manager: this,
      kind,
    } satisfies FileContextStateChangedEvent);
  }

  public getContextFiles(): Set<string> {
    return this.contextFiles;
  }

  public hasContextFile(wikiLink: string): boolean {
    return this.contextFiles.has(wikiLink);
  }

  public addToContextFiles(wikiLink: string): boolean {
    if (!wikiLink || typeof wikiLink !== "string") {
      return false;
    }

    const normalized = this.normalizeWikiLink(wikiLink);
    if (this.contextFiles.has(normalized)) {
      return false;
    }

    this.contextFiles.add(normalized);
    this.emitContextChanged();
    return true;
  }

  public async removeFromContextFiles(filePath: string): Promise<boolean> {
    if (!filePath || typeof filePath !== "string") {
      return false;
    }

    const normalizedPath = filePath.replace(/^\[\[(.*?)\]\]$/, "$1");
    const wikiLink = this.normalizeWikiLink(normalizedPath);

    const hadFile = this.contextFiles.has(filePath) || this.contextFiles.has(wikiLink);
    if (!hadFile) return false;

    this.contextFiles.delete(filePath);
    this.contextFiles.delete(wikiLink);
    this.emitContextChanged();

    await this.onContextChange();
    return true;
  }

  public async addContextFile(): Promise<void> {
    const modal = new ContextSelectionModal(
      this.app,
      async (files) => {
        const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
        await documentContextManager.addFilesToContext(files, this, { showNotices: true, saveChanges: true, maxFiles: 100 });
      },
      this.plugin,
      {
        isFileAlreadyInContext: (file) => this.hasContextFile(`[[${file.path}]]`),
      }
    );
    modal.open();
  }

  public async addFileToContext(file: TFile): Promise<void> {
    const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
    await documentContextManager.addFileToContext(file, this, { showNotices: true, saveChanges: true });
  }

  public async triggerContextChange(): Promise<void> {
    await this.onContextChange();
  }

  public clearContext(): void {
    this.contextFiles.clear();
    this.clearProcessingEntries();
    this.emitContextChanged();
    this.emitProcessingChanged();
  }

  public async setContextFiles(files: string[]): Promise<void> {
    const validFiles = Array.isArray(files) ? files.filter((file) => !!file && typeof file === "string") : [];
    const normalizedFiles = validFiles.map((file) => this.normalizeWikiLink(file));

    const existingFiles: string[] = [];
    for (const file of normalizedFiles) {
      if (await this.validateFileExists(file)) {
        existingFiles.push(file);
      }
    }

    this.contextFiles = new Set(existingFiles);
    this.clearProcessingEntries();
    this.emitContextChanged();
    this.emitProcessingChanged();
  }

  public updateProcessingStatus(file: TFile, event: DocumentProcessingProgressEvent): void {
    const key = file.path;
    const existing = this.processing.get(key);
    if (existing && existing.removalTimeoutId !== null) {
      existing.removalTimerWindow?.clearTimeout(existing.removalTimeoutId);
    }

    const ownerWindow = this.getOwnerWindow();

    const entry: ProcessingEntry = {
      file,
      event,
      updatedAt: Date.now(),
      removalTimeoutId: null,
      removalTimerWindow: null,
    };

    if (event.stage === "ready") {
      entry.removalTimerWindow = ownerWindow;
      entry.removalTimeoutId = ownerWindow.setTimeout(() => {
        this.processing.delete(key);
        this.emitProcessingChanged();
      }, 1500);
    } else if (event.stage === "error") {
      entry.removalTimerWindow = ownerWindow;
      entry.removalTimeoutId = ownerWindow.setTimeout(() => {
        this.processing.delete(key);
        this.emitProcessingChanged();
      }, 7000);
    }

    this.processing.set(key, entry);
    this.emitProcessingChanged();
  }

  public dismissProcessingStatus(filePath: string): void {
    const entry = this.processing.get(filePath);
    if (!entry) return;
    if (entry.removalTimeoutId !== null) {
      entry.removalTimerWindow?.clearTimeout(entry.removalTimeoutId);
    }
    this.processing.delete(filePath);
    this.emitProcessingChanged();
  }

  public getProcessingEntries(): Array<{ key: string; file: TFile; event: DocumentProcessingProgressEvent; updatedAt: number }> {
    return Array.from(this.processing.entries()).map(([key, entry]) => ({
      key,
      file: entry.file,
      event: entry.event,
      updatedAt: entry.updatedAt,
    }));
  }

  public async validateAndCleanContextFiles(): Promise<void> {
    const validFiles: string[] = [];
    let removedCount = 0;

    for (const file of this.contextFiles) {
      if (await this.validateFileExists(file)) {
        validFiles.push(file);
      } else {
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.contextFiles = new Set(validFiles);
      this.emitContextChanged();
      await this.onContextChange();
      new Notice(`Removed ${removedCount} non-existent file${removedCount > 1 ? "s" : ""} from context`);
    }
  }

  private normalizeWikiLink(fileOrWikilink: string): string {
    if (!fileOrWikilink) return "";
    if (fileOrWikilink.startsWith("[[") && fileOrWikilink.endsWith("]]")) {
      return fileOrWikilink;
    }
    return `[[${fileOrWikilink}]]`;
  }

  private async validateFileExists(filePath: string): Promise<boolean> {
    const linkText = filePath.replace(/^\[\[(.*?)\]\]$/, "$1");

    let resolvedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, "");

    if (!resolvedFile) {
      const directResult = this.app.vault.getAbstractFileByPath(linkText);
      if (directResult instanceof TFile) {
        resolvedFile = directResult;
      }
    }

    if (!resolvedFile && !linkText.endsWith(".md")) {
      const withExtension = this.app.vault.getAbstractFileByPath(`${linkText}.md`);
      if (withExtension instanceof TFile) {
        resolvedFile = withExtension;
      }
    }

    return resolvedFile instanceof TFile;
  }
}
