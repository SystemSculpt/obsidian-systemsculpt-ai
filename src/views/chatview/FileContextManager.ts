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
};

interface FileContextManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  onContextChange: () => Promise<void>;
}

export class FileContextManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly onContextChange: () => Promise<void>;

  private contextFiles = new Set<string>();

  private processing = new Map<string, ProcessingEntry>();

  constructor(options: FileContextManagerOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.onContextChange = options.onContextChange;
  }

  public destroy(): void {
    for (const entry of this.processing.values()) {
      if (entry.removalTimeoutId) {
        window.clearTimeout(entry.removalTimeoutId);
      }
    }
    this.processing.clear();
  }

  private emitContextChanged(): void {
    document.dispatchEvent(new CustomEvent("systemsculpt:context-changed"));
  }

  private emitProcessingChanged(): void {
    document.dispatchEvent(new CustomEvent("systemsculpt:context-processing-changed"));
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
      this.plugin
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
    this.processing.clear();
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
    this.processing.clear();
    this.emitContextChanged();
    this.emitProcessingChanged();
  }

  public updateProcessingStatus(file: TFile, event: DocumentProcessingProgressEvent): void {
    const key = file.path;
    const existing = this.processing.get(key);
    if (existing?.removalTimeoutId) {
      window.clearTimeout(existing.removalTimeoutId);
    }

    const entry: ProcessingEntry = {
      file,
      event,
      updatedAt: Date.now(),
      removalTimeoutId: null,
    };

    if (event.stage === "ready") {
      entry.removalTimeoutId = window.setTimeout(() => {
        this.processing.delete(key);
        this.emitProcessingChanged();
      }, 1500);
    } else if (event.stage === "error") {
      entry.removalTimeoutId = window.setTimeout(() => {
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
    if (entry.removalTimeoutId) {
      window.clearTimeout(entry.removalTimeoutId);
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
