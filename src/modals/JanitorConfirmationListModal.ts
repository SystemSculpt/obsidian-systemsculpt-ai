import { App, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { isAudioFileExtension } from "../constants/fileTypes";

export interface ConfirmationListItem {
  path: string;
  icon: string;
  detail?: string;
}

export interface ConfirmationListGroup {
  title?: string;
  icon?: string;
  items: readonly ConfirmationListItem[];
  previewLimit?: number;
  moreLabel: string;
}

export interface ConfirmationListModalOptions {
  title: string;
  description: string;
  summary?: string;
  groups: readonly ConfirmationListGroup[];
  confirmLabel?: string;
  confirmIcon?: string;
}

/** Formats a file-size total once for the Janitor dashboard and confirmations. */
export function formatJanitorFileSize(
  files: readonly { stat: { size: number } }[],
): string {
  const totalBytes = files.reduce(
    (total, file) => total + Math.max(0, Number(file.stat.size) || 0),
    0,
  );
  if (totalBytes === 0) return "empty";
  if (totalBytes < 1024) return `${totalBytes} bytes`;
  if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
  if (totalBytes < 1024 * 1024 * 1024) {
    return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function janitorFileIcon(extension: string): string {
  const normalized = extension.toLowerCase();
  if (["md", "txt", "markdown", "pdf"].includes(normalized)) return "file-text";
  if (["jpg", "jpeg", "png", "webp", "svg"].includes(normalized)) return "image";
  if (isAudioFileExtension(normalized)) return "audio-lines";
  return "file";
}

/** One confirmation lifecycle and preview renderer for every Janitor cleanup. */
export class JanitorConfirmationListModal extends StandardModal {
  private resolver: ((confirmed: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly options: ConfirmationListModalOptions,
  ) {
    super(app);
    this.setSize("medium");
    this.modalEl.addClass("ss-janitor-confirmation-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle(this.options.title, this.options.description);
    this.renderPreview();
    this.addActionButton("Cancel", () => this.settle(false));
    this.addActionButton(
      this.options.confirmLabel ?? "Move to Trash",
      () => this.settle(true),
      false,
      this.options.confirmIcon ?? "trash-2",
      "danger",
    );
  }

  open(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      super.open();
    });
  }

  onClose(): void {
    this.resolve(false);
    super.onClose();
  }

  private renderPreview(): void {
    const preview = this.contentEl.createDiv({ cls: "ss-janitor-preview" });
    if (this.options.summary) {
      preview.createDiv({
        cls: "ss-janitor-preview-header ss-janitor-preview-count",
        text: this.options.summary,
      });
    }

    for (const group of this.options.groups) {
      if (group.items.length === 0) continue;
      const section = group.title
        ? preview.createDiv({ cls: "ss-janitor-preview-section" })
        : preview;

      if (group.title) {
        const header = section.createDiv({ cls: "ss-janitor-preview-section-header" });
        if (group.icon) {
          const icon = header.createDiv({ cls: "ss-janitor-preview-section-icon" });
          setIcon(icon, group.icon);
        }
        header.createSpan({
          cls: "ss-janitor-preview-section-title",
          text: `${group.title} (${group.items.length})`,
        });
      }

      const list = section.createDiv({ cls: "ss-janitor-preview-list" });
      const limit = Math.max(1, group.previewLimit ?? 10);
      for (const item of group.items.slice(0, limit)) {
        const row = list.createDiv({ cls: "ss-janitor-preview-item" });
        const icon = row.createDiv({ cls: "ss-janitor-preview-icon" });
        setIcon(icon, item.icon);
        row.createDiv({ cls: "ss-janitor-preview-path", text: item.path });
        if (item.detail) {
          row.createDiv({ cls: "ss-janitor-preview-size", text: item.detail });
        }
      }

      const hiddenCount = group.items.length - limit;
      if (hiddenCount > 0) {
        list.createDiv({
          cls: "ss-janitor-preview-more",
          text: `... and ${hiddenCount} more ${group.moreLabel}`,
        });
      }
    }
  }

  private settle(confirmed: boolean): void {
    this.resolve(confirmed);
    this.close();
  }

  private resolve(confirmed: boolean): void {
    const resolve = this.resolver;
    if (!resolve) return;
    this.resolver = null;
    resolve(confirmed);
  }
}
