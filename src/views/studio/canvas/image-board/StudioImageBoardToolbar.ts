import { updateUiAction } from "../../../../core/ui/surface";
import {
  STUDIO_IMAGE_BOARD_ZOOM_STEPS,
  studioImageBoardLensZoom,
  type StudioImageBoardLayer,
  type StudioImageBoardLensShape,
  type StudioImageBoardRedactStyle,
  type StudioImageBoardTextAlign,
  type StudioImageBoardTextStyle,
} from "../../../../studio/StudioImageBoard";
import { createStudioAction } from "../../StudioAction";
import { markStudioNodeCardInteractive } from "../StudioGraphNodeCardPointer";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";
import type { StudioImageBoardReorder, StudioImageBoardTool } from "./StudioImageBoardSession";

export type StudioImageBoardToolbarState = {
  tool: StudioImageBoardTool;
  selected: StudioImageBoardLayer | null;
  hasCrop: boolean;
  hasBase: boolean;
  /** False until the node image has loaded; drawing tools wait for it. */
  ready: boolean;
  busy: "copy" | "done" | null;
};

export type StudioImageBoardToolbarActions = {
  setTool: (tool: StudioImageBoardTool) => void;
  addImage: () => void;
  copy: () => void;
  done: () => void;
  patchSelected: (patch: Record<string, unknown>, options?: StudioGraphNodeMutationOptions) => void;
  setWeight: (strokeWidth: number) => void;
  setZoom: (zoom: number) => void;
  reorder: (direction: StudioImageBoardReorder) => void;
  duplicate: () => void;
  remove: () => void;
  resetCrop: () => void;
  restoreBase: () => void;
};

type Updater = (state: StudioImageBoardToolbarState) => void;

const TOOLS: Array<{ tool: StudioImageBoardTool; icon: string; label: string; key: string }> = [
  { tool: "select", icon: "mouse-pointer-2", label: "Select and move", key: "V" },
  { tool: "text", icon: "type", label: "Text", key: "T" },
  { tool: "rect", icon: "square", label: "Box", key: "R" },
  { tool: "ellipse", icon: "circle", label: "Circle", key: "O" },
  { tool: "arrow", icon: "move-up-right", label: "Arrow", key: "A" },
  { tool: "highlight", icon: "highlighter", label: "Highlight", key: "H" },
  { tool: "redact", icon: "eye-off", label: "Blur out", key: "B" },
  { tool: "magnify", icon: "zoom-in", label: "Magnify", key: "M" },
  { tool: "crop", icon: "crop", label: "Crop", key: "C" },
];

/** The single-key shortcut of each tool, lower case, exactly as its button names it. */
export const STUDIO_IMAGE_BOARD_TOOL_KEYS: Readonly<Record<string, StudioImageBoardTool>> = Object.fromEntries(
  TOOLS.map(({ tool, key }) => [key.toLowerCase(), tool])
);

const TOOL_HINTS: Partial<Record<StudioImageBoardTool, string>> = {
  text: "Click where the caption goes, or drag a box for it.",
  rect: "Drag a box around it.",
  ellipse: "Drag a circle around it.",
  arrow: "Drag from the tail to the point.",
  highlight: "Drag across what to highlight.",
  redact: "Drag over what to hide. Those pixels are thrown away, not blurred, so they cannot be recovered.",
  magnify: "Drag over what to enlarge. It pops out beside the spot, joined to it by a beam, and moves anywhere.",
  crop: "Drag the frame or its handles. Pull past the image to add transparent space.",
};

export const STUDIO_IMAGE_BOARD_SWATCHES: Array<{ id: string; label: string; color: string }> = [
  { id: "red", label: "Red", color: "#ff3b30" },
  { id: "orange", label: "Orange", color: "#ff9500" },
  { id: "yellow", label: "Yellow", color: "#ffe600" },
  { id: "green", label: "Green", color: "#34c759" },
  { id: "blue", label: "Blue", color: "#0a84ff" },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "black", label: "Black", color: "#000000" },
];

const TEXT_STYLES: Array<{ style: StudioImageBoardTextStyle; label: string }> = [
  { style: "meme", label: "Meme" },
  { style: "outline", label: "Outline" },
  { style: "shadow", label: "Shadow" },
  { style: "banner", label: "Banner" },
];

