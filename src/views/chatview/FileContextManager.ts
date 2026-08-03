import { App, TFile } from "obsidian";
import { DocumentContextManager } from "../../services/DocumentContextManager";
import { ContextSelectionModal } from "../../modals/ContextSelectionModal";
import type SystemSculptPlugin from "../../main";

export const FILE_CONTEXT_STATE_CHANGED_EVENT = "systemsculpt:file-context-state-changed";

export interface FileContextStateChangedEvent {
  manager: FileContextManager;
  kind: "context";
}

interface FileContextManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  onContextChange: () => Promise<void>;
}

export class FileContextManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly onContextChange: () => Promise<void>;

  private pinnedFiles = new Set<string>();

  constructor(options: FileContextManagerOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.onContextChange = options.onContextChange;
  }

  private emitContextChanged(): void {
    (this.app.workspace as any).trigger(FILE_CONTEXT_STATE_CHANGED_EVENT, {
      manager: this,
      kind: "context",
    } satisfies FileContextStateChangedEvent);
  }

  public getPinnedFiles(): ReadonlySet<string> {
    return this.pinnedFiles;
  }

  public hasPinnedFile(fileOrWikiLink: string): boolean {
    if (!fileOrWikiLink || typeof fileOrWikiLink !== "string") return false;
    return this.pinnedFiles.has(this.normalizeWikiLink(fileOrWikiLink));
  }

  public pinFile(fileOrWikiLink: string): boolean {
    if (!fileOrWikiLink || typeof fileOrWikiLink !== "string") {
      return false;
    }

    const normalized = this.normalizeWikiLink(fileOrWikiLink);
    if (this.pinnedFiles.has(normalized)) {
      return false;
    }

    this.pinnedFiles.add(normalized);
    this.emitContextChanged();
    return true;
  }

  public async unpinFile(filePath: string): Promise<boolean> {
    if (!filePath || typeof filePath !== "string") {
      return false;
    }

    const normalizedPath = filePath.replace(/^\[\[(.*?)\]\]$/, "$1");
    const wikiLink = this.normalizeWikiLink(normalizedPath);

    const hadFile = this.pinnedFiles.has(filePath) || this.pinnedFiles.has(wikiLink);
    if (!hadFile) return false;

    this.pinnedFiles.delete(filePath);
    this.pinnedFiles.delete(wikiLink);
    this.emitContextChanged();

    await this.onContextChange();
    return true;
  }

  public async openPinFiles(): Promise<void> {
    const modal = new ContextSelectionModal(
      this.app,
      async (files) => {
        const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
        await documentContextManager.pinVaultFiles(files, this, { showNotices: true, saveChanges: true, maxFiles: 100 });
      },
      this.plugin,
      {
        isFileAlreadyPinned: (file) => this.hasPinnedFile(file.path),
      }
    );
    modal.open();
  }

  public async pinVaultFile(file: TFile): Promise<void> {
    const documentContextManager = DocumentContextManager.getInstance(this.app, this.plugin);
    await documentContextManager.pinVaultFile(file, this, { showNotices: true, saveChanges: true });
  }

  public async triggerContextChange(): Promise<void> {
    await this.onContextChange();
  }

  public clearPinnedFiles(): void {
    this.pinnedFiles.clear();
    this.emitContextChanged();
  }

  public async setPinnedFiles(files: string[]): Promise<void> {
    const validFiles = Array.isArray(files) ? files.filter((file) => !!file && typeof file === "string") : [];
    const normalizedFiles = validFiles.map((file) => this.normalizeWikiLink(file));

    const existingFiles: string[] = [];
    for (const file of normalizedFiles) {
      if (await this.validateFileExists(file)) {
        existingFiles.push(file);
      }
    }

    this.pinnedFiles = new Set(existingFiles);
    this.emitContextChanged();
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
