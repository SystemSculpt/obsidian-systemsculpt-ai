import type {
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigFieldDefinition,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioNodeOutputMap,
} from "../../studio/types";
import {
  getUnknownNodeConfigKeys,
  isNodeConfigFieldVisible,
  mergeNodeConfigWithDefaults,
  rebuildConfigWithUnknownKeys,
  validateNodeConfig,
} from "../../studio/StudioNodeConfigValidation";
import { isRecord } from "../../studio/utils";
import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";
import { browseForNodeConfigPath } from "./StudioPathFieldPicker";
import { renderStudioSearchableDropdown } from "./StudioSearchableDropdown";

const MIN_INSPECTOR_WIDTH = 320;
const MIN_INSPECTOR_HEIGHT = 280;
const INSPECTOR_EDGE_PADDING = 8;
const INSPECTOR_ANCHOR_GAP = 12;
const MIN_INSPECTOR_SCALE = STUDIO_GRAPH_MIN_ZOOM;
const MAX_INSPECTOR_SCALE = STUDIO_GRAPH_MAX_ZOOM;

type InspectorPlacement = "right" | "left" | "bottom" | "top";

export type StudioNodeInspectorLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StudioNodeInspectorRuntimeDetails = {
  statusLabel: string;
  statusTone: "idle" | "pending" | "running" | "cached" | "succeeded" | "failed";
  statusMessage?: string;
  outputText?: string;
  outputPath?: string;
  outputs?: StudioNodeOutputMap | null;
  updatedAt?: string | null;
};

type StudioNodeInspectorOverlayHost = {
  isBusy: () => boolean;
  onConfigMutated: (node: StudioNodeInstance) => void;
  onTransientFieldError: (nodeId: string, fieldKey: string, message: string | null) => void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
  getRuntimeDetails?: (nodeId: string) => StudioNodeInspectorRuntimeDetails | null;
  onLayoutChanged?: (layout: StudioNodeInspectorLayout) => void;
};

function toText(value: StudioJsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "undefined" || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeInspectorScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_INSPECTOR_SCALE, Math.max(MIN_INSPECTOR_SCALE, value));
}

function clampInspectorSize(
  viewportEl: HTMLElement,
  layout: StudioNodeInspectorLayout,
  scale = 1
): Pick<StudioNodeInspectorLayout, "width" | "height"> {
  const normalizedScale = normalizeInspectorScale(scale);
  const viewportWidth = Math.max(0, viewportEl.clientWidth - INSPECTOR_EDGE_PADDING * 2);
  const viewportHeight = Math.max(0, viewportEl.clientHeight - INSPECTOR_EDGE_PADDING * 2);
  const maxWidth = Math.max(180, viewportWidth / normalizedScale);
  const maxHeight = Math.max(160, viewportHeight / normalizedScale);
  const minWidth = Math.min(MIN_INSPECTOR_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_INSPECTOR_HEIGHT, maxHeight);
  const width = Math.min(maxWidth, Math.max(minWidth, layout.width));
  const height = Math.min(maxHeight, Math.max(minHeight, layout.height));
  return { width, height };
}

function clampInspectorPosition(
  viewportEl: HTMLElement,
  layout: StudioNodeInspectorLayout,
  scale = 1
): Pick<StudioNodeInspectorLayout, "x" | "y"> {
  const normalizedScale = normalizeInspectorScale(scale);
  const visualWidth = layout.width * normalizedScale;
  const visualHeight = layout.height * normalizedScale;
  const minX = viewportEl.scrollLeft + INSPECTOR_EDGE_PADDING;
  const minY = viewportEl.scrollTop + INSPECTOR_EDGE_PADDING;
  const maxX = Math.max(
    minX,
    viewportEl.scrollLeft + viewportEl.clientWidth - visualWidth - INSPECTOR_EDGE_PADDING
  );
  const maxY = Math.max(
    minY,
    viewportEl.scrollTop + viewportEl.clientHeight - visualHeight - INSPECTOR_EDGE_PADDING
  );
  return {
    x: Math.min(maxX, Math.max(minX, layout.x)),
    y: Math.min(maxY, Math.max(minY, layout.y)),
  };
}

