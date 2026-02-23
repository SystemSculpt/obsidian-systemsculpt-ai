import { App, Modal, TFile } from "obsidian";

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
  const modal = new Modal(app);
  modal.setTitle(options.title || "Media Preview");
  modal.contentEl.addClass("ss-studio-media-preview-modal");

  if (options.kind === "image") {
    const imageEl = modal.contentEl.createEl("img", {
      cls: "ss-studio-media-preview-modal-image",
    });
    imageEl.src = options.src;
    imageEl.alt = options.title || "Image preview";
    imageEl.decoding = "async";
    imageEl.loading = "eager";
    imageEl.draggable = false;
  } else {
    const videoEl = modal.contentEl.createEl("video", {
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
    const pathEl = modal.contentEl.createEl("p", {
      cls: "ss-studio-media-preview-modal-path",
    });
    pathEl.setText(options.path);
  }

  modal.open();
}
