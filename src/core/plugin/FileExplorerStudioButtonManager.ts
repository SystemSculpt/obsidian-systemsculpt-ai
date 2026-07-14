import { Notice, normalizePath, setIcon, type WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { applyPluginSurface } from "../ui/surface";

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
  private readonly observers = new Map<Document, MutationObserver>();
  private syncTimer: number | null = null;
  private syncWindow: Window | null = null;
  private createInFlight = false;
  private started = false;

  constructor(private readonly plugin: FileExplorerStudioButtonPlugin) {}

  start(): void {
    this.started = true;
    this.syncButtons();
  }

  dispose(): void {
    if (this.syncTimer != null) {
      this.syncWindow?.clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.syncWindow = null;
    }

    this.started = false;
    for (const observer of this.observers.values()) {
      observer.disconnect();
    }
    this.observers.clear();
    this.removeButtons();
  }

  syncButtons(): void {
    const documents = this.getWorkspaceDocuments();
    if (this.started) {
      this.syncObservers(documents);
    }
    for (const ownerDocument of documents) {
      const containers = ownerDocument.querySelectorAll<HTMLElement>(
        FILE_EXPLORER_BUTTONS_SELECTOR,
      );
      containers.forEach((container) => this.syncButton(container));
    }
  }

  private scheduleSync(hostWindow?: Window | null): void {
    if (this.syncTimer != null) {
      return;
    }

    this.syncWindow = hostWindow
      ?? window.activeDocument?.defaultView
      ?? window;
    this.syncTimer = this.syncWindow.setTimeout(() => {
      this.syncTimer = null;
      this.syncWindow = null;
      this.syncButtons();
    }, 50);
  }

  private removeButtons(): void {
    for (const ownerDocument of this.getWorkspaceDocuments()) {
      ownerDocument
        .querySelectorAll<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`)
        .forEach((button) => button.remove());
    }
  }

  private getWorkspaceDocuments(): Document[] {
    const documents = new Set<Document>();
    if (typeof document !== "undefined") {
      documents.add(document);
    }
    if (typeof window !== "undefined" && window.activeDocument) {
      documents.add(window.activeDocument);
    }

    const iterateAllLeaves = this.plugin.app.workspace.iterateAllLeaves;
    if (typeof iterateAllLeaves === "function") {
      iterateAllLeaves.call(this.plugin.app.workspace, (leaf: WorkspaceLeaf) => {
        const containerEl = (leaf.view as { containerEl?: HTMLElement }).containerEl;
        if (containerEl?.ownerDocument) {
          documents.add(containerEl.ownerDocument);
        }
      });
    }

    return Array.from(documents);
  }

  private syncObservers(documents: Document[]): void {
    const liveDocuments = new Set(documents);
    for (const [ownerDocument, observer] of this.observers) {
      if (!liveDocuments.has(ownerDocument)) {
        observer.disconnect();
        this.observers.delete(ownerDocument);
      }
    }

    for (const ownerDocument of documents) {
      if (this.observers.has(ownerDocument) || !ownerDocument.body) {
        continue;
      }
      const Observer = ownerDocument.defaultView?.MutationObserver;
      if (!Observer) {
        continue;
      }
      const observer = new Observer(() => this.scheduleSync(ownerDocument.defaultView));
      observer.observe(ownerDocument.body, { childList: true, subtree: true });
      this.observers.set(ownerDocument, observer);
    }
  }

  private syncButton(container: HTMLElement): void {
    let button = container.querySelector<HTMLElement>(`.${FILE_EXPLORER_STUDIO_BUTTON_CLASS}`);
    if (!button) {
      button = this.createButton(container);
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

  private createButton(container: HTMLElement): HTMLElement {
    const button = container.createDiv();
    applyPluginSurface(button, "embedded");
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
    button.classList.add("is-busy");
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-busy", "true");

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
      button.classList.remove("is-busy");
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-busy");
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
