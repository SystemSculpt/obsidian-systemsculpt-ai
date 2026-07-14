import {
  countStudioCaptionBoardEdits,
  type StudioCaptionBoardAnnotation,
  type StudioCaptionBoardAnnotationKind,
  type StudioCaptionBoardCrop,
  type StudioCaptionBoardLabel,
  type StudioCaptionBoardState,
  type StudioCaptionBoardStyleVariant,
} from "../../../../studio/StudioCaptionBoardState";
import { createStudioAction } from "../../StudioAction";
import {
  annotationLabel,
  CROP_MIN_HEIGHT,
  CROP_MIN_WIDTH,
  resolveSelectedAnnotation,
  resolveSelectedLabel,
  type StudioImageEditorSelection,
} from "./StudioImageEditorTypes";

type StudioImageEditorInspectorActions = {
  addLabel: () => void;
  addAnnotation: (kind: StudioCaptionBoardAnnotationKind) => void;
  ensureCrop: () => void;
  select: (selection: StudioImageEditorSelection | null) => void;
  patchLabel: (patch: Partial<StudioCaptionBoardLabel>) => void;
  patchAnnotation: (patch: Partial<StudioCaptionBoardAnnotation>) => void;
  patchCrop: (patch: Partial<StudioCaptionBoardCrop>) => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  bumpSelected: (direction: -1 | 1) => void;
  clearCrop: () => void;
};

export class StudioImageEditorInspector {
  constructor(
    private readonly sidebarEl: HTMLElement,
    private readonly actions: StudioImageEditorInspectorActions
  ) {}

  render(
    state: StudioCaptionBoardState,
    selection: StudioImageEditorSelection | null,
    hasSource: boolean
  ): void {
    this.sidebarEl.empty();
    const header = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__sidebar-header" });
    header.createDiv({ cls: "ss-studio-caption-board__sidebar-title", text: "Inspector" });
    header.createDiv({
      cls: "ss-studio-caption-board__sidebar-subtitle",
      text: hasSource ? "Select a layer to edit it." : "Load an image to start.",
    });
    if (!hasSource) {
      this.sidebarEl.createDiv({
        cls: "ss-studio-caption-board__sidebar-empty",
        text: "An image source is required.",
      });
      return;
    }

    const tools = this.createSection("Tools");
    tools.createDiv({
      cls: "ss-studio-caption-board__sidebar-copy",
      text: describeSelection(state, selection),
    });
    const toolButtons = tools.createDiv({ cls: "ss-studio-caption-board__button-grid" });
    this.createButton(toolButtons, "Add Text", this.actions.addLabel);
    this.createButton(toolButtons, "Red Box", () => this.actions.addAnnotation("highlight_rect"));
    this.createButton(toolButtons, "Red Circle", () => this.actions.addAnnotation("highlight_circle"));
    this.createButton(toolButtons, "Blur Box", () => this.actions.addAnnotation("blur_rect"));
    this.createButton(toolButtons, state.crop ? "Select Crop" : "Add Crop", this.actions.ensureCrop);
    this.createButton(toolButtons, "Deselect", () => this.actions.select(null));

    const label = resolveSelectedLabel(state, selection);
    if (label) {
      this.renderLabel(label);
      return;
    }
    const annotation = resolveSelectedAnnotation(state, selection);
    if (annotation) {
      this.renderAnnotation(annotation);
      return;
    }
    if (selection?.kind === "crop" && state.crop) {
      this.renderCrop(state.crop);
    }
  }

  private renderLabel(label: StudioCaptionBoardLabel): void {
    const section = this.createSection("Text");
    const textField = this.createField(section, "Text");
    const input = textField.createEl("textarea", {
      cls: "ss-studio-caption-board__textarea",
      attr: { "aria-label": "Selected text layer" },
    });
    input.value = label.text;
    input.addEventListener("input", (event) => {
      this.actions.patchLabel({ text: (event.target as HTMLTextAreaElement).value });
    });

    const fontRow = this.createGrid(section, 2);
    this.createNumberInput(fontRow, {
      label: "Font",
      value: label.fontSize,
      min: 18,
      max: 160,
      step: 1,
      onInput: (fontSize) => this.actions.patchLabel({ fontSize }),
    });
    this.createColorInput(fontRow, "Color", label.textColor, (textColor) => {
      this.actions.patchLabel({ textColor });
    });

    const alignButtons = this.createField(section, "Align").createDiv({
      cls: "ss-studio-caption-board__toggle-row",
    });
    (["left", "center", "right"] as const).forEach((textAlign) => {
      this.createToggle(
        alignButtons,
        capitalize(textAlign),
        label.textAlign === textAlign,
        () => this.actions.patchLabel({ textAlign })
      );
    });

    const styleButtons = this.createField(section, "Style").createDiv({
      cls: "ss-studio-caption-board__toggle-row",
    });
    (["shadow", "outline", "banner"] as StudioCaptionBoardStyleVariant[]).forEach(
      (styleVariant) => {
        this.createToggle(
          styleButtons,
          capitalize(styleVariant),
          label.styleVariant === styleVariant,
          () => this.actions.patchLabel({ styleVariant })
        );
      }
    );
    this.renderLayerActions(section);
  }

