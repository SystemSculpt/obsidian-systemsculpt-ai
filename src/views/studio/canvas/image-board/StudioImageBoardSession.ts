import {
  createStudioImageBoardBaseLayer,
  createStudioImageBoardLayer,
  findStudioImageBoardLayer,
  readStudioImageBoard,
  serializeStudioImageBoard,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
  studioImageBoardDrawingKey,
  studioImageBoardHasBase,
  studioImageBoardWithoutRender,
  studioImageBoardWithRender,
  type StudioImageBoard,
  type StudioImageBoardLayer,
  type StudioImageBoardLayerKind,
} from "../../../../studio/StudioImageBoard";
import type { StudioImageBoardFrame } from "../../../../studio/StudioImageBoardGeometry";
import type { StudioAssetRef, StudioJsonValue } from "../../../../studio/types";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";

export type StudioImageBoardTool =
  | "select"
  | "text"
  | "rect"
  | "ellipse"
  | "arrow"
  | "highlight"
  | "redact"
  | "magnify"
  | "crop";

export type StudioImageBoardReorder = "forward" | "backward";

type LayerPatch = Partial<Omit<StudioImageBoardLayer, "id" | "kind">> & Record<string, unknown>;

const DUPLICATE_OFFSET = 0.03;

/**
 * The edit state of one image node while it is being edited in place: the
 * board, what is selected, and the active tool. Every change is committed to
 * the node config straight away, so Studio history, autosave, and undo see
 * each edit; a drag commits continuously and counts as one history entry.
 */
export class StudioImageBoardSession {
  private current: StudioImageBoard;
  private selected: string | null = null;
  private activeTool: StudioImageBoardTool = "select";
  private drawing: string;

  constructor(
    config: Record<string, StudioJsonValue>,
    private readonly commitConfig: (
      key: string,
      value: StudioJsonValue,
      options?: StudioGraphNodeMutationOptions
    ) => void,
    private readonly onChange: () => void
  ) {
    this.current = withoutEmptyCaptions(readStudioImageBoard(config), null);
    this.drawing = studioImageBoardDrawingKey(this.current);
  }

  get board(): StudioImageBoard {
    return this.current;
  }

  get tool(): StudioImageBoardTool {
    return this.activeTool;
  }

  get selectedId(): string | null {
    return this.selected;
  }

  get selectedLayer(): StudioImageBoardLayer | null {
    return findStudioImageBoardLayer(this.current, this.selected);
  }

  setTool(tool: StudioImageBoardTool): void {
    if (this.activeTool === tool) {
      return;
    }
    this.activeTool = tool;
    if (tool !== "select") {
      this.selected = null;
    }
    this.onChange();
  }

  select(id: string | null): void {
    const next = findStudioImageBoardLayer(this.current, id)?.id ?? null;
    if (next === this.selected) {
      return;
    }
    this.selected = next;
    this.onChange();
  }

  /**
   * Adopts a config changed elsewhere, such as an undo or a synced edit.
   * `typingId` is the caption being typed into, if there is one.
   */
  sync(config: Record<string, StudioJsonValue>, typingId: string | null = null): void {
    const next = withoutEmptyCaptions(readStudioImageBoard(config), typingId);
    const drawing = studioImageBoardDrawingKey(next);
    this.current = next;
    if (drawing === this.drawing) {
      // Only the render cache moved; nothing the editor shows has changed.
      return;
    }
    this.drawing = drawing;
    this.selected = findStudioImageBoardLayer(next, this.selected)?.id ?? null;
    this.onChange();
  }

  addLayer(
    description: { kind: StudioImageBoardLayerKind } & Record<string, unknown>,
    options?: StudioGraphNodeMutationOptions
  ): StudioImageBoardLayer {
    const layer = createStudioImageBoardLayer({ ...description, id: "" });
    this.selected = layer.id;
    this.activeTool = "select";
    this.commit({ ...this.current, layers: [...this.current.layers, layer] }, options);
    return layer;
  }

