import type {
  StudioJsonValue,
  StudioNodeConfigFieldDefinition,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioNodeOutputMap,
} from "../../studio/types";
import {
  getUnknownNodeConfigKeys,
  mergeNodeConfigWithDefaults,
  rebuildConfigWithUnknownKeys,
  validateNodeConfig,
} from "../../studio/StudioNodeConfigValidation";
import { isRecord } from "../../studio/utils";
import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";

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

function sanitizePath(path: string): string {
  return String(path || "").trim();
}

function parentDirectory(path: string): string {
  const cleaned = String(path || "").replace(/[\\/]+$/g, "");
  const slashIndex = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  if (slashIndex < 0) {
    return "";
  }
  if (slashIndex === 0) {
    return cleaned[0] === "/" ? "/" : "";
  }
  return cleaned.slice(0, slashIndex);
}

function resolvePickedFilePath(file: File | null, fallbackValue?: string): string {
  if (!file) {
    const fallback = String(fallbackValue || "").trim();
    return fallback.replace(/\\/g, "/").includes("/fakepath/") ? "" : fallback;
  }
  const candidate = (file as unknown as { path?: unknown }).path;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return sanitizePath(candidate);
  }
  const fallback = String(fallbackValue || "").trim();
  if (!fallback || fallback.replace(/\\/g, "/").includes("/fakepath/")) {
    return "";
  }
  return fallback;
}

