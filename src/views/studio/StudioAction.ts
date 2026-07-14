import {
  createUiAction,
  type UiActionOptions,
} from "../../core/ui/surface";

export type StudioActionOptions = Omit<UiActionOptions, "onSelect"> & Readonly<{
  ariaLabel?: string;
  className?: string;
  stopPointerDown?: boolean;
  onSelect?: (event: MouseEvent) => void;
}>;

/**
 * Adapts the canonical action to Studio's draggable graph surfaces.
 * Clicks never leak into node/card selection, and callers can also contain
 * pointerdown when an action sits directly inside a draggable group surface.
 */
export function createStudioAction(
  parent: HTMLElement,
  options: StudioActionOptions,
): HTMLButtonElement {
  const {
    ariaLabel,
    className,
    stopPointerDown = false,
    onSelect,
    ...actionOptions
  } = options;
  const button = createUiAction(parent, {
    ...actionOptions,
    onSelect: onSelect
      ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(event);
        }
      : undefined,
  });

  if (ariaLabel) {
    button.setAttribute("aria-label", ariaLabel);
  }
  if (className) {
    button.classList.add(...className.split(/\s+/).filter(Boolean));
  }
  if (stopPointerDown) {
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
  }
  return button;
}