  patchLayer(id: string, patch: LayerPatch, options?: StudioGraphNodeMutationOptions): void {
    const target = findStudioImageBoardLayer(this.current, id);
    if (!target) {
      return;
    }
    // Re-validating through the factory keeps a bad patch from ever persisting.
    const next = createStudioImageBoardLayer({ ...target, ...patch, id: target.id, kind: target.kind });
    this.commit(
      {
        ...this.current,
        layers: this.current.layers.map((layer) => (layer.id === id ? next : layer)),
      },
      options
    );
  }

  removeLayer(id: string, options?: StudioGraphNodeMutationOptions): void {
    if (!findStudioImageBoardLayer(this.current, id)) {
      return;
    }
    if (this.selected === id) {
      this.selected = null;
    }
    this.commit(
      {
        ...this.current,
        layers: this.current.layers.filter((layer) => layer.id !== id),
      },
      options
    );
  }

  duplicateLayer(id: string): StudioImageBoardLayer | null {
    const source = findStudioImageBoardLayer(this.current, id);
    if (!source || source.kind === "base") {
      return null;
    }
    return this.addLayer({
      ...source,
      x: source.x + DUPLICATE_OFFSET,
      y: source.y + DUPLICATE_OFFSET,
    });
  }

  reorderLayer(id: string, direction: StudioImageBoardReorder): void {
    const index = this.current.layers.findIndex((layer) => layer.id === id);
    const target = index + (direction === "forward" ? 1 : -1);
    if (index < 0 || target < 0 || target >= this.current.layers.length) {
      return;
    }
    const layers = this.current.layers.slice();
    const [moved] = layers.splice(index, 1);
    layers.splice(target, 0, moved);
    this.commit({ ...this.current, layers });
  }

  setCrop(crop: StudioImageBoardFrame | null, options?: StudioGraphNodeMutationOptions): void {
    this.commit({ ...this.current, crop: crop ? { ...crop } : null }, options);
  }

  /** Puts the node image back at the bottom after it was deleted. */
  restoreBase(): void {
    if (studioImageBoardHasBase(this.current)) {
      return;
    }
    this.commit({
      ...this.current,
      layers: [createStudioImageBoardBaseLayer(), ...this.current.layers],
    });
  }

  /**
   * Records `asset` as the flattened picture of `drawn`, the board as it was
   * when the picture was made, without adding history. A board edited since
   * then keeps its edits and does not take the picture as its own.
   */
  recordRender(drawn: StudioImageBoard, sourceAssetPath: string, asset: StudioAssetRef): void {
    this.current = readStudioImageBoard({
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(
        studioImageBoardWithRender(this.current, drawn, sourceAssetPath, asset)
      ),
    });
    this.commitConfig(STUDIO_IMAGE_BOARD_CONFIG_KEY, serializeStudioImageBoard(this.current), {
      mode: "discrete",
      captureHistory: false,
    });
  }

  private commit(
    next: StudioImageBoard,
    options: StudioGraphNodeMutationOptions = { mode: "discrete" }
  ): void {
    // Any edit invalidates the cached render.
    const value = serializeStudioImageBoard(studioImageBoardWithoutRender(next));
    this.current = readStudioImageBoard({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: value });
    this.drawing = studioImageBoardDrawingKey(this.current);
    this.selected = findStudioImageBoardLayer(this.current, this.selected)?.id ?? null;
    this.commitConfig(STUDIO_IMAGE_BOARD_CONFIG_KEY, value, options);
    this.onChange();
  }
}

/**
 * An empty caption is a layer only while it is being typed into. Undoing the
 * first words typed into a new caption brings one back with nobody typing;
 * it draws nothing and cannot be picked up, so it is left out.
 */
function withoutEmptyCaptions(board: StudioImageBoard, typingId: string | null): StudioImageBoard {
  const layers = board.layers.filter(
    (layer) => layer.kind !== "text" || layer.id === typingId || layer.text.trim().length > 0
  );
  return layers.length === board.layers.length ? board : { ...board, layers };
}
