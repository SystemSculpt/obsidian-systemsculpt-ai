import { Notice, normalizePath, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { PlatformContext } from "../../services/PlatformContext";

export const FILE_EXPLORER_STUDIO_BUTTON_CLASS = "systemsculpt-file-explorer-new-studio-button";

const FILE_EXPLORER_BUTTONS_SELECTOR =
  '.workspace-leaf-content[data-type="file-explorer"] .nav-header .nav-buttons-container';
const NEW_STUDIO_PROJECT_NAME = "New Studio Project";
const NEW_STUDIO_PROJECT_FILE_NAME = `${NEW_STUDIO_PROJECT_NAME}.systemsculpt`;

type StudioServiceLike = ReturnType<SystemSculptPlugin["getStudioService"]>;
type ViewManagerLike = ReturnType<SystemSculptPlugin["getViewManager"]>;

type FileExplorerStudioButtonPlugin = Pick<
  SystemSculptPlugin,
  "app" | "getStudioService" | "getViewManager"
>;

export class FileExplorerStudioButtonManager {
  private observer: MutationObserver | null = null;
  private syncTimer: number | null = null;
  private createInFlight = false;

  constructor(private readonly plugin: FileExplorerStudioButtonPlugin) {}

  start(): void {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      return;
    }

    this.syncButtons();

    if (this.observer || typeof MutationObserver === "undefined" || !document.body) {
      return;
    }

    this.observer = new MutationObserver(() => this.scheduleSync());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  dispose(): void {
    if (this.syncTimer != null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    this.observer?.disconnect();
    this.observer = null;
    this.removeButtons();
  }

  syncButtons(): void {
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      this.removeButtons();
      return;
    }

    const containers = document.querySelectorAll<HTMLElement>(FILE_EXPLORER_BUTTONS_SELECTOR);
    containers.forEach((container) => this.syncButton(container));
  }

  private scheduleSync(): void {
    if (this.syncTimer != null) {
      return;
    }

    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncButtons();
    }, 50);
  }

  private removeButtons(): void {
    document
      .querySelectorAll<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)
      .forEach((button) => button.remove());
  }

  private syncButton(container: HTMLElement): void {
    let button = container.querySelector<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`);
    if (!button) {
      button = this.createButton();
    }

    const newNoteButton = this.findActionButton(container, ["New note"]);
    const newFolderButton = this.findActionButton(container, ["New folder"]);

    if (newNoteButton) {
      if (newNoteButton.nextElementSibling !== button) {
        newNoteButton.insertAdjacentElement("afterend", button);
      }
      return;
    }

    if (newFolderButton) {
      if (newFolderButton.previousElementSibling !== button) {
        container.insertBefore(button, newFolderButton);
      }
      return;
    }

    if (button.parentElement !== container) {
      container.appendChild(button);
    }
  }

  private createButton(): HTMLElement {
    const button = document.createElement("div");
    button.classList.add(
      "clickable-icon",
      "nav-action-button",
      FILE_EXPLORER_STUDIO_BUTTON_CLASS
    );
    button.setAttribute("aria-label", "New Studio");
    button.setAttribute("data-tooltip-position", "bottom");
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    setIcon(button, "workflow");

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.createAndOpenStudioProject(button);
    });

    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void this.createAndOpenStudioProject(button);
    });

    return button;
  }

  private findActionButton(container: HTMLElement, labels: string[]): HTMLElement | null {
    const labelSet = new Set(labels.map((label) => label.toLowerCase()));
    const candidates = container.querySelectorAll<HTMLElement>(".nav-action-button, .clickable-icon");

    for (const candidate of Array.from(candidates)) {
      const label = (
        candidate.getAttribute("aria-label") ||
        candidate.getAttribute("data-tooltip") ||
        candidate.getAttribute("title") ||
        ""
      ).trim().toLowerCase();

      if (labelSet.has(label)) {
        return candidate;
      }
    }

    return null;
  }

  private async createAndOpenStudioProject(button: HTMLElement): Promise<void> {
    if (this.createInFlight) {
      return;
    }

    this.createInFlight = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-disabled", "true");

    try {
      const studio = this.plugin.getStudioService() as StudioServiceLike;
      const projectPath = this.resolveTargetProjectPath(button);
      const created = await studio.createProjectFile(
        projectPath
          ? {
              name: NEW_STUDIO_PROJECT_NAME,
              projectPath,
            }
          : {
              name: NEW_STUDIO_PROJECT_NAME,
            }
      );

      const viewManager = this.plugin.getViewManager() as ViewManagerLike;
      await viewManager.activateSystemSculptStudioView(created.path);
      new Notice(`Created Studio project: ${created.project.name}`);
    } catch (error: any) {
      new Notice(`Unable to create Studio project: ${error?.message || error}`);
    } finally {
      this.createInFlight = false;
      button.classList.remove("is-loading");
      button.removeAttribute("aria-disabled");
    }
  }

  private resolveTargetProjectPath(button: HTMLElement): string | undefined {
    const folderPath = this.resolveTargetFolderPath(button);
    if (folderPath === null) {
      return undefined;
    }

    return normalizePath(
      folderPath
        ? `${folderPath}/${NEW_STUDIO_PROJECT_FILE_NAME}`
        : NEW_STUDIO_PROJECT_FILE_NAME
    );
  }

  private resolveTargetFolderPath(button: HTMLElement): string | null {
    const explorer = button.closest<HTMLElement>('.workspace-leaf-content[data-type="file-explorer"]');
    const activeExplorerFolderPath = explorer
      ? this.findActivePath(explorer, ".nav-folder-title")
      : null;
    const normalizedExplorerFolderPath = this.normalizeFolderPath(activeExplorerFolderPath);
    if (normalizedExplorerFolderPath !== null) {
      return normalizedExplorerFolderPath;
    }

    const activeExplorerFilePath = explorer ? this.findActivePath(explorer, ".nav-file-title") : null;
    const explorerFileParent = this.parentFolderPath(activeExplorerFilePath);
    if (explorerFileParent !== null) {
      return explorerFileParent;
    }

    const activeFile = this.plugin.app.workspace.getActiveFile?.() as { path?: unknown } | null | undefined;
    if (activeFile && typeof activeFile.path === "string") {
      return this.parentFolderPath(activeFile.path);
    }

    return null;
  }

  private findActivePath(explorer: HTMLElement, titleSelector: string): string | null {
    const activeSelectors = [
      `${titleSelector}.is-active[data-path]`,
      `${titleSelector}.is-selected[data-path]`,
      `${titleSelector}.mod-active[data-path]`,
      `${titleSelector}[aria-selected="true"][data-path]`,
    ];

    for (const selector of activeSelectors) {
      const activeTitle = explorer.querySelector<HTMLElement>(selector);
      const path = activeTitle?.getAttribute("data-path");
      if (path != null) {
        return path;
      }
    }

    return null;
  }

  private parentFolderPath(filePath: string | null | undefined): string | null {
    if (filePath == null) {
      return null;
    }

    const normalized = normalizePath(String(filePath || "").trim().replace(/^\/+|\/+$/g, ""));
    if (!normalized) {
      return "";
    }

    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
  }

  private normalizeFolderPath(path: string | null | undefined): string | null {
    if (path == null) {
      return null;
    }

    const raw = String(path).trim();
    if (!raw || raw === "/" || raw === "\\") {
      return "";
    }

    return normalizePath(raw.replace(/^\/+|\/+$/g, ""));
  }
}
