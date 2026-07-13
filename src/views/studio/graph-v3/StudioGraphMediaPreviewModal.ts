import { App, TFile } from "obsidian";
import { StandardModal } from "../../../core/ui/modals/standard/StandardModal";

export type StudioGraphMediaPreviewModalOptions = {
  kind: "image" | "video";
  path: string;
  src: string;
  title: string;
};

export function resolveStudioAssetPreviewSrc(app: App, assetPath: string): string | null {
  const normalized = String(assetPath || "").trim();
  if (!normalized) {
    return null;
  }

  const normalizedSlashes = normalized.replace(/\\/g, "/");
  const isAbsolutePath = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedSlashes);

  const adapter = app.vault.adapter as {
    getResourcePath?: (path: string) => string;
  };

  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) {
    if (isAbsolutePath) {
      // app:// resource URLs for absolute non-vault paths resolve to invalid vault-prefixed routes.
      // media_ingest should provide preview_path (vault asset) for these cases.
      return null;
    }
    if (typeof adapter.getResourcePath === "function") {
      try {
        const resourcePath = adapter.getResourcePath(normalized);
        if (typeof resourcePath === "string" && resourcePath.trim().length > 0) {
          return resourcePath;
        }
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    return app.vault.getResourcePath(file);
  } catch {
    return null;
  }
}

export function openStudioMediaPreviewModal(
  app: App,
  options: StudioGraphMediaPreviewModalOptions
): void {
  new StudioGraphMediaPreviewModal(app, options).open();
}

class StudioGraphMediaPreviewModal extends StandardModal {
  constructor(app: App, private readonly options: StudioGraphMediaPreviewModalOptions) {
    super(app);
    this.setSize("fullwidth");
    this.modalEl.addClass("ss-studio-media-preview-modal-shell");
  }

  onOpen(): void {
    super.onOpen();
    const options = this.options;
    this.addTitle(options.title || "Media preview");
    this.contentEl.addClass("ss-studio-media-preview-modal");

    if (options.kind === "image") {
      const imageEl = this.contentEl.createEl("img", {
        cls: "ss-studio-media-preview-modal-image",
      });
      imageEl.src = options.src;
      imageEl.alt = options.title || "Image preview";
      imageEl.decoding = "async";
      imageEl.loading = "eager";
      imageEl.draggable = false;
    } else {
      const videoEl = this.contentEl.createEl("video", {
        cls: "ss-studio-media-preview-modal-video",
      });
      videoEl.src = options.src;
      videoEl.controls = true;
      videoEl.muted = false;
      videoEl.preload = "metadata";
      videoEl.playsInline = true;
      videoEl.setAttribute("aria-label", options.title || "Video preview");
    }

    if (options.path) {
      this.contentEl.createEl("p", {
        cls: "ss-studio-media-preview-modal-path",
        text: options.path,
      });
    }

    this.addActionButton("Close", () => this.close(), true);
  }
}