  private renderAnnotation(annotation: StudioCaptionBoardAnnotation): void {
    const section = this.createSection(annotationLabel(annotation.kind));
    const kindButtons = this.createField(section, "Type").createDiv({
      cls: "ss-studio-caption-board__toggle-row",
    });
    const kinds: Array<[string, StudioCaptionBoardAnnotationKind]> = [
      ["Box", "highlight_rect"],
      ["Circle", "highlight_circle"],
      ["Blur", "blur_rect"],
    ];
    kinds.forEach(([label, kind]) => {
      this.createToggle(kindButtons, label, annotation.kind === kind, () => {
        this.actions.patchAnnotation({ kind });
      });
    });

    const visualRow = this.createGrid(section, 2);
    this.createColorInput(visualRow, "Color", annotation.color, (color) => {
      this.actions.patchAnnotation({ color });
    });
    this.createNumberInput(visualRow, {
      label: annotation.kind === "blur_rect" ? "Outline" : "Stroke",
      value: annotation.strokeWidth,
      min: 2,
      max: 24,
      step: 1,
      onInput: (strokeWidth) => this.actions.patchAnnotation({ strokeWidth }),
    });
    if (annotation.kind === "blur_rect") {
      this.createNumberInput(section, {
        label: "Blur Amount",
        value: annotation.blurRadius,
        min: 4,
        max: 48,
        step: 1,
        onInput: (blurRadius) => this.actions.patchAnnotation({ blurRadius }),
      });
    }
    this.renderLayerActions(section);
  }

  private renderCrop(crop: StudioCaptionBoardCrop): void {
    const section = this.createSection("Crop");
    section.createDiv({
      cls: "ss-studio-caption-board__sidebar-copy",
      text: "Everything outside the crop is removed.",
    });
    const position = this.createGrid(section, 2);
    this.createPercentInput(position, "X", crop.x, 0, (x) => this.actions.patchCrop({ x }));
    this.createPercentInput(position, "Y", crop.y, 0, (y) => this.actions.patchCrop({ y }));
    const size = this.createGrid(section, 2);
    this.createPercentInput(size, "Width", crop.width, CROP_MIN_WIDTH, (width) => {
      this.actions.patchCrop({ width });
    });
    this.createPercentInput(size, "Height", crop.height, CROP_MIN_HEIGHT, (height) => {
      this.actions.patchCrop({ height });
    });
    const buttons = this.createField(section, "Actions").createDiv({
      cls: "ss-studio-caption-board__button-row",
    });
    this.createButton(buttons, "Clear Crop", this.actions.clearCrop);
  }

  private renderLayerActions(section: HTMLElement): void {
    const buttons = this.createField(section, "Actions").createDiv({
      cls: "ss-studio-caption-board__button-grid",
    });
    this.createButton(buttons, "Duplicate", this.actions.duplicateSelected);
    this.createButton(buttons, "Delete", this.actions.deleteSelected);
    this.createButton(buttons, "Bring Forward", () => this.actions.bumpSelected(1));
    this.createButton(buttons, "Send Back", () => this.actions.bumpSelected(-1));
  }

  private createSection(title: string): HTMLElement {
    const section = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__inspector-section" });
    section.createDiv({
      cls: "ss-studio-caption-board__inspector-section-title",
      text: title,
    });
    return section;
  }

  private createField(parent: HTMLElement, label: string): HTMLElement {
    const field = parent.createDiv({ cls: "ss-studio-caption-board__field" });
    field.createDiv({ cls: "ss-studio-caption-board__field-label", text: label });
    return field;
  }

  private createGrid(parent: HTMLElement, columns: number): HTMLElement {
    return parent.createDiv({ cls: `ss-studio-caption-board__grid is-${columns}-col` });
  }

  private createToggle(
    parent: HTMLElement,
    label: string,
    selected: boolean,
    onSelect: () => void
  ): void {
    createStudioAction(parent, {
      className: "ss-studio-caption-board__toggle",
      label,
      size: "small",
      selected,
      onSelect,
    });
  }

  private createButton(parent: HTMLElement, label: string, onSelect: () => void): void {
    createStudioAction(parent, {
      className: "ss-studio-caption-board__secondary-button",
      label,
      size: "small",
      onSelect,
    });
  }

  private createNumberInput(
    parent: HTMLElement,
    options: {
      label: string;
      value: number;
      min: number;
      max: number;
      step: number;
      onInput: (value: number) => void;
    }
  ): void {
    const input = this.createField(parent, options.label).createEl("input", {
      cls: "ss-studio-caption-board__input",
      type: "number",
      attr: { "aria-label": options.label },
    });
    input.value = String(options.value);
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.addEventListener("input", (event) => {
      options.onInput(Number((event.target as HTMLInputElement).value));
    });
  }

  private createPercentInput(
    parent: HTMLElement,
    label: string,
    value: number,
    min: number,
    onInput: (value: number) => void
  ): void {
    this.createNumberInput(parent, {
      label: `${label} %`,
      value: Math.round(value * 100),
      min: Math.round(min * 100),
      max: 100,
      step: 1,
      onInput: (percent) => onInput(percent / 100),
    });
  }

  private createColorInput(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (value: string) => void
  ): void {
    const input = this.createField(parent, label).createEl("input", {
      cls: "ss-studio-caption-board__input is-color",
      type: "color",
      attr: { "aria-label": label },
    });
    input.value = value;
    input.addEventListener("input", (event) => {
      onInput((event.target as HTMLInputElement).value);
    });
  }
}

function describeSelection(
  state: StudioCaptionBoardState,
  selection: StudioImageEditorSelection | null
): string {
  if (resolveSelectedLabel(state, selection)) {
    return "Text layer selected.";
  }
  const annotation = resolveSelectedAnnotation(state, selection);
  if (annotation) {
    return `${annotationLabel(annotation.kind)} selected.`;
  }
  if (selection?.kind === "crop") {
    return "Crop selected.";
  }
  return countStudioCaptionBoardEdits(state) === 0
    ? "Choose a tool to begin."
    : "Select a layer on the canvas.";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
