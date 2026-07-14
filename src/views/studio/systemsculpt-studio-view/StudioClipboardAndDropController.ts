import { App, Notice, TFile, normalizePath } from "obsidian";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";
import { randomId } from "../../../studio/utils";
import { tryCopyToClipboard } from "../../../utils/clipboard";
import { cloneConfigDefaults, prettifyNodeKind } from "../StudioViewHelpers";
import {
  buildGraphClipboardPayload,
  parseGraphClipboardPayload,
  STUDIO_GRAPH_CLIPBOARD_SCHEMA,
  type StudioGraphClipboardPayload,
} from "./StudioGraphClipboardModel";
import { materializeGraphClipboardPaste } from "./StudioGraphClipboardPasteMaterializer";
import {
  collectStudioDroppedItems,
  extractClipboardMediaFiles,
  extractClipboardText,
  normalizePastedMediaMimeType,
} from "./StudioClipboardData";
import {
  buildMediaIngestNode,
  buildPastedTextNode,
  materializePastedMediaNodes,
} from "./StudioClipboardPasteNodes";
import { resolveVaultItemFromReference } from "./StudioVaultReferenceResolver";

export type StudioGraphPoint = { x: number; y: number };

export type StudioCreatedNodesFinalization = {
  selection: string[];
  selectionMode: "only" | "replace";
  pendingConnectionMode: "default" | "silent";
  hideNodeMenus?: boolean;
  refreshNoteNodeIds?: string[];
};

/**
 * Narrow bridge back to private view state. Clipboard/drop policy and state
 * stay in the controller; the host only exposes graph mutation primitives and
 * the existing note-node materializer, which remains part of note runtime.
 */
export interface StudioClipboardAndDropHost {
  isActive(): boolean;
  isBusy(): boolean;
  isEditableTarget(target: EventTarget | null): boolean;
  getCurrentProject(): StudioProjectV1 | null;
  getProjectPath(): string | null;
  getNodeDefinitions(): readonly StudioNodeDefinition[];
  getSelectedNodeIds(): string[];
  getGraphZoom(): number;
  getDefaultNodePosition(project: StudioProjectV1): StudioGraphPoint;
  normalizeNodePosition(position: StudioGraphPoint): StudioGraphPoint;
  commitNodeCreation(mutator: (project: StudioProjectV1) => boolean | void): boolean;
  finalizeCreatedNodes(
    project: StudioProjectV1,
    options: StudioCreatedNodesFinalization,
  ): void;
  removeNodes(nodeIds: string[]): boolean;
  insertVaultNoteNodes(
    notePaths: string[],
    anchor: StudioGraphPoint,
    source: "paste" | "drop",
  ): Promise<void>;
  storeAsset(
    projectPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<{ path: string }>;
  setError(error: unknown): void;
}

type StudioClipboardAndDropDependencies = {
  createId(prefix: string): string;
  copyText(text: string, host?: Node): Promise<boolean>;
};

type ProjectOperationScope = {
  project: StudioProjectV1;
  projectPath: string;
  lifecycleEpoch: number;
};

const DEFAULT_DEPENDENCIES: StudioClipboardAndDropDependencies = {
  createId: (prefix) => randomId(prefix),
  copyText: (text, host) => tryCopyToClipboard(text, host),
};

/**
 * Owns Studio's graph clipboard and external paste/drop ingestion lifecycle.
 * No view instance escapes through this boundary.
 */
export class StudioClipboardAndDropController {
  private graphClipboardPayload: StudioGraphClipboardPayload | null = null;
  private graphClipboardPasteCount = 0;
  private listenerWindow: Window | null = null;
  private viewportEl: HTMLElement | null = null;
  private lastGraphPointerPosition: StudioGraphPoint | null = null;
  private lifecycleEpoch = 0;
  private disposed = false;
  private readonly dependencies: StudioClipboardAndDropDependencies;

  private readonly onWindowPaste = (event: ClipboardEvent): void => {
    void this.handlePaste(event);
  };

  private readonly onViewportPointerMove = (event: PointerEvent): void => {
    this.capturePointerPosition(event);
  };

  private readonly onViewportPointerLeave = (): void => {
    this.lastGraphPointerPosition = null;
  };

  private readonly onViewportDragOver = (event: DragEvent): void => {
    this.handleDragOver(event);
  };

  private readonly onViewportDrop = (event: DragEvent): void => {
    void this.handleDrop(event);
  };

