import { Notice } from "obsidian";
import { StandardModal } from "../../../core/ui/modals/standard/StandardModal";
import { boardStateHasRenderableEdits } from "../../../studio/StudioCaptionBoardState";
import { composeStudioCaptionBoardImage } from "../../../studio/StudioCaptionBoardComposition";
import { getStudioOwnerWindow } from "../StudioDomContext";
import {
  loadStudioImageEditorSource,
  renderStudioImageEditorPreview,
  type StudioImageEditorSource,
} from "./studio-image-editor/StudioImageEditorAssets";
import { StudioImageEditorCanvas } from "./studio-image-editor/StudioImageEditorCanvas";
import { StudioImageEditorInspector } from "./studio-image-editor/StudioImageEditorInspector";
import { StudioImageEditorModel } from "./studio-image-editor/StudioImageEditorModel";
import { StudioImageEditorToolbar } from "./studio-image-editor/StudioImageEditorToolbar";
import type { StudioImageEditorModalOptions } from "./studio-image-editor/StudioImageEditorTypes";

const EMPTY_SOURCE: StudioImageEditorSource = {
  asset: null,
  bytes: null,
  path: "",
  src: "",
  width: 0,
  height: 0,
  statusMessage: "",
};

class StudioCaptionBoardModal extends StandardModal {
  private readonly model: StudioImageEditorModel;
  private canvas: StudioImageEditorCanvas | null = null;
  private inspector: StudioImageEditorInspector | null = null;
  private toolbar: StudioImageEditorToolbar | null = null;
  private source = EMPTY_SOURCE;
  private sourceLoading = true;
  private previewRenderVersion = 0;
  private saving = false;
  private disposed = false;

  constructor(private readonly options: StudioImageEditorModalOptions) {
    super(options.app);
    this.setSize("fullwidth");
    this.modalEl.addClass("ss-studio-caption-board-modal-shell");
    this.model = new StudioImageEditorModel(options, (change) => {
      this.renderBoard();
      if (change.previewInvalidated) {
        void this.refreshRenderedPreview();
      }
    });
  }

  onOpen(): void {
    super.onOpen();
    this.disposed = false;
    this.sourceLoading = true;
    this.addTitle(this.options.node.title || "Image Editor");
    this.footerEl.toggleAttribute("hidden", true);
    this.contentEl.addClass("ss-studio-caption-board-modal");

    const root = this.contentEl.createDiv({ cls: "ss-studio-caption-board" });
    const toolbarEl = root.createDiv({ cls: "ss-studio-caption-board__toolbar" });
    const bodyEl = root.createDiv({ cls: "ss-studio-caption-board__body" });
    const viewportEl = bodyEl.createDiv({ cls: "ss-studio-caption-board__viewport" });
    const surfaceEl = viewportEl.createDiv({ cls: "ss-studio-caption-board__surface" });
    const sidebarEl = bodyEl.createDiv({ cls: "ss-studio-caption-board__sidebar" });
    const statusEl = root.createDiv({ cls: "ss-studio-caption-board__status" });
    const ownerWindow = getStudioOwnerWindow(this.contentEl);

    this.canvas = new StudioImageEditorCanvas(
      viewportEl,
      surfaceEl,
      ownerWindow,
      this.options.node.title || "Image editor source",
      {
        onSelect: (selection) => this.model.select(selection),
        onPatchFrame: (selection, patch, mutationOptions) => {
          this.model.patchSelectionFrame(selection, patch, mutationOptions);
        },
        onDeleteSelected: () => this.model.deleteSelected(),
        resolveSelectionFrame: (selection) => this.model.selectionFrame(selection),
      }
    );
    this.inspector = new StudioImageEditorInspector(sidebarEl, {
      addLabel: () => this.model.addLabel(),
      addAnnotation: (kind) => this.model.addAnnotation(kind),
      toggleCropSelection: () => this.model.toggleCropSelection(),
      select: (selection) => this.model.select(selection),
      patchLabel: (patch) => this.model.patchSelectedLabel(patch),
      patchAnnotation: (patch) => this.model.patchSelectedAnnotation(patch),
      patchCrop: (patch) => this.model.patchCrop(patch),
      duplicateSelected: () => this.model.duplicateSelected(),
      deleteSelected: () => this.model.deleteSelected(),
      bumpSelected: (direction) => this.model.bumpSelected(direction),
      clearCrop: () => this.model.clearCrop(),
    });
    this.toolbar = new StudioImageEditorToolbar(toolbarEl, statusEl, {
      addLabel: () => this.model.addLabel(),
      addAnnotation: (kind) => this.model.addAnnotation(kind),
      toggleCropSelection: () => this.model.toggleCropSelection(),
      fit: () => this.canvas?.fitToViewport(),
      done: () => this.handleDone(),
    });

    this.renderBoard();
    void this.hydrateSource(ownerWindow);
  }