function resolvePickedDirectoryPath(file: File | null, fallbackValue?: string): string {
  const filePath = resolvePickedFilePath(file, fallbackValue);
  if (!filePath) {
    return "";
  }

  const webkitRelativePath =
    typeof (file as unknown as { webkitRelativePath?: unknown })?.webkitRelativePath === "string"
      ? String((file as unknown as { webkitRelativePath?: string }).webkitRelativePath)
      : "";
  if (!webkitRelativePath) {
    return parentDirectory(filePath);
  }

  const relativeParts = webkitRelativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
  if (relativeParts.length === 0) {
    return parentDirectory(filePath);
  }

  let result = filePath;
  for (let i = 0; i < relativeParts.length; i += 1) {
    result = parentDirectory(result);
  }
  return result || parentDirectory(filePath);
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
    const refreshValidation = (): void => {
      this.refreshFieldValidationState(node, definition, fieldErrors);
    };

    for (const field of definition.configSchema.fields) {
      const wrapper = this.bodyEl.createDiv({ cls: "ss-studio-node-inspector-field" });
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

  private resolveElectronDialogRuntime():
    | {
        dialog: {
          showOpenDialog?: (...args: unknown[]) => Promise<{
            canceled?: unknown;
            filePaths?: unknown;
          }>;
          showOpenDialogSync?: (...args: unknown[]) => unknown;
        };
        BrowserWindow?: {
          getFocusedWindow?: () => unknown;
        };
      }
    | null {
    const candidates = [
      (globalThis as unknown as { require?: unknown })?.require,
      (globalThis as unknown as { window?: { require?: unknown } })?.window?.require,
    ];

    for (const runtimeRequire of candidates) {
      if (typeof runtimeRequire !== "function") {
        continue;
      }
      try {
        const electron = runtimeRequire("electron") as {
          dialog?: unknown;
          BrowserWindow?: unknown;
          remote?: { dialog?: unknown; BrowserWindow?: unknown };
        };
        const dialog =
          (electron?.dialog as {
            showOpenDialog?: (...args: unknown[]) => Promise<{
              canceled?: unknown;
              filePaths?: unknown;
            }>;
            showOpenDialogSync?: (...args: unknown[]) => unknown;
          }) ||
          (electron?.remote?.dialog as {
            showOpenDialog?: (...args: unknown[]) => Promise<{
              canceled?: unknown;
              filePaths?: unknown;
            }>;
            showOpenDialogSync?: (...args: unknown[]) => unknown;
          });
        const BrowserWindow =
          (electron?.BrowserWindow as { getFocusedWindow?: () => unknown }) ||
          (electron?.remote?.BrowserWindow as { getFocusedWindow?: () => unknown });
        if (dialog && (typeof dialog.showOpenDialog === "function" || typeof dialog.showOpenDialogSync === "function")) {
          return {
            dialog,
            BrowserWindow,
          };
        }
      } catch {
        // Continue through fallbacks.
      }
    }

    return null;
  }

  private buildMediaDialogExtensions(field: StudioNodeConfigFieldDefinition): string[] {
    const extensions = new Set<string>();
    const kinds = Array.isArray(field.mediaKinds) ? field.mediaKinds : [];

    for (const kind of kinds) {
      if (kind === "image") {
        ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"].forEach((value) => extensions.add(value));
      } else if (kind === "video") {
        ["mp4", "mov", "mkv", "webm", "avi", "m4v"].forEach((value) => extensions.add(value));
      } else if (kind === "audio") {
        ["wav", "mp3", "m4a", "ogg", "flac", "aac"].forEach((value) => extensions.add(value));
      }
    }

    if (extensions.size === 0 && typeof field.accept === "string") {
      for (const chunk of field.accept.split(",")) {
        const cleaned = chunk.trim().replace(/^[.]+/, "").toLowerCase();
        if (!cleaned || cleaned.endsWith("/*")) {
          continue;
        }
        if (/^[a-z0-9]+$/.test(cleaned)) {
          extensions.add(cleaned);
        }
      }
    }

    return Array.from(extensions);
  }

  private async browseForFieldPathViaElectronDialog(
    field: StudioNodeConfigFieldDefinition
  ): Promise<string | null> {
    const runtime = this.resolveElectronDialogRuntime();
    if (!runtime) {
      return null;
    }

    const properties = [
      field.type === "directory_path" ? "openDirectory" : "openFile",
      "dontAddToRecent",
    ];
    const options: {
      properties: string[];
      filters?: Array<{ name: string; extensions: string[] }>;
    } = {
      properties,
    };
    if (field.type === "media_path") {
      const mediaExtensions = this.buildMediaDialogExtensions(field);
      if (mediaExtensions.length > 0) {
        options.filters = [
          {
            name: "Media",
            extensions: mediaExtensions,
          },
        ];
      }
    }

    const focusedWindow =
      typeof runtime.BrowserWindow?.getFocusedWindow === "function"
        ? runtime.BrowserWindow.getFocusedWindow()
        : undefined;

    try {
      if (typeof runtime.dialog.showOpenDialogSync === "function") {
        const value = focusedWindow
          ? runtime.dialog.showOpenDialogSync(focusedWindow, options)
          : runtime.dialog.showOpenDialogSync(options);
        const paths = Array.isArray(value) ? value.map((entry) => String(entry || "").trim()) : [];
        return paths[0] || null;
      }

      if (typeof runtime.dialog.showOpenDialog === "function") {
        const result = focusedWindow
          ? await runtime.dialog.showOpenDialog(focusedWindow, options)
          : await runtime.dialog.showOpenDialog(options);
        if (result?.canceled === true) {
          return null;
        }
        const paths = Array.isArray(result?.filePaths)
          ? result.filePaths.map((entry) => String(entry || "").trim()).filter(Boolean)
          : [];
        return paths[0] || null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async browseForFieldPath(
    field: StudioNodeConfigFieldDefinition
  ): Promise<string | null> {
    const viaElectronDialog = await this.browseForFieldPathViaElectronDialog(field);
    if (viaElectronDialog) {
      return viaElectronDialog;
    }

    return await new Promise<string | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "-9999px";

      if (field.type === "directory_path") {
        (input as unknown as { webkitdirectory?: boolean }).webkitdirectory = true;
        (input as unknown as { directory?: boolean }).directory = true;
      }

      if (field.type === "media_path") {
        const kinds = Array.isArray(field.mediaKinds) ? field.mediaKinds : [];
        const accepts: string[] = kinds
          .map((kind) => {
            if (kind === "image") return "image/*";
            if (kind === "video") return "video/*";
            if (kind === "audio") return "audio/*";
            return "";
          })
          .filter((value) => value.length > 0);
        if (field.accept) {
          accepts.push(field.accept);
        }
        if (accepts.length > 0) {
          input.accept = accepts.join(",");
        }
      } else if (field.accept) {
        input.accept = field.accept;
      }

      let settled = false;
      let sawWindowBlur = false;
      const finish = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("blur", onWindowBlur, true);
        window.removeEventListener("focus", onWindowFocus, true);
        input.removeEventListener("change", onChange);
        if (input.parentElement) {
          input.parentElement.removeChild(input);
        }
        resolve(value && value.trim().length > 0 ? value : null);
      };

      const onWindowBlur = (): void => {
        sawWindowBlur = true;
      };

      const onChange = (): void => {
        const files = Array.from(input.files || []);
        if (files.length === 0) {
          finish(null);
          return;
        }
        const primary = files[0] || null;
        const path =
          field.type === "directory_path"
            ? resolvePickedDirectoryPath(primary, input.value)
            : resolvePickedFilePath(primary, input.value);
        finish(path || null);
      };

      const onWindowFocus = (): void => {
        if (!sawWindowBlur) {
          return;
        }
        window.setTimeout(() => {
          if (!settled) {
            const files = Array.from(input.files || []);
            if (files.length === 0) {
              finish(null);
            }
          }
        }, 0);
      };

      input.addEventListener("change", onChange);
      window.addEventListener("blur", onWindowBlur, true);
      window.addEventListener("focus", onWindowFocus, true);
      document.body.appendChild(input);
      input.click();
    });
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
      cls: "ss-studio-node-inspector-path-button",
      text: field.type === "directory_path" ? "Browse Folder" : "Browse",
    });
    browseButton.disabled = disabled;
    browseButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selected = await this.browseForFieldPath(field);
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