  constructor(
    private readonly app: App,
    private readonly host: StudioClipboardAndDropHost,
    dependencies?: Partial<StudioClipboardAndDropDependencies>,
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  bindOwnerWindow(ownerWindow: Window): void {
    this.disposed = false;
    if (this.listenerWindow === ownerWindow) return;
    this.unbindOwnerWindow();
    ownerWindow.addEventListener("paste", this.onWindowPaste, true);
    this.listenerWindow = ownerWindow;
  }

  unbindOwnerWindow(): void {
    this.listenerWindow?.removeEventListener("paste", this.onWindowPaste, true);
    this.listenerWindow = null;
  }

  bindViewport(viewport: HTMLElement | null): void {
    if (this.viewportEl === viewport) return;
    this.unbindViewport();
    if (!viewport) return;
    this.viewportEl = viewport;
    viewport.addEventListener("pointermove", this.onViewportPointerMove, { passive: true });
    viewport.addEventListener("pointerleave", this.onViewportPointerLeave, { passive: true });
    viewport.addEventListener("dragover", this.onViewportDragOver);
    viewport.addEventListener("drop", this.onViewportDrop);
  }

  unbindViewport(): void {
    if (this.viewportEl) {
      this.viewportEl.removeEventListener("pointermove", this.onViewportPointerMove);
      this.viewportEl.removeEventListener("pointerleave", this.onViewportPointerLeave);
      this.viewportEl.removeEventListener("dragover", this.onViewportDragOver);
      this.viewportEl.removeEventListener("drop", this.onViewportDrop);
    }
    this.viewportEl = null;
    this.lastGraphPointerPosition = null;
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.unbindOwnerWindow();
    this.unbindViewport();
    this.graphClipboardPayload = null;
    this.graphClipboardPasteCount = 0;
  }

  copySelectedGraphNodes(options?: { showNotice?: boolean }): boolean {
    if (this.disposed || this.host.isBusy()) return false;
    const project = this.host.getCurrentProject();
    if (!project) return false;
    const payload = buildGraphClipboardPayload({
      project,
      selectedNodeIds: this.host.getSelectedNodeIds(),
    });
    if (!payload) return false;

    this.graphClipboardPayload = payload;
    this.graphClipboardPasteCount = 0;
    void this.syncGraphClipboardToSystemClipboard(payload);
    if (options?.showNotice !== false) {
      new Notice(payload.nodes.length === 1 ? "Copied 1 node." : `Copied ${payload.nodes.length} nodes.`);
    }
    return true;
  }

  cutSelectedGraphNodes(): boolean {
    if (this.host.isBusy() || !this.host.getCurrentProject()) return false;
    const selectedNodeIds = this.host.getSelectedNodeIds();
    if (selectedNodeIds.length === 0) return false;
    if (!this.copySelectedGraphNodes({ showNotice: false })) return false;
    if (!this.host.removeNodes(selectedNodeIds)) {
      new Notice("Unable to cut: the selected nodes no longer exist in this project.");
      return false;
    }
    new Notice(selectedNodeIds.length === 1 ? "Cut 1 node." : `Cut ${selectedNodeIds.length} nodes.`);
    return true;
  }

  pasteGraphClipboardPayload(payloadOverride?: StudioGraphClipboardPayload): boolean {
    const scope = this.captureProjectScope();
    if (!scope || this.host.isBusy()) return false;
    const payload = payloadOverride || this.graphClipboardPayload;
    if (
      !payload ||
      payload.schema !== STUDIO_GRAPH_CLIPBOARD_SCHEMA ||
      !Array.isArray(payload.nodes) ||
      payload.nodes.length === 0
    ) {
      return false;
    }

    const materialized = materializeGraphClipboardPaste({
      payload,
      anchor: this.resolvePasteAnchorPosition(),
      pasteCount: this.graphClipboardPasteCount,
      normalizeNodePosition: (position) => this.host.normalizeNodePosition(position),
      nextNodeId: () => this.dependencies.createId("node"),
      nextEdgeId: () => this.dependencies.createId("edge"),
      nextGroupId: () => this.dependencies.createId("group"),
    });
    if (!materialized) return false;

    const { newNodes, newEdges, newGroups, nextSelection } = materialized;
    const changed = this.host.commitNodeCreation((project) => {
      project.graph.nodes.push(...newNodes);
      project.graph.edges.push(...newEdges);
      if (newGroups.length > 0) {
        if (!Array.isArray(project.graph.groups)) project.graph.groups = [];
        project.graph.groups.push(...newGroups);
      }
      return true;
    });
    if (!changed || !this.isScopeCurrent(scope)) return false;

    const pastedNoteNodeIds = newNodes
      .filter((node) => node.kind === "studio.note")
      .map((node) => node.id);
    this.host.finalizeCreatedNodes(scope.project, {
      selection: nextSelection,
      selectionMode: "replace",
      pendingConnectionMode: "silent",
      hideNodeMenus: true,
      refreshNoteNodeIds: pastedNoteNodeIds,
    });
    this.graphClipboardPasteCount += 1;
    new Notice(newNodes.length === 1 ? "Pasted 1 node." : `Pasted ${newNodes.length} nodes.`);
    return true;
  }

  async handlePaste(event: ClipboardEvent): Promise<void> {
    if (
      event.defaultPrevented ||
      !this.host.isActive() ||
      this.host.isBusy() ||
      !this.host.getCurrentProject() ||
      !this.host.getProjectPath() ||
      this.host.isEditableTarget(event.target)
    ) {
      return;
    }

    const pastedText = extractClipboardText(event);
    const graphPayload = parseGraphClipboardPayload(pastedText);
    if (graphPayload) {
      const previousCreatedAt = this.graphClipboardPayload?.createdAt || "";
      this.graphClipboardPayload = graphPayload;
      if (previousCreatedAt !== graphPayload.createdAt) this.graphClipboardPasteCount = 0;
      this.consumeEvent(event);
      try {
        this.pasteGraphClipboardPayload(graphPayload);
      } catch (error) {
        this.host.setError(error);
      }
      return;
    }

    const mediaFiles = extractClipboardMediaFiles(event);
    if (mediaFiles.length > 0) {
      this.consumeEvent(event);
      try {
        await this.pasteClipboardMedia(mediaFiles);
      } catch (error) {
        this.host.setError(error);
      }
      return;
    }

    if (!pastedText || pastedText.trim().length === 0) return;
    this.consumeEvent(event);
    try {
      const notePath = pastedText.includes("\n") || pastedText.includes("\r")
        ? null
        : this.resolveMarkdownVaultPathFromReference(pastedText);
      if (notePath) {
        await this.host.insertVaultNoteNodes(
          [notePath],
          this.resolvePasteAnchorPosition(),
          "paste",
        );
        return;
      }
      this.pasteClipboardText(pastedText);
    } catch (error) {
      this.host.setError(error);
    }
  }

  pasteClipboardText(text: string): boolean {
    const scope = this.captureProjectScope();
    if (!scope) return false;
    const definition = this.findNodeDefinition("studio.text");
    if (!definition) throw new Error("Text node definition is unavailable.");

    const node = buildPastedTextNode({
      textNodeDefinition: definition,
      text,
      position: this.resolvePasteAnchorPosition(),
      nextNodeId: () => this.dependencies.createId("node"),
      prettifyNodeKind,
      cloneConfigDefaults,
      normalizeNodePosition: (position) => this.host.normalizeNodePosition(position),
    });
    const changed = this.host.commitNodeCreation((project) => {
      project.graph.nodes.push(node);
      return true;
    });
    if (!changed || !this.isScopeCurrent(scope)) return false;

    this.host.finalizeCreatedNodes(scope.project, {
      selection: [node.id],
      selectionMode: "only",
      pendingConnectionMode: "default",
    });
    new Notice("Pasted as text.");
    return true;
  }

  async pasteClipboardMedia(mediaFiles: File[]): Promise<boolean> {
    const scope = this.captureProjectScope();
    if (!scope) return false;
    const definition = this.findNodeDefinition("studio.media_ingest");
    if (!definition) throw new Error("Media node definition is unavailable.");

    const nodes = await materializePastedMediaNodes({
      mediaFiles,
      mediaDefinition: definition,
      anchor: this.resolvePasteAnchorPosition(),
      projectPath: scope.projectPath,
      nextNodeId: () => this.dependencies.createId("node"),
      normalizeNodePosition: (position) => this.host.normalizeNodePosition(position),
      normalizeMimeType: normalizePastedMediaMimeType,
      storeAsset: (projectPath, bytes, mimeType) =>
        this.host.storeAsset(projectPath, bytes, mimeType),
      prettifyNodeKind,
      cloneConfigDefaults,
    });
    if (nodes.length === 0 || !this.isScopeCurrent(scope)) return false;
    const changed = this.host.commitNodeCreation((project) => {
      project.graph.nodes.push(...nodes);
      return true;
    });
    if (!changed || !this.isScopeCurrent(scope)) return false;

    this.host.finalizeCreatedNodes(scope.project, {
      selection: [nodes[nodes.length - 1].id],
      selectionMode: "only",
      pendingConnectionMode: "default",
    });
    new Notice(
      nodes.length === 1
        ? "Pasted 1 media file as a Media node."
        : `Pasted ${nodes.length} media files as Media nodes.`,
    );
    return true;
  }

  handleDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    this.consumeEvent(event);
    if (
      this.host.isBusy() ||
      !this.host.getCurrentProject() ||
      !this.host.getProjectPath()
    ) {
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }

  async handleDrop(event: DragEvent): Promise<void> {
    if (!event.dataTransfer) return;
    this.consumeEvent(event);
    const scope = this.captureProjectScope();
    if (!scope || this.host.isBusy()) return;

    const dropped = await collectStudioDroppedItems(event.dataTransfer, {
      getAbstractFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
      resolveVaultPathFromAbsoluteFilePath: (absolutePath) =>
        this.resolveVaultPathFromAbsoluteFilePath(absolutePath),
    });
    if (!this.isScopeCurrent(scope)) return;

    const totalCollected =
      dropped.notePaths.length +
      dropped.folderPaths.length +
      dropped.unsupportedPaths.length +
      dropped.vaultMediaPaths.length +
      dropped.externalMediaFiles.length;
    if (totalCollected === 0) {
      const hasPayload =
        (event.dataTransfer.types?.length || 0) > 0 ||
        (event.dataTransfer.files?.length || 0) > 0;
      if (hasPayload) new Notice("Drop a Markdown note or media file to create a node.");
      return;
    }
    if (dropped.folderPaths.length > 0) {
      new Notice("Dropping folders into Studio is not supported yet.");
    }

    const anchor =
      this.resolveGraphPositionFromClientPoint(event.clientX, event.clientY) ||
      this.resolvePasteAnchorPosition();
    let handledSomething = false;
    if (dropped.vaultMediaPaths.length > 0 || dropped.externalMediaFiles.length > 0) {
      try {
        await this.dropMediaIntoStudio({
          vaultMediaPaths: dropped.vaultMediaPaths,
          externalMediaFiles: dropped.externalMediaFiles,
          anchor,
        });
        handledSomething = true;
      } catch (error) {
        this.host.setError(error);
      }
    }
    if (dropped.notePaths.length > 0 && this.isScopeCurrent(scope)) {
      await this.host.insertVaultNoteNodes(dropped.notePaths, anchor, "drop");
      handledSomething = true;
    }
    if (!handledSomething && dropped.unsupportedPaths.length > 0) {
      new Notice("Only Markdown notes and media files can be dropped into Studio.");
    }
  }

  async dropMediaIntoStudio(options: {
    vaultMediaPaths: string[];
    externalMediaFiles: File[];
    anchor: StudioGraphPoint;
  }): Promise<boolean> {
    const scope = this.captureProjectScope();
    if (!scope) return false;
    const definition = this.findNodeDefinition("studio.media_ingest");
    if (!definition) throw new Error("Media node definition is unavailable.");

    const newNodes: StudioNodeInstance[] = [];
    const pushNodeForPath = (sourcePath: string): void => {
      newNodes.push(buildMediaIngestNode({
        mediaDefinition: definition,
        sourcePath,
        anchor: options.anchor,
        index: newNodes.length,
        nextNodeId: () => this.dependencies.createId("node"),
        normalizeNodePosition: (position) => this.host.normalizeNodePosition(position),
        prettifyNodeKind,
        cloneConfigDefaults,
      }));
    };
    for (const vaultPath of options.vaultMediaPaths) pushNodeForPath(vaultPath);
    for (const file of options.externalMediaFiles) {
      const asset = await this.host.storeAsset(
        scope.projectPath,
        await file.arrayBuffer(),
        normalizePastedMediaMimeType(file.type),
      );
      if (!this.isScopeCurrent(scope)) return false;
      pushNodeForPath(asset.path);
    }
    if (newNodes.length === 0 || !this.isScopeCurrent(scope)) return false;

    const changed = this.host.commitNodeCreation((project) => {
      project.graph.nodes.push(...newNodes);
      return true;
    });
    if (!changed || !this.isScopeCurrent(scope)) return false;
    this.host.finalizeCreatedNodes(scope.project, {
      selection: [newNodes[newNodes.length - 1].id],
      selectionMode: "only",
      pendingConnectionMode: "default",
    });
    new Notice(
      newNodes.length === 1
        ? "Added 1 media file as a Media node."
        : `Added ${newNodes.length} media files as Media nodes.`,
    );
    return true;
  }

  private async syncGraphClipboardToSystemClipboard(
    payload: StudioGraphClipboardPayload,
  ): Promise<void> {
    try {
      const ownerHost =
        this.viewportEl ??
        this.listenerWindow?.document.body ??
        this.listenerWindow?.document.documentElement;
      if (ownerHost) {
        await this.dependencies.copyText(JSON.stringify(payload), ownerHost);
      } else {
        await this.dependencies.copyText(JSON.stringify(payload));
      }
    } catch {
      // Clipboard mirroring is best effort; the in-memory payload remains usable.
    }
  }

  private captureProjectScope(): ProjectOperationScope | null {
    if (this.disposed) return null;
    const project = this.host.getCurrentProject();
    const projectPath = this.host.getProjectPath();
    if (!project || !projectPath) return null;
    return { project, projectPath, lifecycleEpoch: this.lifecycleEpoch };
  }

  private isScopeCurrent(scope: ProjectOperationScope): boolean {
    return !this.disposed &&
      scope.lifecycleEpoch === this.lifecycleEpoch &&
      this.host.getCurrentProject() === scope.project &&
      this.host.getProjectPath() === scope.projectPath;
  }

  private findNodeDefinition(kind: string): StudioNodeDefinition | null {
    return this.host.getNodeDefinitions().find((definition) => definition.kind === kind) || null;
  }

  private consumeEvent(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private capturePointerPosition(event: PointerEvent): void {
    const point = this.resolveGraphPositionFromClientPoint(event.clientX, event.clientY);
    if (point) this.lastGraphPointerPosition = point;
  }

  private resolvePasteAnchorPosition(): StudioGraphPoint {
    const pointer = this.lastGraphPointerPosition;
    if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      return { ...pointer };
    }
    const viewport = this.viewportEl;
    if (viewport) {
      const zoom = this.host.getGraphZoom() || 1;
      return {
        x: (viewport.scrollLeft + viewport.clientWidth * 0.5) / zoom,
        y: (viewport.scrollTop + viewport.clientHeight * 0.5) / zoom,
      };
    }
    const project = this.host.getCurrentProject();
    return project ? this.host.getDefaultNodePosition(project) : { x: 120, y: 120 };
  }

  private resolveGraphPositionFromClientPoint(
    clientX: number,
    clientY: number,
  ): StudioGraphPoint | null {
    const viewport = this.viewportEl;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;
    const zoom = this.host.getGraphZoom() || 1;
    return {
      x: (viewport.scrollLeft + localX) / zoom,
      y: (viewport.scrollTop + localY) / zoom,
    };
  }

  private resolveMarkdownVaultPathFromReference(reference: string): string | null {
    const item = resolveVaultItemFromReference({
      reference,
      getAbstractFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
      resolveVaultPathFromAbsoluteFilePath: (absolutePath) =>
        this.resolveVaultPathFromAbsoluteFilePath(absolutePath),
    });
    return item instanceof TFile && item.extension.toLowerCase() === "md" ? item.path : null;
  }

  private resolveVaultPathFromAbsoluteFilePath(absolutePath: string): string | null {
    const normalizedAbsolute = normalizePath(String(absolutePath || "").trim().replace(/\\/g, "/"));
    if (!normalizedAbsolute) return null;
    const adapter = this.app.vault.adapter as { basePath?: unknown };
    const basePathRaw = typeof adapter?.basePath === "string"
      ? adapter.basePath.trim().replace(/\\/g, "/")
      : "";
    if (!basePathRaw) return null;
    const basePath = normalizePath(basePathRaw);
    if (!normalizedAbsolute.startsWith(`${basePath}/`)) return null;
    const relative = normalizedAbsolute.slice(basePath.length + 1);
    return relative ? normalizePath(relative) : null;
  }
}
