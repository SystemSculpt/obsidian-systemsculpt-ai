import { TFile, prepareFuzzySearch, type App } from "obsidian";
import { isSupportedChatAttachmentName } from "./attachments/ChatMessageAttachments";

const SUGGESTION_LIMIT = 8;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

/** Markdown first, then PDFs and images, then other text files. */
function typeRank(file: TFile): number {
  const extension = file.extension.toLowerCase();
  if (extension === "md") return 0;
  if (extension === "pdf") return 1;
  if (IMAGE_EXTENSIONS.has(extension)) return 2;
  return 3;
}

type ObsidianDraggable = Readonly<{
  type?: unknown;
  file?: unknown;
  files?: unknown;
}>;

/**
 * The composer's narrow, read-only view of the vault: the active note, file
 * suggestions for mentions, reading a file into an attachment, and opening it.
 */
export class AgentComposerVault {
  constructor(
    private readonly app: App,
    private readonly sourcePath: () => string = () => "",
  ) {}

  /** The note the user last worked in, when the composer can attach it. */
  public activeNote(): TFile | null {
    const file = this.app.workspace.getActiveFile?.() ?? null;
    return file instanceof TFile && isSupportedChatAttachmentName(file.name) ? file : null;
  }

  public resolve(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  /**
   * Up to eight attachable files for a mention query. An empty query lists
   * recently opened files, then the most recently changed notes.
   */
  public suggest(query: string, limit = SUGGESTION_LIMIT): TFile[] {
    const files = this.app.vault.getFiles().filter((file) => isSupportedChatAttachmentName(file.name));
    const trimmed = query.trim();
    if (!trimmed) return this.recent(files, limit);
    const search = prepareFuzzySearch(trimmed);
    const lowered = trimmed.toLowerCase();
    const scored: Array<{ file: TFile; score: number; nameMatch: boolean; prefix: boolean }> = [];
    for (const file of files) {
      const byName = search(file.basename);
      const byPath = byName ? null : search(file.path);
      const match = byName ?? byPath;
      if (!match) continue;
      scored.push({
        file,
        score: match.score,
        nameMatch: byName !== null,
        prefix: file.basename.toLowerCase().startsWith(lowered),
      });
    }
    // Name matches, then markdown before PDFs and images, then the closest name.
    scored.sort((left, right) =>
      Number(right.nameMatch) - Number(left.nameMatch)
      || typeRank(left.file) - typeRank(right.file)
      || Number(right.prefix) - Number(left.prefix)
      || right.score - left.score
      || left.file.basename.length - right.file.basename.length
      || right.file.stat.mtime - left.file.stat.mtime
      || left.file.path.localeCompare(right.file.path));
    return scored.slice(0, limit).map((entry) => entry.file);
  }

  /** Reads a vault file into a browser File for the attachment gate. */
  public async read(file: TFile): Promise<File> {
    const bytes = await this.app.vault.readBinary(file);
    return new File([bytes], file.name, { lastModified: file.stat.mtime });
  }

  /** The shortest unambiguous wiki link text, as Obsidian would write it. */
  public linkText(file: TFile): string {
    const metadataCache = this.app.metadataCache;
    if (typeof metadataCache.fileToLinktext === "function") {
      return metadataCache.fileToLinktext(file, this.sourcePath(), true);
    }
    return file.extension === "md" ? file.basename : file.name;
  }

  public async open(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /** Whether a drag in progress carries files from Obsidian's own panes. */
  public isDraggingVaultFiles(): boolean {
    return this.draggedFiles().length > 0;
  }

  /**
   * Files dragged from Obsidian's file explorer, search, or another note.
   * Obsidian keeps these on its drag manager rather than the DataTransfer.
   */
  public draggedFiles(transfer?: DataTransfer | null): TFile[] {
    const manager = (this.app as unknown as { dragManager?: { draggable?: ObsidianDraggable | null } })
      .dragManager;
    const draggable = manager?.draggable;
    const files: TFile[] = [];
    if (draggable?.file instanceof TFile) files.push(draggable.file);
    if (Array.isArray(draggable?.files)) {
      for (const file of draggable.files) if (file instanceof TFile) files.push(file);
    }
    if (files.length === 0 && transfer) files.push(...this.filesFromObsidianUrls(transfer));
    return files.filter((file, index) =>
      isSupportedChatAttachmentName(file.name) && files.indexOf(file) === index);
  }

  private recent(files: readonly TFile[], limit: number): TFile[] {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const ordered: TFile[] = [];
    const recentPaths = this.app.workspace.getLastOpenFiles?.() ?? [];
    for (const path of recentPaths) {
      const file = byPath.get(path);
      if (file && !ordered.includes(file)) ordered.push(file);
      if (ordered.length >= limit) return ordered;
    }
    const remaining = files
      .filter((file) => !ordered.includes(file))
      .sort((left, right) =>
        typeRank(left) - typeRank(right) || right.stat.mtime - left.stat.mtime);
    return [...ordered, ...remaining].slice(0, limit);
  }

  /** Reads obsidian://open links, which Obsidian writes for cross-window drags. */
  private filesFromObsidianUrls(transfer: DataTransfer): TFile[] {
    const text = [transfer.getData("text/uri-list"), transfer.getData("text/plain")].join("\n");
    const files: TFile[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("obsidian://open?")) continue;
      try {
        const url = new URL(trimmed);
        const path = url.searchParams.get("file");
        if (!path) continue;
        const file = this.resolve(path) ?? this.resolve(`${path}.md`);
        if (file) files.push(file);
      } catch {
        continue;
      }
    }
    return files;
  }
}