const TEXT_ALIGNS: Array<{ align: StudioImageBoardTextAlign; icon: string; label: string }> = [
  { align: "left", icon: "align-left", label: "Align left" },
  { align: "center", icon: "align-center", label: "Align center" },
  { align: "right", icon: "align-right", label: "Align right" },
];

const REDACT_STYLES: Array<{ style: StudioImageBoardRedactStyle; label: string }> = [
  { style: "blur", label: "Blur" },
  { style: "pixelate", label: "Pixelate" },
  { style: "solid", label: "Blackout" },
];

const LENS_ZOOMS = STUDIO_IMAGE_BOARD_ZOOM_STEPS.map((zoom) => ({
  id: `${zoom}x`.replace(".", "-"),
  label: `${zoom}×`,
  zoom,
}));

const LENS_SHAPES: Array<{ shape: StudioImageBoardLensShape; icon: string; label: string }> = [
  { shape: "rect", icon: "square", label: "Box lens" },
  { shape: "ellipse", icon: "circle", label: "Round lens" },
];

const WEIGHTS: Array<{ id: string; label: string; strokeWidth: number }> = [
  { id: "thin", label: "Thin", strokeWidth: 0.004 },
  { id: "medium", label: "Medium", strokeWidth: 0.008 },
  { id: "bold", label: "Bold", strokeWidth: 0.016 },
];

/**
 * The editor's controls. The top row is always the same tools; the second row
 * shows only what applies to the current tool or selected layer.
 */
export class StudioImageBoardToolbar {
  readonly element: HTMLElement;
  private readonly contextEl: HTMLElement;
  private readonly toolUpdaters: Updater[] = [];
  private contextUpdaters: Updater[] = [];
  private contextKey = "";

  constructor(parent: HTMLElement, private readonly actions: StudioImageBoardToolbarActions) {
    this.element = parent.createDiv({
      cls: "ss-studio-image-board-toolbar",
      attr: { role: "toolbar", "aria-label": "Image editor" },
    });
    markStudioNodeCardInteractive(this.element);
    // Pressing a control must not take focus from text being typed on the image.
    this.element.addEventListener("mousedown", (event) => {
      if (!(event.target as HTMLElement | null)?.closest("input")) {
        event.preventDefault();
      }
    });
    this.element.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.element.addEventListener("click", (event) => event.stopPropagation());

    const toolsEl = this.element.createDiv({ cls: "ss-studio-image-board-toolbar__row is-tools" });
    for (const { tool, icon, label, key } of TOOLS) {
      const button = createStudioAction(toolsEl, {
        className: "ss-studio-image-board-toolbar__tool",
        label: `${label} (${key})`,
        testId: `studio.image.tool.${tool}`,
        icon,
        size: "icon",
        onSelect: () => this.actions.setTool(tool),
      });
      this.toolUpdaters.push((state) => {
        updateUiAction(button, {
          selected: state.tool === tool,
          disabled: !state.ready || state.busy !== null,
        });
      });
    }
    toolsEl.createDiv({ cls: "ss-studio-image-board-toolbar__divider" });
    const addImage = createStudioAction(toolsEl, {
      className: "ss-studio-image-board-toolbar__tool",
      label: "Add image (or paste / drop one)",
      testId: "studio.image.add-image",
      icon: "image-plus",
      size: "icon",
      onSelect: () => this.actions.addImage(),
    });
    toolsEl.createDiv({ cls: "ss-studio-image-board-toolbar__divider" });
    const copy = createStudioAction(toolsEl, {
      className: "ss-studio-image-board-toolbar__tool",
      label: "Copy image to clipboard",
      testId: "studio.image.copy",
      icon: "copy",
      size: "icon",
      onSelect: () => this.actions.copy(),
    });
    const done = createStudioAction(toolsEl, {
      className: "ss-studio-image-board-toolbar__done",
      label: "Done",
      testId: "studio.image.done",
      tone: "primary",
      size: "small",
      onSelect: () => this.actions.done(),
    });
    this.toolUpdaters.push((state) => {
      updateUiAction(addImage, { disabled: !state.ready || state.busy !== null });
      updateUiAction(copy, { disabled: !state.ready || state.busy !== null, busy: state.busy === "copy" });
      updateUiAction(done, {
        disabled: state.busy !== null,
        busy: state.busy === "done",
        label: state.busy === "done" ? "Saving…" : "Done",
      });
    });

    this.contextEl = this.element.createDiv({ cls: "ss-studio-image-board-toolbar__row is-context" });
  }

