import { Notice, TFile, type App } from "obsidian";
import type { StudioAssetRef, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import type { StudioService } from "../../../studio/StudioService";
import type { StudioRunPresentationState } from "../StudioRunPresentationState";
import type { StudioProjectSessionController } from "./StudioProjectSessionController";
import type { StudioGraphNodeImageBoardOptions } from "../canvas/StudioGraphNodeCardTypes";
import type { StudioImageBoardEditorHandle } from "../canvas/image-board/StudioImageBoardEditor";
import { composeStudioImageBoardAsset } from "../../../studio/StudioImageBoardRenderer";
import { resolveStudioImageBoardBaseAsset } from "../canvas/image-board/StudioImageBoardImages";
import {
  normalizeStudioAssetRef,
  readStudioImageBoard,
  resolveStudioImageBoardRenderedAsset,
  studioImageBoardHasEdits,
  studioImageBoardWithRender,
  writeStudioImageBoard,
} from "../../../studio/StudioImageBoard";
import { tryCopyImageBytesToClipboard, tryCopyImageFileToClipboard } from "../../../utils/clipboard";
import { resolveNodeMediaPreview } from "../canvas/StudioGraphMediaPreview";

type StudioImageEditingDependencies = {
  app: App;
  containerEl: HTMLElement;
  getProject: () => StudioProjectV1 | null;
  getProjectPath: () => string | null;
  getStudio: () => Pick<StudioService, "readAsset" | "storeAsset">;
  presentation: Pick<StudioRunPresentationState, "getNodeState">;
  commitMutation: StudioProjectSessionController["commitMutationAsync"];
  selectNodeForEditing: (nodeId: string) => void;
  render: () => void;
};

/** Owns the in-place image editor and the edited picture used by clipboard actions. */
export class StudioImageEditingController {
  private imageEditNodeId: string | null = null;
  private imageEditor: StudioImageBoardEditorHandle | null = null;

  constructor(private readonly dependencies: StudioImageEditingDependencies) {}

  get editingNodeId(): string | null { return this.imageEditNodeId; }

  clearEditingNode(): void { this.imageEditNodeId = null; }

  handlePaste(event: ClipboardEvent): boolean { return this.imageEditor?.handlePaste(event) === true; }

  handleKeyDown(event: KeyboardEvent): boolean { return this.imageEditor?.handleKeyDown(event) === true; }

  private findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
    return project.graph.nodes.find((node) => node.id === nodeId) || null;
  }

  /** The pencil on an image node toggles editing that image right where it sits. */
  toggleImageEditForNode(node: StudioNodeInstance): void {
    if (node.kind !== "studio.media_ingest" || !this.dependencies.getProjectPath()) {
      return;
    }
    if (this.imageEditNodeId === node.id) {
      void this.finishImageEdit();
      return;
    }
    void this.finishImageEdit().then(() => {
      if (!this.dependencies.getProject() || !this.findNode(this.dependencies.getProject()!, node.id)) {
        return;
      }
      this.imageEditNodeId = node.id;
      // Canvas drawing tools would otherwise claim the drags meant for the image.
      this.dependencies.selectNodeForEditing(node.id);
      this.dependencies.render();
    });
  }

  /** Saves the flattened image and returns the card to its normal state. */
  async finishImageEdit(): Promise<void> {
    const nodeId = this.imageEditNodeId;
    if (!nodeId) {
      return;
    }
    if (this.imageEditor) {
      await this.imageEditor.finish();
    }
    // Ends the edit that was finished, not one begun while it was saving.
    this.endImageEdit(nodeId);
  }

  private endImageEdit(nodeId: string | null): void {
    if (!nodeId || this.imageEditNodeId !== nodeId) {
      return;
    }
    this.imageEditNodeId = null;
    this.dependencies.render();
  }

  imageBoardOptions(): StudioGraphNodeImageBoardOptions | undefined {
    const projectPath = this.dependencies.getProjectPath();
    if (!projectPath) {
      return undefined;
    }
    const studio = this.dependencies.getStudio();
    return {
      app: this.dependencies.app,
      readAsset: (asset) => studio.readAsset(asset),
      storeAsset: (bytes, mimeType) => studio.storeAsset(projectPath, bytes, mimeType),
      isEditing: (nodeId) => this.imageEditNodeId === nodeId,
      onEditorMounted: (_nodeId, editor) => {
        this.imageEditor = editor;
      },
      onEditorUnmounted: (_nodeId, editor) => {
        if (this.imageEditor === editor) this.imageEditor = null;
      },
      onClose: (nodeId) => this.endImageEdit(nodeId),
    };
  }

  /**
   * The picture an image node shows, as a project asset: its edits flattened
   * when it has any, otherwise its own image. A node that has not run is
   * staged from its source, as it is for editing. Null when that picture
   * cannot be produced; an edited image is never stood in for by its source.
   */
  async ensureRenderedImageAssetForNode(node: StudioNodeInstance): Promise<StudioAssetRef | null> {
    if (node.kind !== "studio.media_ingest" || !this.dependencies.getProjectPath()) {
      return null;
    }
    const projectPath = this.dependencies.getProjectPath()!;
    const studio = this.dependencies.getStudio();
    const nodeRunState = this.dependencies.presentation.getNodeState(node.id);
    const sourceAsset = await resolveStudioImageBoardBaseAsset({
      app: this.dependencies.app,
      node,
      nodeRunState,
      storeAsset: (bytes, mimeType) => studio.storeAsset(projectPath, bytes, mimeType),
    }).catch(() => null);
    const board = readStudioImageBoard(node.config);
    if (!studioImageBoardHasEdits(board)) {
      const outputs = (nodeRunState.outputs || {}) as Record<string, unknown>;
      return sourceAsset ?? normalizeStudioAssetRef(outputs.preview_asset);
    }
    if (!sourceAsset) {
      return null;
    }
    const existingRenderedAsset = resolveStudioImageBoardRenderedAsset(node.config, sourceAsset.path);
    if (existingRenderedAsset) {
      return existingRenderedAsset;
    }

    const renderedAsset = await composeStudioImageBoardAsset({
      baseImage: sourceAsset,
      board,
      readAsset: (asset) => studio.readAsset(asset),
      storeAsset: (bytes, mimeType) => studio.storeAsset(projectPath, bytes, mimeType),
    });
    const changed = await this.dependencies.commitMutation(
      "media.editor",
      async (project) => {
        const targetNode = this.findNode(project, node.id);
        if (!targetNode || targetNode.kind !== "studio.media_ingest") {
          return false;
        }
        // The node keeps whatever was done to it meanwhile; the picture is recorded as being of `board`.
        writeStudioImageBoard(
          targetNode,
          studioImageBoardWithRender(readStudioImageBoard(targetNode.config), board, sourceAsset.path, renderedAsset)
        );
        return true;
      },
      { captureHistory: false }
    );
    if (changed) {
      this.dependencies.render();
    }
    return renderedAsset;
  }

  async copyImageForNodeToClipboard(node: StudioNodeInstance): Promise<void> {
    const asset = await this.ensureRenderedImageAssetForNode(node).catch(() => null);
    if (!asset) {
      new Notice("Run this image node once before copying the image.");
      return;
    }
    const file = this.dependencies.app.vault.getAbstractFileByPath(asset.path);
    if (!(file instanceof TFile)) {
      new Notice("Unable to copy image to clipboard.");
      return;
    }
    if (!await tryCopyImageFileToClipboard(this.dependencies.app, file, this.dependencies.containerEl)) {
      new Notice("Unable to copy image to clipboard.");
    }
  }

  /**
   * Copying one image card copies the picture as it looks, edits included.
   * Null when the node is not a picture; resolves to null when the picture
   * could not be read or copied, so the node itself is copied instead.
   */
  copyNodePictureToClipboard(nodeId: string): Promise<Blob | null> | null {
    const node = this.dependencies.getProject() ? this.findNode(this.dependencies.getProject()!, nodeId) : null;
    if (!node || node.kind !== "studio.media_ingest") {
      return null;
    }
    const outputs = (this.dependencies.presentation.getNodeState(node.id).outputs || null) as Record<string, unknown> | null;
    if (resolveNodeMediaPreview(node, outputs)?.kind !== "image") {
      return null;
    }
    return (async () => {
      const asset = await this.ensureRenderedImageAssetForNode(node);
      const file = asset ? this.dependencies.app.vault.getAbstractFileByPath(asset.path) : null;
      if (!asset || !(file instanceof TFile)) {
        return null;
      }
      const bytes = await this.dependencies.app.vault.readBinary(file);
      const copied = await tryCopyImageBytesToClipboard(bytes, asset.mimeType, this.dependencies.containerEl);
      return copied ? new Blob([bytes], { type: asset.mimeType }) : null;
    })();
  }

}
