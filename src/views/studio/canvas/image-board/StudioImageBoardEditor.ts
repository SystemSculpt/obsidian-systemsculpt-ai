import { Notice, type App } from "obsidian";
import {
  resolveStudioImageBoardRenderedAsset,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
  serializeStudioImageBoard,
  studioImageBoardArrowThicknessPx,
  studioImageBoardHasBase,
  studioImageBoardHasEdits,
  studioImageBoardKeepLensInside,
  studioImageBoardLensAtZoom,
  studioImageBoardOutputFrame,
} from "../../../../studio/StudioImageBoard";
import type { StudioImageBoardPoint } from "../../../../studio/StudioImageBoardGeometry";
import {
  decodeStudioImageBoardImage,
  renderStudioImageBoardScene,
  type StudioImageBoardDecodedImage,
  type StudioImageBoardScene,
} from "../../../../studio/StudioImageBoardRenderer";
import type { StudioAssetRef, StudioJsonValue, StudioNodeInstance } from "../../../../studio/types";
import { tryCopyImageBytesToClipboard } from "../../../../utils/clipboard";
import { isStudioGraphEditableTarget } from "../../StudioGraphDomTargeting";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import {
  extractClipboardMediaFiles,
  extractClipboardText,
} from "../../systemsculpt-studio-view/StudioClipboardData";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";
import {
  resolveStudioImageBoardBaseAsset,
  StudioImageBoardImageCache,
  type StudioImageBoardAssetIo,
} from "./StudioImageBoardImages";
import { StudioImageBoardSession } from "./StudioImageBoardSession";
import { StudioImageBoardStage } from "./StudioImageBoardStage";
import { STUDIO_IMAGE_BOARD_TOOL_KEYS, StudioImageBoardToolbar } from "./StudioImageBoardToolbar";

export type StudioImageBoardEditorOptions = StudioImageBoardAssetIo & {
  app: App;
  /** The card's media area; the stage takes the place of the image. */
  contentEl: HTMLElement;
  /** Where the toolbar mounts. */
  toolbarHost: HTMLElement;
  /** True when the toolbar floats over the Studio workspace instead of sitting in the card. */
  toolbarDocked: boolean;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  getGraphZoom: () => number;
  onNodeConfigValueChange: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  /** Asks the host to leave edit mode for this node. */
  onClose: (nodeId: string) => void;
};

export type StudioImageBoardEditorHandle = {
  /** Adopts the node after a change made elsewhere, such as undo. */
  syncNode: (node: StudioNodeInstance) => void;
  /** True when the key belonged to the editor. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
  /** True when the paste belonged to the editor. */
  handlePaste: (event: ClipboardEvent) => boolean;
  /** Saves the flattened image and asks the host to close. */
  finish: () => Promise<void>;
  dispose: () => void;
};

const NEW_IMAGE_SHARE = 0.6;
const NEW_IMAGE_MIN_SHARE = 0.3;
const PASTED_TEXT_LIMIT = 400;
const NUDGE = 0.005;
const NUDGE_LARGE = 0.03;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Edits one image node where it sits on the Studio canvas. It composes the
 * session (state), the stage (pixels and gestures), and the toolbar, and owns
 * what crosses the edge of the board: loading images, adding pictures,
 * copying the result, and saving the flattened image on the way out.
 */