  render(state: StudioImageBoardToolbarState): void {
    for (const update of this.toolUpdaters) {
      update(state);
    }
    const key = contextKeyFor(state);
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.contextEl.empty();
      this.contextUpdaters = [];
      this.buildContext(state);
      this.contextEl.toggleClass("is-empty", this.contextEl.childElementCount === 0);
    }
    for (const update of this.contextUpdaters) {
      update(state);
    }
  }

  dispose(): void {
    this.element.remove();
  }

  private buildContext(state: StudioImageBoardToolbarState): void {
    const hint = TOOL_HINTS[state.tool];
    if (hint) {
      this.contextEl.createDiv({ cls: "ss-studio-image-board-toolbar__hint", text: hint });
      if (state.tool === "crop") {
        if (state.hasCrop) {
          this.textButton("studio.image.crop.reset", "Reset crop", () => this.actions.resetCrop());
        }
        this.textButton("studio.image.crop.apply", "Apply", () => this.actions.setTool("select"));
      }
      return;
    }
    const layer = state.selected;
    if (!layer) {
      if (!state.hasBase) {
        this.textButton("studio.image.restore-background", "Restore background image", () =>
          this.actions.restoreBase()
        );
      }
      return;
    }

    switch (layer.kind) {
      case "text":
        this.choiceGroup(
          TEXT_STYLES.map(({ style, label }) => ({
            testId: `studio.image.text-style.${style}`,
            label,
            isSelected: (selected) => selected.kind === "text" && selected.style === style,
            onSelect: () => this.actions.patchSelected({ style }),
          }))
        );
        this.choiceGroup(
          TEXT_ALIGNS.map(({ align, icon, label }) => ({
            testId: `studio.image.text-align.${align}`,
            label,
            icon,
            isSelected: (selected) => selected.kind === "text" && selected.align === align,
            onSelect: () => this.actions.patchSelected({ align }),
          }))
        );
        this.swatches();
        break;
      case "shape":
        this.swatches();
        this.choiceGroup(
          WEIGHTS.map(({ id, label, strokeWidth }) => ({
            testId: `studio.image.weight.${id}`,
            label,
            isSelected: (selected) =>
              selected.kind === "shape" && Math.abs(selected.strokeWidth - strokeWidth) < 1e-6,
            onSelect: () => this.actions.setWeight(strokeWidth),
          }))
        );
        break;
      case "highlight":
        this.swatches();
        break;
      case "redact":
        this.choiceGroup(
          REDACT_STYLES.map(({ style, label }) => ({
            testId: `studio.image.redact-style.${style}`,
            label,
            isSelected: (selected) => selected.kind === "redact" && selected.style === style,
            onSelect: () => this.actions.patchSelected({ style }),
          }))
        );
        break;
      case "magnify":
        this.choiceGroup(
          LENS_ZOOMS.map(({ id, label, zoom }) => ({
            testId: `studio.image.lens-zoom.${id}`,
            label,
            isSelected: (selected) =>
              selected.kind === "magnify" && Math.abs(studioImageBoardLensZoom(selected) - zoom) < 0.005,
            onSelect: () => this.actions.setZoom(zoom),
          }))
        );
        this.choiceGroup(
          LENS_SHAPES.map(({ shape, icon, label }) => ({
            testId: `studio.image.lens-shape.${shape}`,
            label,
            icon,
            isSelected: (selected) => selected.kind === "magnify" && selected.shape === shape,
            onSelect: () => this.actions.patchSelected({ shape }),
          }))
        );
        this.swatches();
        break;
      case "base":
        this.contextEl.createDiv({
          cls: "ss-studio-image-board-toolbar__hint",
          text: "Background image. Delete it for a transparent background.",
        });
        break;
      case "image":
        break;
    }

    const layerActions = this.contextEl.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
    this.iconButton(layerActions, "studio.image.layer.forward", "Bring forward (])", "bring-to-front", () =>
      this.actions.reorder("forward")
    );
    this.iconButton(layerActions, "studio.image.layer.backward", "Send backward ([)", "send-to-back", () =>
      this.actions.reorder("backward")
    );
    if (layer.kind !== "base") {
      this.iconButton(layerActions, "studio.image.layer.duplicate", "Duplicate", "copy-plus", () =>
        this.actions.duplicate()
      );
    }
    this.iconButton(layerActions, "studio.image.layer.delete", "Delete (Del)", "trash-2", () =>
      this.actions.remove()
    );
  }

  private textButton(testId: string, label: string, onSelect: () => void): HTMLButtonElement {
    return createStudioAction(this.contextEl, {
      className: "ss-studio-image-board-toolbar__choice",
      label,
      testId,
      size: "small",
      onSelect,
    });
  }

  private iconButton(
    parent: HTMLElement,
    testId: string,
    label: string,
    icon: string,
    onSelect: () => void
  ): HTMLButtonElement {
    return createStudioAction(parent, {
      className: "ss-studio-image-board-toolbar__tool",
      label,
      testId,
      icon,
      size: "icon",
      onSelect,
    });
  }

  private choiceGroup(
    choices: Array<{
      testId: string;
      label: string;
      icon?: string;
      isSelected: (layer: StudioImageBoardLayer) => boolean;
      onSelect: () => void;
    }>
  ): void {
    const group = this.contextEl.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
    for (const choice of choices) {
      const button = createStudioAction(group, {
        className: choice.icon
          ? "ss-studio-image-board-toolbar__tool"
          : "ss-studio-image-board-toolbar__choice",
        label: choice.label,
        testId: choice.testId,
        icon: choice.icon,
        size: choice.icon ? "icon" : "small",
        onSelect: choice.onSelect,
      });
      this.contextUpdaters.push((state) => {
        updateUiAction(button, { selected: state.selected ? choice.isSelected(state.selected) : false });
      });
    }
  }

  private swatches(): void {
    const group = this.contextEl.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
    const currentColor = (state: StudioImageBoardToolbarState): string =>
      state.selected && "color" in state.selected ? state.selected.color : "";
    for (const { id, label, color } of STUDIO_IMAGE_BOARD_SWATCHES) {
      const button = createStudioAction(group, {
        className: "ss-studio-image-board-toolbar__swatch",
        label,
        testId: `studio.image.color.${id}`,
        size: "icon",
        onSelect: () => this.actions.patchSelected({ color }),
      });
      button.setCssProps({ "--ss-studio-swatch-color": color });
      this.contextUpdaters.push((state) => {
        updateUiAction(button, { selected: currentColor(state) === color });
      });
    }
    const custom = group.createEl("input", {
      cls: "ss-studio-image-board-toolbar__color",
      type: "color",
      attr: { "data-testid": "studio.image.color.custom", "aria-label": "Custom color" },
    });
    // A drag through the picker is one step to undo, not one for every shade it passes.
    let picking = false;
    custom.addEventListener("input", () => {
      this.actions.patchSelected({ color: custom.value }, { mode: "continuous", captureHistory: !picking });
      picking = true;
    });
    custom.addEventListener("change", () => {
      picking = false;
    });
    this.contextUpdaters.push((state) => {
      const color = currentColor(state);
      // Leave the native picker alone while it is open and driving the value.
      if (color && custom.ownerDocument.activeElement !== custom) {
        custom.value = color;
      }
    });
  }
}

/** The context row is rebuilt only when what it offers changes, never per keystroke or drag. */
function contextKeyFor(state: StudioImageBoardToolbarState): string {
  if (TOOL_HINTS[state.tool]) {
    return `tool:${state.tool}:${state.hasCrop}`;
  }
  const layer = state.selected;
  if (!layer) {
    return `none:${state.hasBase}`;
  }
  return `layer:${layer.id}:${layer.kind}`;
}
