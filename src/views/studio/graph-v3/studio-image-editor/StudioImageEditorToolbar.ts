import {
  countStudioCaptionBoardEdits,
  type StudioCaptionBoardAnnotationKind,
  type StudioCaptionBoardState,
} from "../../../../studio/StudioCaptionBoardState";
import { createStudioAction } from "../../StudioAction";
import {
  annotationLabel,
  resolveSelectedAnnotation,
  resolveSelectedLabel,
  type StudioImageEditorSelection,
} from "./StudioImageEditorTypes";

type StudioImageEditorToolbarActions = {
  addLabel: () => void;
  addAnnotation: (kind: StudioCaptionBoardAnnotationKind) => void;
  ensureCrop: () => void;
  fit: () => void;
  done: () => Promise<void>;
};

export class StudioImageEditorToolbar {
  private readonly addTextButton: HTMLButtonElement;
  private readonly highlightRectButton: HTMLButtonElement;
  private readonly highlightCircleButton: HTMLButtonElement;
  private readonly blurButton: HTMLButtonElement;
  private readonly cropButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly doneButton: HTMLButtonElement;

  constructor(
    toolbarEl: HTMLElement,
    private readonly statusEl: HTMLElement,
    actions: StudioImageEditorToolbarActions
  ) {
    const buttons = toolbarEl.createDiv({ cls: "ss-studio-caption-board__toolbar-actions" });
    this.addTextButton = createToolbarButton(buttons, "Text", actions.addLabel);
    this.highlightRectButton = createToolbarButton(buttons, "Box", () => {
      actions.addAnnotation("highlight_rect");
    });
    this.highlightCircleButton = createToolbarButton(buttons, "Circle", () => {
      actions.addAnnotation("highlight_circle");
    });
    this.blurButton = createToolbarButton(buttons, "Blur", () => {
      actions.addAnnotation("blur_rect");
    });
    this.cropButton = createToolbarButton(buttons, "Crop", actions.ensureCrop);
    this.fitButton = createToolbarButton(buttons, "Fit", actions.fit);
    this.doneButton = createToolbarButton(buttons, "Done", () => {
      void actions.done();
    });
  }

  render(options: {
    state: StudioCaptionBoardState;
    selection: StudioImageEditorSelection | null;
    hasSource: boolean;
    saving: boolean;
    statusOverride: string;
  }): void {
    const disabled = !options.hasSource || options.saving;
    this.addTextButton.disabled = disabled;
    this.highlightRectButton.disabled = disabled;
    this.highlightCircleButton.disabled = disabled;
    this.blurButton.disabled = disabled;
    this.cropButton.disabled = disabled;
    this.fitButton.disabled = disabled;
    this.doneButton.disabled = disabled;
    this.doneButton.textContent = options.saving ? "Saving..." : "Done";
    this.statusEl.setText(describeStatus(options));
  }
}

function createToolbarButton(
  parent: HTMLElement,
  label: string,
  onSelect: () => void
): HTMLButtonElement {
  return createStudioAction(parent, {
    className: "ss-studio-caption-board__toolbar-button",
    label,
    size: "small",
    onSelect,
  });
}

function describeStatus(options: {
  state: StudioCaptionBoardState;
  selection: StudioImageEditorSelection | null;
  hasSource: boolean;
  statusOverride: string;
}): string {
  if (options.statusOverride) {
    return options.statusOverride;
  }
  if (!options.hasSource) {
    return "Load a source image to start editing.";
  }
  const editCount = countStudioCaptionBoardEdits(options.state);
  if (editCount === 0) {
    return "Add a layer. Scroll to pan; hold Cmd/Ctrl while scrolling to zoom.";
  }
  const label = resolveSelectedLabel(options.state, options.selection);
  const annotation = resolveSelectedAnnotation(options.state, options.selection);
  const selected = label
    ? " Text selected."
    : annotation
      ? ` ${annotationLabel(annotation.kind)} selected.`
      : options.selection?.kind === "crop"
        ? " Crop selected."
        : "";
  return `${editCount} edit${editCount === 1 ? "" : "s"}.${selected}`;
}
