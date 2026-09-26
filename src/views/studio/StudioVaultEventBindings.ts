import type { App, TAbstractFile } from "obsidian";

export function bindStudioVaultEvents(app: App, surface: HTMLElement, handlers: {
  assetChanged: (path: string) => void;
  assetFailed: (path: string) => void;
  modified: (file: TAbstractFile) => void;
  renamed: (file: TAbstractFile, oldPath: string) => void;
  deleted: (file: TAbstractFile) => void;
}): () => void {
  const refs = [
    app.vault.on("modify", file => { handlers.assetChanged(file.path); handlers.modified(file); }),
    app.vault.on("create", file => { handlers.assetChanged(file.path); }),
    app.vault.on("rename", (file, oldPath) => { handlers.assetChanged(oldPath); handlers.assetChanged(file.path); handlers.renamed(file, oldPath); }),
    app.vault.on("delete", file => { handlers.assetChanged(file.path); handlers.deleted(file); }),
  ];
  const mediaError = (event: Event): void => {
    const path = (event.target as HTMLElement | null)?.getAttribute?.("data-studio-asset-path");
    if (path) handlers.assetFailed(path);
  };
  surface.addEventListener("error", mediaError, true);
  return () => { for (const ref of refs) app.vault.offref(ref); surface.removeEventListener("error", mediaError, true); };
}