  onClose(): void {
    this.disposed = true;
    this.previewRenderVersion += 1;
    this.canvas?.destroy();
    this.canvas = null;
    this.inspector = null;
    this.toolbar = null;
    super.onClose();
  }

  private renderBoard(): void {
    this.canvas?.render(this.model.state, this.model.selection, this.sourceLoading);
    this.inspector?.render(this.model.state, this.model.selection, {
      hasSource: Boolean(this.source.src),
      loading: this.sourceLoading,
      statusMessage: this.source.statusMessage,
    });
    this.toolbar?.render({
      state: this.model.state,
      selection: this.model.selection,
      hasSource: Boolean(this.source.src),
      sourceLoading: this.sourceLoading,
      saving: this.saving,
      statusOverride: this.source.statusMessage,
    });
  }

  private async hydrateSource(ownerWindow: Window): Promise<void> {
    try {
      const source = await loadStudioImageEditorSource(this.options, ownerWindow);
      if (this.disposed) {
        return;
      }
      this.sourceLoading = false;
      this.source = source;
      this.canvas?.setSource({
        path: source.path,
        src: source.src,
        width: source.width,
        height: source.height,
        statusMessage: source.statusMessage,
      });
      this.renderBoard();
      if (source.width > 0 && source.height > 0) {
        this.canvas?.fitToViewport();
        void this.refreshRenderedPreview();
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.sourceLoading = false;
      this.source = {
        ...EMPTY_SOURCE,
        statusMessage: `Unable to open image: ${message}`,
      };
      this.canvas?.setSource({
        path: "",
        src: "",
        width: 0,
        height: 0,
        statusMessage: this.source.statusMessage,
      });
      this.renderBoard();
    }
  }

  private async refreshRenderedPreview(): Promise<void> {
    const renderVersion = ++this.previewRenderVersion;
    try {
      const preview = await renderStudioImageEditorPreview(this.source, this.model.state);
      if (!this.disposed && renderVersion === this.previewRenderVersion) {
        this.canvas?.setRenderedPreview(preview);
      }
    } catch {
      if (!this.disposed && renderVersion === this.previewRenderVersion) {
        this.canvas?.setRenderedPreview("");
      }
    }
  }

  private async handleDone(): Promise<void> {
    if (this.saving) {
      return;
    }
    this.saving = true;
    this.renderBoard();
    try {
      let nextState = { ...this.model.state };
      if (this.source.asset && boardStateHasRenderableEdits(nextState)) {
        const renderedAsset = await composeStudioCaptionBoardImage({
          baseImage: this.source.asset,
          boardState: nextState,
          readAsset: this.options.readAsset,
          storeAsset: this.options.storeAsset,
        });
        nextState = {
          ...nextState,
          sourceAssetPath: this.source.asset.path,
          lastRenderedAsset: renderedAsset,
          updatedAt: new Date().toISOString(),
        };
      }
      this.model.commitSavedState(nextState);
      this.options.onRenderedAssetCommitted?.(this.options.node);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Image editor save failed: ${message}`);
    } finally {
      this.saving = false;
      if (!this.disposed) {
        this.renderBoard();
      }
    }
  }
}

export function openStudioImageEditorModal(options: StudioImageEditorModalOptions): void {
  new StudioCaptionBoardModal(options).open();
}