function appendPathBrowseButtonIcon(
  buttonEl: HTMLElement,
  iconClassName: string
): void {
  const iconEl = buttonEl.createSpan({ cls: iconClassName });
  iconEl.setAttr("aria-hidden", "true");
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const folderPath = document.createElementNS(namespace, "path");
  folderPath.setAttribute("d", "M1.75 4.75a1 1 0 0 1 1-1h3l1.1 1.2h6.4a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z");
  const linePath = document.createElementNS(namespace, "path");
  linePath.setAttribute("d", "M6.25 8.4h4.1m-2.05-2.05V10.5");
  svg.append(folderPath, linePath);
  iconEl.appendChild(svg);
}

export class StudioNodeInspectorOverlay {
  private viewportEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private headerTitleEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resizeHandleEl: HTMLElement | null = null;
  private activeNodeId: string | null = null;
  private transientFieldErrors = new Map<string, string>();
  private layout: StudioNodeInspectorLayout;
  private placement: InspectorPlacement = "right";
  private graphZoom = 1;

  constructor(
    private readonly host: StudioNodeInspectorOverlayHost,
    initialLayout?: Partial<StudioNodeInspectorLayout>
  ) {
    this.layout = {
      x: Number.isFinite(initialLayout?.x) ? Number(initialLayout?.x) : 36,
      y: Number.isFinite(initialLayout?.y) ? Number(initialLayout?.y) : 88,
      width: Number.isFinite(initialLayout?.width) ? Number(initialLayout?.width) : 420,
      height: Number.isFinite(initialLayout?.height) ? Number(initialLayout?.height) : 460,
    };
  }

  mount(viewportEl: HTMLElement): void {
    this.viewportEl = viewportEl;
    if (!this.rootEl) {
      this.createDom();
    }
    if (this.rootEl && this.rootEl.parentElement !== viewportEl) {
      viewportEl.appendChild(this.rootEl);
    }
    this.applyLayout();
  }

  destroy(): void {
    this.clearAllTransientErrors();
    this.activeNodeId = null;
    if (this.rootEl?.parentElement) {
      this.rootEl.parentElement.removeChild(this.rootEl);
    }
    this.viewportEl = null;
    this.rootEl = null;
    this.headerTitleEl = null;
    this.bodyEl = null;
    this.statusEl = null;
    this.resizeHandleEl = null;
  }

  setLayout(layout: Partial<StudioNodeInspectorLayout>): void {
    this.layout = {
      x: Number.isFinite(layout.x) ? Number(layout.x) : this.layout.x,
      y: Number.isFinite(layout.y) ? Number(layout.y) : this.layout.y,
      width: Number.isFinite(layout.width) ? Number(layout.width) : this.layout.width,
      height: Number.isFinite(layout.height) ? Number(layout.height) : this.layout.height,
    };
    this.applyLayout();
  }

  setGraphZoom(zoom: number): void {
    const nextZoom = normalizeInspectorScale(zoom);
    if (Math.abs(this.graphZoom - nextZoom) < 0.0001) {
      return;
    }
    this.graphZoom = nextZoom;
    this.applyLayout();
  }

  getLayout(): StudioNodeInspectorLayout {
    return { ...this.layout };
  }

  hide(): void {
    this.clearAllTransientErrors();
    this.activeNodeId = null;
    if (this.rootEl) {
      this.rootEl.style.display = "none";
    }
  }

  showNode(
    node: StudioNodeInstance,
    definition: StudioNodeDefinition,
    options?: {
      anchorEl?: HTMLElement | null;
    }
  ): void {
    if (!this.rootEl || !this.headerTitleEl || !this.bodyEl || !this.statusEl) {
      return;
    }

    if (this.activeNodeId !== node.id) {
      this.clearAllTransientErrors();
      this.activeNodeId = node.id;
    }

    this.rootEl.style.display = "flex";
    this.headerTitleEl.setText(`${node.title || node.kind}`);
    this.statusEl.setText("");
    this.positionNearNode(options?.anchorEl || null);
    this.renderForm(node, definition);
  }

