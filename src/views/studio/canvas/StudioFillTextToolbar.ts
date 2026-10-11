import { updateUiAction } from "../../../core/ui/surface";
import type { StudioFillTextAlign, StudioFillTextStyle } from "../../../studio/StudioFillText";
import type { StudioFillTextLook } from "../../../studio/StudioFillTextNode";
import { createStudioAction } from "../StudioAction";
import { markStudioNodeCardInteractive } from "./StudioGraphNodeCardPointer";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";
import { STUDIO_IMAGE_BOARD_SWATCHES } from "./image-board/StudioImageBoardToolbar";

const STYLES: Array<{ style: StudioFillTextStyle; label: string }> = [
  { style: "plain", label: "Plain" },
  { style: "meme", label: "Meme" },
  { style: "outline", label: "Outline" },
  { style: "shadow", label: "Shadow" },
  { style: "banner", label: "Banner" },
];

const ALIGNS: Array<{ align: StudioFillTextAlign; icon: string; label: string }> = [
  { align: "left", icon: "align-left", label: "Align left" },
  { align: "center", icon: "align-center", label: "Align center" },
  { align: "right", icon: "align-right", label: "Align right" },
];

const CHOSEN: StudioGraphNodeMutationOptions = { mode: "discrete", captureHistory: true };

export type StudioFillTextToolbar = {
  element: HTMLElement;
  /** Shows `look` as the current choice. */
  sync: (look: StudioFillTextLook) => void;
  dispose: () => void;
};

/**
 * The style bar for text being typed on the canvas: the same choices a
 * caption gets in the image editor, in the same toolbar chrome.
 *
 * Pressing a control leaves the caret where it is. The colour picker is the
 * one control that takes focus; `onFocusLeft` reports when focus then goes
 * somewhere other than back to the text.
 */
export function mountStudioFillTextToolbar(options: {
  host: HTMLElement;
  docked: boolean;
  look: StudioFillTextLook;
  /** `how` says how the change is saved: a drag through the colour picker is one undo step, not one per shade. */
  onChange: (change: Partial<StudioFillTextLook>, how: StudioGraphNodeMutationOptions) => void;
  /** Hands focus back to the text once the colour picker is finished with. */
  returnFocus: () => void;
  onFocusLeft: (next: EventTarget | null) => void;
}): StudioFillTextToolbar {
  const { onChange } = options;
  const updaters: Array<(look: StudioFillTextLook) => void> = [];
  const element = options.host.createDiv({
    cls: "ss-studio-image-board-toolbar",
    attr: { role: "toolbar", "aria-label": "Text style" },
  });
  element.toggleClass("is-docked", options.docked);
  markStudioNodeCardInteractive(element);
  element.addEventListener("mousedown", (event) => {
    if (!(event.target as HTMLElement | null)?.closest("input")) {
      event.preventDefault();
    }
  });
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("click", (event) => event.stopPropagation());
  element.addEventListener("dblclick", (event) => event.stopPropagation());

  const row = element.createDiv({ cls: "ss-studio-image-board-toolbar__row" });

  const styles = row.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
  for (const { style, label } of STYLES) {
    const button = createStudioAction(styles, {
      className: "ss-studio-image-board-toolbar__choice",
      label,
      testId: `studio.text.style.${style}`,
      size: "small",
      onSelect: () => onChange({ style }, CHOSEN),
    });
    updaters.push((look) => updateUiAction(button, { selected: look.style === style }));
  }

  row.createDiv({ cls: "ss-studio-image-board-toolbar__divider" });
  const aligns = row.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
  for (const { align, icon, label } of ALIGNS) {
    const button = createStudioAction(aligns, {
      className: "ss-studio-image-board-toolbar__tool",
      label,
      testId: `studio.text.align.${align}`,
      icon,
      size: "icon",
      onSelect: () => onChange({ align }, CHOSEN),
    });
    updaters.push((look) => updateUiAction(button, { selected: look.align === align }));
  }

  row.createDiv({ cls: "ss-studio-image-board-toolbar__divider" });
  const colors = row.createDiv({ cls: "ss-studio-image-board-toolbar__group" });
  const auto = createStudioAction(colors, {
    className: "ss-studio-image-board-toolbar__choice",
    label: "Auto",
    testId: "studio.text.color.auto",
    size: "small",
    onSelect: () => onChange({ color: null }, CHOSEN),
  });
  auto.setAttribute("aria-label", "Automatic colour");
  updaters.push((look) => updateUiAction(auto, { selected: look.color === null }));
  for (const { id, label, color } of STUDIO_IMAGE_BOARD_SWATCHES) {
    const button = createStudioAction(colors, {
      className: "ss-studio-image-board-toolbar__swatch",
      label,
      testId: `studio.text.color.${id}`,
      size: "icon",
      onSelect: () => onChange({ color }, CHOSEN),
    });
    button.setCssProps({ "--ss-studio-swatch-color": color });
    updaters.push((look) => updateUiAction(button, { selected: look.color === color }));
  }
  const custom = colors.createEl("input", {
    cls: "ss-studio-image-board-toolbar__color",
    type: "color",
    attr: { "data-testid": "studio.text.color.custom", "aria-label": "Custom color" },
  });
  let picking = false;
  custom.addEventListener("input", () => {
    onChange({ color: custom.value }, { mode: "continuous", captureHistory: !picking });
    picking = true;
  });
  // Closing the picker goes back to typing; clicking away from it ends the edit.
  custom.addEventListener("change", () => {
    picking = false;
    options.returnFocus();
  });
  custom.addEventListener("blur", (event) => options.onFocusLeft(event.relatedTarget));
  updaters.push((look) => {
    // Leave the native picker alone while it is open and driving the value.
    if (look.color && /^#[0-9a-f]{6}$/i.test(look.color) && custom.ownerDocument.activeElement !== custom) {
      custom.value = look.color;
    }
  });

  const sync = (look: StudioFillTextLook): void => {
    for (const update of updaters) {
      update(look);
    }
  };
  sync(options.look);
  return { element, sync, dispose: () => element.remove() };
}