class StudioImageBoardEditor implements StudioImageBoardEditorHandle {
  private readonly session: StudioImageBoardSession;
  private readonly stage: StudioImageBoardStage;
  private readonly toolbar: StudioImageBoardToolbar;
  private readonly images: StudioImageBoardImageCache;
  private readonly fileInput: HTMLInputElement;
  private baseAsset: StudioAssetRef | null = null;
  private base: StudioImageBoardDecodedImage | null = null;
  private statusMessage = "Opening image…";
  private busy: "copy" | "done" | null = null;
  private finishing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: StudioImageBoardEditorOptions) {
    this.images = new StudioImageBoardImageCache(options.readAsset);
    this.session = new StudioImageBoardSession(
      options.node.config,
      (key, value, mutation) => options.onNodeConfigValueChange(options.node.id, key, value, mutation),
      () => this.render()
    );
    this.stage = new StudioImageBoardStage(options.contentEl, {
      session: this.session,
      scene: () => this.scene(),
      status: () => this.statusMessage,
      getGraphZoom: options.getGraphZoom,
      onDropFiles: (files, at) => void this.addImages(files, at),
    });
    this.toolbar = new StudioImageBoardToolbar(options.toolbarHost, {
      setTool: (tool) => {
        this.stage.endTextEdit();
        this.session.setTool(tool);
      },
      addImage: () => this.fileInput.click(),
      copy: () => void this.copy(),
      done: () => void this.finish(),
      patchSelected: (patch, options) => {
        const id = this.session.selectedId;
        if (id) this.session.patchLayer(id, patch, options);
      },
      setWeight: (strokeWidth) => this.setWeight(strokeWidth),
      setZoom: (zoom) => this.setZoom(zoom),
      reorder: (direction) => {
        const id = this.session.selectedId;
        if (id) this.session.reorderLayer(id, direction);
      },
      duplicate: () => {
        const id = this.session.selectedId;
        if (id) this.session.duplicateLayer(id);
      },
      remove: () => this.removeSelected(),
      resetCrop: () => this.session.setCrop(null),
      restoreBase: () => this.session.restoreBase(),
    });
    this.toolbar.element.toggleClass("is-docked", options.toolbarDocked);
    this.fileInput = this.toolbar.element.createEl("input", {
      cls: "ss-studio-image-board-toolbar__file",
      type: "file",
      attr: {
        "data-testid": "studio.image.file-input",
        accept: "image/*",
        multiple: "true",
        "aria-label": "Choose images to add",
        tabindex: "-1",
      },
    });
    this.fileInput.addEventListener("change", () => {
      const files = Array.from(this.fileInput.files ?? []);
      this.fileInput.value = "";
      void this.addImages(files);
    });
    this.render();
    void this.loadBase();
  }

  syncNode(node: StudioNodeInstance): void {
    if (!this.disposed) {
      this.session.sync(node.config, this.stage.typingLayerId);
    }
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.disposed || isStudioGraphEditableTarget(event.target)) {
      return false;
    }
    const key = String(event.key || "");
    const lower = key.toLowerCase();
    const consume = (): boolean => {
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (lower === "c" && !event.shiftKey) {
        void this.copy();
        return consume();
      }
      if (lower === "d") {
        const id = this.session.selectedId;
        if (id) this.session.duplicateLayer(id);
        return consume();
      }
      // Select-all and cut would act on Studio nodes behind the editor.
      if (lower === "a" || lower === "x") {
        return consume();
      }
      // Undo, redo, and zoom stay with Studio; board edits are ordinary history.
      return false;
    }
    if (event.altKey) {
      return false;
    }
    const selected = this.session.selectedLayer;
    switch (key) {
      case "Escape":
        if (this.session.tool !== "select") this.session.setTool("select");
        else if (selected) this.session.select(null);
        else void this.finish();
        return consume();
      case "Enter":
        if (this.session.tool === "crop") this.session.setTool("select");
        else if (selected?.kind === "text") this.stage.beginTextEdit(selected.id);
        return consume();
      case "Delete":
      case "Backspace":
        // Always spent here: it must never delete the node being edited.
        this.removeSelected();
        return consume();
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const step = event.shiftKey ? NUDGE_LARGE : NUDGE;
        const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        this.stage.nudgeSelection(dx, dy);
        return consume();
      }
      case "[":
      case "]":
        if (selected) this.session.reorderLayer(selected.id, key === "]" ? "forward" : "backward");
        return consume();
    }
    if (key.length === 1) {
      const tool = this.base && !event.shiftKey ? STUDIO_IMAGE_BOARD_TOOL_KEYS[lower] : undefined;
      if (tool) this.session.setTool(tool);
      // Plain keys never fall through to the canvas shortcuts underneath.
      return consume();
    }
    return false;
  }

  handlePaste(event: ClipboardEvent): boolean {
    if (this.disposed || isStudioGraphEditableTarget(event.target)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!this.base) {
      return true;
    }
    const files = extractClipboardMediaFiles(event).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      void this.addImages(files);
      return true;
    }
    const text = extractClipboardText(event).trim();
    if (text && text.length <= PASTED_TEXT_LIMIT) {
      const frame = studioImageBoardOutputFrame(this.session.board);
      this.session.addLayer({
        kind: "text",
        text,
        x: frame.x + frame.width * 0.05,
        y: frame.y + frame.height * 0.42,
        width: frame.width * 0.9,
        height: frame.height * 0.16,
      });
    }
    return true;
  }

  finish(): Promise<void> {
    if (!this.finishing) {
      this.finishing = this.saveAndClose().finally(() => {
        // Still mounted only if the host declined to close.
        this.finishing = null;
        this.busy = null;
        this.render();
      });
    }
    return this.finishing;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stage.dispose();
    this.toolbar.dispose();
    this.images.dispose();
    this.base?.close();
    this.base = null;
  }

  private scene(): StudioImageBoardScene | null {
    if (!this.base) {
      return null;
    }
    return {
      board: this.session.board,
      baseSize: { width: this.base.width, height: this.base.height },
      base: this.base,
      images: this.images.images,
    };
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    for (const layer of this.session.board.layers) {
      if (layer.kind === "image" && !this.images.get(layer.asset)) {
        // Repaint when a stacked image arrives; a missing one simply stays blank.
        void this.images.load(layer.asset).then(() => this.stage.render(), () => undefined);
      }
    }
    this.stage.render();
    this.toolbar.render({
      tool: this.session.tool,
      selected: this.session.selectedLayer,
      hasCrop: this.session.board.crop !== null,
      hasBase: studioImageBoardHasBase(this.session.board),
      ready: this.base !== null,
      busy: this.busy,
    });
  }

  private async loadBase(): Promise<void> {
    try {
      const asset = await resolveStudioImageBoardBaseAsset(this.options);
      const decoded = await decodeStudioImageBoardImage(await this.options.readAsset(asset), asset.mimeType);
      if (this.disposed) {
        decoded.close();
        return;
      }
      this.baseAsset = asset;
      this.base = decoded;
      this.statusMessage = "";
    } catch (error) {
      this.statusMessage = `This image could not be opened. ${messageOf(error)}`;
    }
    this.render();
  }

  private removeSelected(): void {
    const id = this.session.selectedId;
    if (id) {
      this.stage.endTextEdit();
      this.session.removeLayer(id);
    }
  }

  private setZoom(zoom: number): void {
    const layer = this.session.selectedLayer;
    if (!layer || layer.kind !== "magnify" || !this.base) {
      return;
    }
    // Zooming in grows the lens away from its area; it stays on the picture.
    const lens = studioImageBoardKeepLensInside(
      layer,
      { ...studioImageBoardLensAtZoom(layer, zoom), rotation: layer.rotation },
      studioImageBoardOutputFrame(this.session.board),
      { width: this.base.width, height: this.base.height }
    );
    this.session.patchLayer(layer.id, lens);
  }

  private setWeight(strokeWidth: number): void {
    const layer = this.session.selectedLayer;
    if (!layer || layer.kind !== "shape" || !this.base) {
      return;
    }
    if (layer.shape !== "arrow") {
      this.session.patchLayer(layer.id, { strokeWidth });
      return;
    }
    // An arrow's box is the arrow, so its weight is the box height.
    const height = studioImageBoardArrowThicknessPx(strokeWidth, this.base) / this.base.height;
    this.session.patchLayer(layer.id, {
      strokeWidth,
      height,
      y: layer.y + (layer.height - height) / 2,
    });
  }

  private async addImages(files: File[], at?: StudioImageBoardPoint): Promise<void> {
    const base = this.base;
    if (!base || this.disposed) {
      return;
    }
    let placed = 0;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        continue;
      }
      try {
        const asset = await this.options.storeAsset(await file.arrayBuffer(), file.type);
        const image = await this.images.load(asset);
        if (this.disposed) {
          return;
        }
        const frame = studioImageBoardOutputFrame(this.session.board);
        // Its own size when that reads well; otherwise large enough to grab
        // and small enough to leave the picture beneath it in view.
        const fit = Math.min(
          (frame.width * base.width) / image.width,
          (frame.height * base.height) / image.height
        );
        const scale = Math.min(fit * NEW_IMAGE_SHARE, Math.max(fit * NEW_IMAGE_MIN_SHARE, 1));
        const width = (image.width * scale) / base.width;
        const height = (image.height * scale) / base.height;
        const offset = placed * 0.03;
        const center = at ?? {
          x: frame.x + frame.width / 2,
          y: frame.y + frame.height / 2,
        };
        this.session.addLayer({
          kind: "image",
          asset,
          x: center.x - width / 2 + offset * frame.width,
          y: center.y - height / 2 + offset * frame.height,
          width,
          height,
        });
        placed += 1;
      } catch (error) {
        new Notice(`That image could not be added. ${messageOf(error)}`);
      }
    }
  }

  /** Every stacked image decoded, or a refusal: a picture must never silently drop out. */
  private async completeScene(): Promise<StudioImageBoardScene> {
    const scene = this.scene();
    if (!scene) {
      throw new Error("The image has not finished loading.");
    }
    await this.images.loadAll(scene.board);
    return { ...scene, images: this.images.images };
  }

  private async copy(): Promise<void> {
    if (this.busy || this.disposed) {
      return;
    }
    this.stage.endTextEdit();
    this.busy = "copy";
    this.render();
    try {
      const rendered = await renderStudioImageBoardScene(await this.completeScene());
      if (!await tryCopyImageBytesToClipboard(rendered.bytes, rendered.mimeType, this.stage.element)) {
        new Notice("The image could not be copied to the clipboard.");
      }
    } catch (error) {
      new Notice(`The image could not be copied. ${messageOf(error)}`);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  /**
   * An editor taken down while it flattens saves nothing more: by then the
   * node of that name may belong to another project, or to a later edit.
   */
  private async saveAndClose(): Promise<void> {
    this.stage.endTextEdit();
    this.busy = "done";
    this.render();
    try {
      const board = this.session.board;
      const baseAsset = this.baseAsset;
      const cached = resolveStudioImageBoardRenderedAsset(
        { [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board) },
        baseAsset?.path ?? ""
      );
      if (baseAsset && !cached && studioImageBoardHasEdits(board)) {
        const scene = await this.completeScene();
        const rendered = await renderStudioImageBoardScene(scene);
        const asset = await this.options.storeAsset(rendered.bytes, rendered.mimeType);
        if (this.disposed) {
          return;
        }
        this.session.recordRender(scene.board, baseAsset.path, asset);
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      // The edits themselves are already saved; only the flattened copy is missing.
      new Notice(`Your edits are saved, but the finished image could not be produced. ${messageOf(error)}`);
    }
    this.options.onClose(this.options.node.id);
  }
}

export function mountStudioImageBoardEditor(
  options: StudioImageBoardEditorOptions
): StudioImageBoardEditorHandle {
  return new StudioImageBoardEditor(options);
}