  private createDom(): void {
    if (!this.viewportEl) {
      return;
    }

    const root = this.viewportEl.createDiv({ cls: "ss-studio-node-inspector" });
    root.style.display = "none";
    root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    root.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const header = root.createDiv({ cls: "ss-studio-node-inspector-header" });
    const title = header.createDiv({
      cls: "ss-studio-node-inspector-title",
      text: "Node Inspector",
    });
    header.createDiv({
      cls: "ss-studio-node-inspector-subtitle",
      text: "Config",
    });
    this.bindDrag(header);

    const body = root.createDiv({ cls: "ss-studio-node-inspector-body" });
    const status = root.createDiv({ cls: "ss-studio-node-inspector-status" });
    const resizeHandle = root.createDiv({ cls: "ss-studio-node-inspector-resize" });
    this.bindResize(resizeHandle);

    this.rootEl = root;
    this.headerTitleEl = title;
    this.bodyEl = body;
    this.statusEl = status;
    this.resizeHandleEl = resizeHandle;
    this.applyLayout();
  }

  private applyLayout(options?: { clampPosition?: boolean }): void {
    if (!this.rootEl || !this.viewportEl) {
      return;
    }

    const scale = normalizeInspectorScale(this.graphZoom);
    const nextSize = clampInspectorSize(this.viewportEl, this.layout, scale);
    this.layout = {
      ...this.layout,
      ...nextSize,
    };

    if (options?.clampPosition !== false) {
      const nextPosition = clampInspectorPosition(this.viewportEl, this.layout, scale);
      this.layout = {
        ...this.layout,
        ...nextPosition,
      };
    }

    this.rootEl.style.left = `${this.layout.x}px`;
    this.rootEl.style.top = `${this.layout.y}px`;
    this.rootEl.style.width = `${this.layout.width}px`;
    this.rootEl.style.height = `${this.layout.height}px`;
    this.rootEl.style.setProperty("--ss-studio-inspector-scale", String(scale));
    this.rootEl.style.transformOrigin = "top left";
    this.rootEl.dataset.side = this.placement;
    this.host.onLayoutChanged?.({ ...this.layout });
  }

  private positionNearNode(anchorEl: HTMLElement | null): void {
    if (!this.viewportEl || !anchorEl) {
      this.applyLayout();
      return;
    }

    const scale = normalizeInspectorScale(this.graphZoom);
    const size = clampInspectorSize(this.viewportEl, this.layout, scale);
    const width = size.width;
    const height = size.height;
    const visualWidth = width * scale;
    const visualHeight = height * scale;
    const viewportRect = this.viewportEl.getBoundingClientRect();
    const nodeRect = anchorEl.getBoundingClientRect();

    const rightSpace = viewportRect.right - nodeRect.right;
    const leftSpace = nodeRect.left - viewportRect.left;
    const bottomSpace = viewportRect.bottom - nodeRect.bottom;
    const topSpace = nodeRect.top - viewportRect.top;

    const nodeX = this.viewportEl.scrollLeft + (nodeRect.left - viewportRect.left);
    const nodeY = this.viewportEl.scrollTop + (nodeRect.top - viewportRect.top);
    const nodeWidth = nodeRect.width;
    const nodeHeight = nodeRect.height;

    const centerY = nodeY + (nodeHeight - visualHeight) / 2;
    const centerX = nodeX + (nodeWidth - visualWidth) / 2;

    const minY = this.viewportEl.scrollTop + INSPECTOR_EDGE_PADDING;
    const maxY = this.viewportEl.scrollTop + this.viewportEl.clientHeight - visualHeight - INSPECTOR_EDGE_PADDING;
    const minX = this.viewportEl.scrollLeft + INSPECTOR_EDGE_PADDING;
    const maxX = this.viewportEl.scrollLeft + this.viewportEl.clientWidth - visualWidth - INSPECTOR_EDGE_PADDING;
    const boundedMaxY = Math.max(minY, maxY);
    const boundedMaxX = Math.max(minX, maxX);

    let placement: InspectorPlacement = "right";
    let x = nodeX + nodeWidth + INSPECTOR_ANCHOR_GAP;
    let y = Math.min(boundedMaxY, Math.max(minY, centerY));
    let clampPosition = true;

    if (rightSpace >= visualWidth + INSPECTOR_ANCHOR_GAP) {
      placement = "right";
      x = nodeX + nodeWidth + INSPECTOR_ANCHOR_GAP;
      y = Math.min(boundedMaxY, Math.max(minY, centerY));
    } else if (leftSpace >= visualWidth + INSPECTOR_ANCHOR_GAP) {
      placement = "left";
      x = nodeX - visualWidth - INSPECTOR_ANCHOR_GAP;
      y = Math.min(boundedMaxY, Math.max(minY, centerY));
    } else if (bottomSpace >= visualHeight + INSPECTOR_ANCHOR_GAP) {
      placement = "bottom";
      x = Math.min(boundedMaxX, Math.max(minX, centerX));
      y = nodeY + nodeHeight + INSPECTOR_ANCHOR_GAP;
    } else if (topSpace >= visualHeight + INSPECTOR_ANCHOR_GAP) {
      placement = "top";
      x = Math.min(boundedMaxX, Math.max(minX, centerX));
      y = nodeY - visualHeight - INSPECTOR_ANCHOR_GAP;
    } else {
      placement = "right";
      x = nodeX + nodeWidth + INSPECTOR_ANCHOR_GAP;
      y = Math.min(boundedMaxY, Math.max(minY, centerY));
      clampPosition = false;
    }

    this.layout = {
      ...this.layout,
      width,
      height,
      x,
      y,
    };
    this.placement = placement;
    this.applyLayout({ clampPosition });
  }

  private bindDrag(handleEl: HTMLElement): void {
    handleEl.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      const target = pointer.target as HTMLElement | null;
      if (!target || target.closest("input, textarea, select, button")) {
        return;
      }
      if (!this.rootEl || !this.viewportEl) {
        return;
      }

      event.preventDefault();
      const pointerId = pointer.pointerId;
      const startX = pointer.clientX;
      const startY = pointer.clientY;
      const startLayout = { ...this.layout };

      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        this.layout = {
          ...startLayout,
          x: startLayout.x + (moveEvent.clientX - startX),
          y: startLayout.y + (moveEvent.clientY - startY),
        };
        this.applyLayout();
      };

      const onEnd = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId !== pointerId) {
          return;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    });
  }

  private bindResize(handleEl: HTMLElement): void {
    handleEl.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      if (!this.rootEl || !this.viewportEl) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const pointerId = pointer.pointerId;
      const startX = pointer.clientX;
      const startY = pointer.clientY;
      const startLayout = { ...this.layout };

      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        const scale = normalizeInspectorScale(this.graphZoom);
        this.layout = {
          ...startLayout,
          width: startLayout.width + (moveEvent.clientX - startX) / scale,
          height: startLayout.height + (moveEvent.clientY - startY) / scale,
        };
        this.applyLayout();
      };

      const onEnd = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId !== pointerId) {
          return;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    });
  }

  private renderForm(node: StudioNodeInstance, definition: StudioNodeDefinition): void {
    if (!this.bodyEl || !this.statusEl) {
      return;
    }

    this.bodyEl.empty();
    this.statusEl.setText("");
    const mergedConfig = mergeNodeConfigWithDefaults(definition, node.config);
    const fieldErrors = new Map<string, HTMLElement>();
    const fieldWrappers = new Map<string, { field: StudioNodeConfigFieldDefinition; wrapper: HTMLElement }>();
    const refreshVisibilityState = (): void => {
      const visibilityConfig = mergeNodeConfigWithDefaults(definition, node.config);
      for (const [key, entry] of fieldWrappers.entries()) {
        const isVisible = isNodeConfigFieldVisible(entry.field, visibilityConfig);
        entry.wrapper.classList.toggle("is-hidden", !isVisible);
        if (!isVisible) {
          const errorEl = fieldErrors.get(key);
          if (errorEl) {
            errorEl.setText("");
            errorEl.classList.remove("is-visible");
          }
        }
      }
    };
    const refreshValidation = (): void => {
      refreshVisibilityState();
      this.refreshFieldValidationState(node, definition, fieldErrors);
    };

    for (const field of definition.configSchema.fields) {
      const wrapper = this.bodyEl.createDiv({ cls: "ss-studio-node-inspector-field" });
      fieldWrappers.set(field.key, { field, wrapper });
      const label = wrapper.createDiv({
        cls: "ss-studio-node-inspector-field-label",
        text: field.label,
      });
      if (field.required === true) {
        label.addClass("is-required");
      }
      if (field.description) {
        wrapper.createDiv({
          cls: "ss-studio-node-inspector-field-help",
          text: field.description,
        });
      }

      const value = mergedConfig[field.key];
      this.renderFieldInput({
        wrapper,
        field,
        node,
        initialValue: value,
        onValidationRefresh: refreshValidation,
      });

      const errorEl = wrapper.createDiv({ cls: "ss-studio-node-inspector-field-error" });
      fieldErrors.set(field.key, errorEl);
    }

    if (definition.configSchema.allowUnknownKeys === true) {
      this.renderUnknownKeysEditor(node, definition, fieldErrors, refreshValidation);
    }

    this.renderRuntimeDetails(node.id);

    refreshValidation();
  }

  private renderRuntimeDetails(nodeId: string): void {
    if (!this.bodyEl) {
      return;
    }
    const runtime = this.host.getRuntimeDetails?.(nodeId);
    if (!runtime) {
      return;
    }

    const section = this.bodyEl.createDiv({ cls: "ss-studio-node-inspector-runtime" });
    const header = section.createDiv({ cls: "ss-studio-node-inspector-runtime-header" });
    header.createDiv({
      cls: "ss-studio-node-inspector-runtime-title",
      text: "Last Run",
    });
    header.createDiv({
      cls: `ss-studio-node-inspector-runtime-badge is-${runtime.statusTone}`,
      text: runtime.statusLabel,
    });

    if (runtime.statusMessage && runtime.statusMessage.trim().length > 0) {
      section.createDiv({
        cls: "ss-studio-node-inspector-runtime-message",
        text: runtime.statusMessage.trim(),
      });
    }

    if (runtime.outputPath && runtime.outputPath.trim().length > 0) {
      const field = section.createDiv({ cls: "ss-studio-node-inspector-runtime-field" });
      field.createDiv({
        cls: "ss-studio-node-inspector-runtime-label",
        text: "Output Path",
      });
      field.createEl("input", {
        cls: "ss-studio-node-inspector-input ss-studio-node-inspector-runtime-path",
        attr: {
          readonly: "true",
          value: runtime.outputPath.trim(),
        },
      });
    }

    if (runtime.outputText && runtime.outputText.trim().length > 0) {
      const field = section.createDiv({ cls: "ss-studio-node-inspector-runtime-field" });
      field.createDiv({
        cls: "ss-studio-node-inspector-runtime-label",
        text: "Output Text",
      });
      const textarea = field.createEl("textarea", {
        cls: "ss-studio-node-inspector-textarea is-monospace",
      });
      textarea.readOnly = true;
      textarea.value = runtime.outputText.trim();
    }

    if (runtime.outputs && Object.keys(runtime.outputs).length > 0) {
      const field = section.createDiv({ cls: "ss-studio-node-inspector-runtime-field" });
      field.createDiv({
        cls: "ss-studio-node-inspector-runtime-label",
        text: "Raw Outputs",
      });
      const textarea = field.createEl("textarea", {
        cls: "ss-studio-node-inspector-textarea is-monospace",
      });
      textarea.readOnly = true;
      textarea.value = JSON.stringify(runtime.outputs, null, 2);
    }

    if (runtime.updatedAt && runtime.updatedAt.trim().length > 0) {
      section.createDiv({
        cls: "ss-studio-node-inspector-runtime-updated",
        text: `Updated: ${runtime.updatedAt}`,
      });
    }
  }

  private renderPathFieldInput(options: {
    wrapper: HTMLElement;
    field: StudioNodeConfigFieldDefinition;
    node: StudioNodeInstance;
    initialValue: StudioJsonValue | undefined;
    disabled: boolean;
    onValidationRefresh: () => void;
    applyValue: (nextValue: StudioJsonValue) => void;
  }): void {
    const { wrapper, field, node, initialValue, disabled, onValidationRefresh, applyValue } = options;

    const row = wrapper.createDiv({ cls: "ss-studio-node-inspector-path-row" });
    const input = row.createEl("input", {
      type: "text",
      cls: "ss-studio-node-inspector-input ss-studio-node-inspector-path-input",
    });
    input.value = toText(initialValue);
    input.placeholder = field.placeholder || (field.type === "directory_path" ? "Choose folder" : "Choose file");
    input.disabled = disabled;
    input.addEventListener("input", (event) => {
      applyValue((event.target as HTMLInputElement).value);
    });

    const browseButton = row.createEl("button", {
      cls: "ss-studio-node-inspector-path-button ss-studio-path-browse-button",
      attr: {
        "aria-label":
          field.type === "directory_path" ? "Browse folders" : "Browse files",
        title: field.type === "directory_path" ? "Browse folders" : "Browse files",
      },
    });
    browseButton.type = "button";
    browseButton.disabled = disabled;
    appendPathBrowseButtonIcon(
      browseButton,
      "ss-studio-node-inspector-path-button-icon ss-studio-path-browse-button-icon"
    );
    browseButton.createSpan({
      cls: "ss-studio-node-inspector-path-button-label ss-studio-path-browse-button-label",
      text: field.type === "directory_path" ? "Folder" : "Browse",
    });
    browseButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selected = await browseForNodeConfigPath(field);
      if (!selected) {
        return;
      }
      input.value = selected;
      applyValue(selected);
      this.setTransientFieldError(node.id, field.key, null);
      onValidationRefresh();
    });
  }

  private renderFieldInput(options: {
    wrapper: HTMLElement;
    field: StudioNodeConfigFieldDefinition;
    node: StudioNodeInstance;
    initialValue: StudioJsonValue | undefined;
    onValidationRefresh: () => void;
  }): void {
    const { wrapper, field, node, initialValue, onValidationRefresh } = options;
    const disabled = this.host.isBusy();

    const applyValue = (nextValue: StudioJsonValue): void => {
      node.config[field.key] = nextValue;
      this.setTransientFieldError(node.id, field.key, null);
      this.host.onConfigMutated(node);
      onValidationRefresh();
    };

    if (field.type === "text") {
      const input = wrapper.createEl("input", {
        type: "text",
        cls: "ss-studio-node-inspector-input",
      });
      input.value = toText(initialValue);
      input.placeholder = field.placeholder || "";
      input.disabled = disabled;
      input.addEventListener("input", (event) => {
        applyValue((event.target as HTMLInputElement).value);
      });
      return;
    }

    if (field.type === "textarea") {
      const textarea = wrapper.createEl("textarea", {
        cls: "ss-studio-node-inspector-textarea",
      });
      textarea.value = toText(initialValue);
      textarea.placeholder = field.placeholder || "";
      textarea.disabled = disabled;
      textarea.addEventListener("input", (event) => {
        applyValue((event.target as HTMLTextAreaElement).value);
      });
      return;
    }

    if (field.type === "number") {
      const input = wrapper.createEl("input", {
        type: "number",
        cls: "ss-studio-node-inspector-input",
      });
      const initialNumber =
        typeof initialValue === "number" && Number.isFinite(initialValue) ? initialValue : null;
      input.value = initialNumber === null ? "" : String(initialNumber);
      if (typeof field.min === "number") input.min = String(field.min);
      if (typeof field.max === "number") input.max = String(field.max);
      if (typeof field.step === "number") input.step = String(field.step);
      input.placeholder = field.placeholder || "";
      input.disabled = disabled;
      input.addEventListener("input", (event) => {
        const raw = (event.target as HTMLInputElement).value.trim();
        if (!raw) {
          delete node.config[field.key];
          this.setTransientFieldError(node.id, field.key, null);
          this.host.onConfigMutated(node);
          onValidationRefresh();
          return;
        }

        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          this.setTransientFieldError(node.id, field.key, "Must be a valid number.");
          onValidationRefresh();
          return;
        }
        if (field.integer === true && !Number.isInteger(parsed)) {
          this.setTransientFieldError(node.id, field.key, "Must be an integer.");
          onValidationRefresh();
          return;
        }

        applyValue(parsed);
      });
      return;
    }

    if (field.type === "boolean") {
      const row = wrapper.createDiv({ cls: "ss-studio-node-inspector-checkbox-row" });
      const input = row.createEl("input", {
        type: "checkbox",
        cls: "ss-studio-node-inspector-checkbox",
      });
      input.checked = initialValue === true;
      input.disabled = disabled;
      input.addEventListener("change", (event) => {
        applyValue((event.target as HTMLInputElement).checked);
      });
      row.createEl("span", {
        text: field.placeholder || "Enabled",
      });
      return;
    }

    if (field.type === "select") {
      if (field.selectPresentation === "searchable_dropdown") {
        renderStudioSearchableDropdown({
          containerEl: wrapper,
          ariaLabel: `${node.title || node.kind} ${field.label || field.key}`,
          value: typeof initialValue === "string" ? initialValue : "",
          disabled,
          placeholder: field.required === true ? "Select model" : "Default",
          noResultsText: "No matching models.",
          loadOptions: async (): Promise<StudioNodeConfigSelectOption[]> => {
            if (field.optionsSource && this.host.resolveDynamicSelectOptions) {
              const dynamicOptions = await this.host.resolveDynamicSelectOptions(field.optionsSource, node);
              if (Array.isArray(dynamicOptions) && dynamicOptions.length > 0) {
                return dynamicOptions;
              }
            }
            return Array.isArray(field.options) ? field.options : [];
          },
          onValueChange: (value) => {
            applyValue(value);
          },
        });
        return;
      }

      if (field.selectPresentation === "button_group" && Array.isArray(field.options) && field.options.length > 0) {
        const row = wrapper.createDiv({ cls: "ss-studio-node-inspector-select-button-group" });
        const selectedValue = typeof initialValue === "string" ? initialValue : "";
        const buttons: HTMLButtonElement[] = [];
        const refreshActiveState = (value: string): void => {
          for (const button of buttons) {
            button.classList.toggle("is-active", button.dataset.optionValue === value);
          }
        };

        for (const option of field.options) {
          const button = row.createEl("button", {
            cls: "ss-studio-node-inspector-select-button",
            text: option.label,
          });
          button.type = "button";
          button.dataset.optionValue = option.value;
          button.disabled = disabled;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            applyValue(option.value);
            refreshActiveState(option.value);
          });
          buttons.push(button);
        }

        refreshActiveState(selectedValue);
        return;
      }

      const select = wrapper.createEl("select", { cls: "ss-studio-node-inspector-select" });
      const empty = select.createEl("option", { text: "(none)" });
      empty.value = "";
      for (const option of field.options || []) {
        const next = select.createEl("option", { text: option.label });
        next.value = option.value;
      }
      select.value = typeof initialValue === "string" ? initialValue : "";
      select.disabled = disabled;
      select.addEventListener("change", (event) => {
        applyValue((event.target as HTMLSelectElement).value);
      });
      return;
    }

    if (
      field.type === "file_path" ||
      field.type === "directory_path" ||
      field.type === "media_path"
    ) {
      this.renderPathFieldInput({
        wrapper,
        field,
        node,
        initialValue,
        disabled,
        onValidationRefresh,
        applyValue,
      });
      return;
    }

    if (field.type === "json_object") {
      const textarea = wrapper.createEl("textarea", {
        cls: "ss-studio-node-inspector-textarea is-monospace",
      });
      const initial = isRecord(initialValue) ? initialValue : {};
      textarea.value = JSON.stringify(initial, null, 2);
      textarea.disabled = disabled;
      textarea.addEventListener("input", (event) => {
        const raw = (event.target as HTMLTextAreaElement).value.trim();
        if (!raw) {
          applyValue({});
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!isRecord(parsed)) {
            this.setTransientFieldError(node.id, field.key, "Must be a JSON object.");
            onValidationRefresh();
            return;
          }
          applyValue(parsed as unknown as StudioJsonValue);
        } catch {
          this.setTransientFieldError(node.id, field.key, "Invalid JSON.");
          onValidationRefresh();
        }
      });
      return;
    }

    if (field.type === "string_list") {
      const textarea = wrapper.createEl("textarea", {
        cls: "ss-studio-node-inspector-textarea is-monospace",
      });
      const initialLines = Array.isArray(initialValue)
        ? initialValue.map((entry) => String(entry ?? "")).join("\n")
        : "";
      textarea.value = initialLines;
      textarea.placeholder = "One entry per line.";
      textarea.disabled = disabled;
      textarea.addEventListener("input", (event) => {
        const raw = (event.target as HTMLTextAreaElement).value;
        const values = raw
          .split(/\r?\n/g)
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        applyValue(values as unknown as StudioJsonValue);
      });
    }
  }

  private renderUnknownKeysEditor(
    node: StudioNodeInstance,
    definition: StudioNodeDefinition,
    fieldErrors: Map<string, HTMLElement>,
    onValidationRefresh: () => void
  ): void {
    if (!this.bodyEl) {
      return;
    }

    const fieldKey = "__advanced_unknown_json";
    const container = this.bodyEl.createDiv({ cls: "ss-studio-node-inspector-advanced" });
    container.createDiv({
      cls: "ss-studio-node-inspector-field-label",
      text: "Advanced JSON (Unknown Keys)",
    });

    const textarea = container.createEl("textarea", {
      cls: "ss-studio-node-inspector-textarea is-monospace",
    });
    const unknown = getUnknownNodeConfigKeys(definition, node.config);
    textarea.value = JSON.stringify(unknown, null, 2);
    textarea.disabled = this.host.isBusy();
    textarea.addEventListener("input", (event) => {
      const raw = (event.target as HTMLTextAreaElement).value.trim();
      if (!raw) {
        node.config = rebuildConfigWithUnknownKeys(definition, node.config, {});
        this.setTransientFieldError(node.id, fieldKey, null);
        this.host.onConfigMutated(node);
        onValidationRefresh();
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed)) {
          this.setTransientFieldError(node.id, fieldKey, "Must be a JSON object.");
          onValidationRefresh();
          return;
        }
        node.config = rebuildConfigWithUnknownKeys(
          definition,
          node.config,
          parsed as Record<string, StudioJsonValue>
        );
        this.setTransientFieldError(node.id, fieldKey, null);
        this.host.onConfigMutated(node);
        onValidationRefresh();
      } catch {
        this.setTransientFieldError(node.id, fieldKey, "Invalid JSON.");
        onValidationRefresh();
      }
    });

    const errorEl = container.createDiv({ cls: "ss-studio-node-inspector-field-error" });
    fieldErrors.set(fieldKey, errorEl);
  }

  private refreshFieldValidationState(
    node: StudioNodeInstance,
    definition: StudioNodeDefinition,
    fieldErrors: Map<string, HTMLElement>
  ): void {
    if (!this.statusEl) {
      return;
    }

    const validation = validateNodeConfig(definition, node.config);
    const validationByField = new Map<string, string>();
    for (const error of validation.errors) {
      if (!validationByField.has(error.fieldKey)) {
        validationByField.set(error.fieldKey, error.message);
      }
    }

    let hasError = false;
    for (const [fieldKey, errorEl] of fieldErrors.entries()) {
      const message = this.transientFieldErrors.get(fieldKey) || validationByField.get(fieldKey) || "";
      errorEl.setText(message);
      errorEl.classList.toggle("is-visible", message.length > 0);
      if (message.length > 0) {
        hasError = true;
      }
    }

    this.statusEl.setText(hasError ? "Fix validation errors before running this scope." : "");
    this.statusEl.classList.toggle("is-error", hasError);
  }

  private setTransientFieldError(nodeId: string, fieldKey: string, message: string | null): void {
    const normalized = String(message || "").trim();
    if (normalized.length === 0) {
      if (this.transientFieldErrors.delete(fieldKey)) {
        this.host.onTransientFieldError(nodeId, fieldKey, null);
      }
      return;
    }
    this.transientFieldErrors.set(fieldKey, normalized);
    this.host.onTransientFieldError(nodeId, fieldKey, normalized);
  }

  private clearAllTransientErrors(): void {
    if (!this.activeNodeId || this.transientFieldErrors.size === 0) {
      this.transientFieldErrors.clear();
      return;
    }
    for (const fieldKey of this.transientFieldErrors.keys()) {
      this.host.onTransientFieldError(this.activeNodeId, fieldKey, null);
    }
    this.transientFieldErrors.clear();
  }
}
