import type { StudioNodeGroup, StudioProjectV1 } from "../../studio/types";
import { autoAlignGroupNodes } from "./graph-v3/StudioGraphGroupAutoLayout";
import {
  nextDefaultGroupName,
  normalizeGroupColor,
  renameGroup,
  setGroupColor,
} from "./graph-v3/StudioGraphGroupModel";

const NODE_WIDTH = 280;
const FALLBACK_NODE_HEIGHT = 164;
const MIN_NODE_HEIGHT = 80;
const GROUP_PADDING_X = 20;
const GROUP_PADDING_TOP = 18;
const GROUP_PADDING_BOTTOM = 32;
const GROUP_MIN_WIDTH = 180;
const GROUP_MIN_HEIGHT = 120;
const DEFAULT_GROUP_COLOR = "#8de8bc";
const GROUP_COLOR_PALETTE = [
  "#8de8bc",
  "#7be7e6",
  "#84b8ff",
  "#9ea2ff",
  "#bd99ff",
  "#e59bf6",
  "#ff9ec9",
  "#ffad93",
  "#ffc27a",
  "#ffda8a",
  "#dbe66e",
  "#97d96b",
  "#66d9a4",
  "#5dd0c5",
  "#79a8ff",
  "#b0b6c8",
] as const;

type GroupBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type GroupElements = {
  frameEl: HTMLElement;
  tagEl: HTMLElement;
  nameSlotEl: HTMLElement;
  nameButtonEl: HTMLButtonElement | null;
  colorChipEl: HTMLElement;
};

type StudioGraphGroupControllerHost = {
  isBusy: () => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  getGraphZoom: () => number;
  getNodeElement: (nodeId: string) => HTMLElement | null;
  notifyNodePositionsChanged: () => void;
  onNodeDragStateChange?: (isDragging: boolean) => void;
  requestRender: () => void;
  scheduleProjectSave: () => void;
};

function normalizeGroupName(value: string): string {
  return String(value || "").trim();
}

function buildNodeMap(project: StudioProjectV1): Map<string, StudioProjectV1["graph"]["nodes"][number]> {
  return new Map(project.graph.nodes.map((node) => [node.id, node] as const));
}

function resolveGroupColor(group: StudioNodeGroup): string {
  return normalizeGroupColor(group.color) || DEFAULT_GROUP_COLOR;
}

export class StudioGraphGroupController {
  private canvasEl: HTMLElement | null = null;
  private frameLayerEl: HTMLElement | null = null;
  private tagLayerEl: HTMLElement | null = null;
  private groupElsById = new Map<string, GroupElements>();
  private previewColorByGroupId = new Map<string, string>();
  private pendingNameEditGroupId: string | null = null;
  private editingGroupId: string | null = null;
  private openColorPaletteGroupId: string | null = null;
  private windowListenersBound = false;

  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (!this.openColorPaletteGroupId) {
      return;
    }
    const target = event.target as Node | null;
    if (target && this.tagLayerEl?.contains(target)) {
      return;
    }
    this.closeColorPalette();
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.openColorPaletteGroupId) {
      return;
    }
    this.closeColorPalette();
  };

  constructor(private readonly host: StudioGraphGroupControllerHost) {}

  registerCanvasElement(canvas: HTMLElement): void {
    this.canvasEl = canvas;
    this.bindWindowListeners();
    const frameLayerAttached = this.frameLayerEl && this.frameLayerEl.parentElement === canvas;
    const tagLayerAttached = this.tagLayerEl && this.tagLayerEl.parentElement === canvas;
    if (!frameLayerAttached || !tagLayerAttached) {
      this.frameLayerEl?.remove();
      this.tagLayerEl?.remove();
      this.frameLayerEl = canvas.createDiv({ cls: "ss-studio-groups-layer" });
      this.tagLayerEl = canvas.createDiv({ cls: "ss-studio-group-tags-layer" });
    }
  }

  clearRenderBindings(): void {
    this.groupElsById.clear();
    this.previewColorByGroupId.clear();
    this.editingGroupId = null;
    this.openColorPaletteGroupId = null;
    if (this.frameLayerEl?.parentElement) {
      this.frameLayerEl.parentElement.removeChild(this.frameLayerEl);
    }
    if (this.tagLayerEl?.parentElement) {
      this.tagLayerEl.parentElement.removeChild(this.tagLayerEl);
    }
    this.frameLayerEl = null;
    this.tagLayerEl = null;
    this.canvasEl = null;
    this.unbindWindowListeners();
  }

  renderGroupLayer(): void {
    if (!this.frameLayerEl || !this.tagLayerEl) {
      return;
    }

    this.frameLayerEl.empty();
    this.tagLayerEl.empty();
    this.groupElsById.clear();
    this.editingGroupId = null;

    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    const nodeMap = buildNodeMap(project);
    const groups = (project.graph.groups || []).filter((group) =>
      group.nodeIds.some((nodeId) => nodeMap.has(nodeId))
    );
    const visibleGroupIds = new Set(groups.map((group) => group.id));
    if (this.openColorPaletteGroupId && !visibleGroupIds.has(this.openColorPaletteGroupId)) {
      this.openColorPaletteGroupId = null;
      this.previewColorByGroupId.clear();
    }

    for (const group of groups) {
      const frameEl = this.frameLayerEl.createDiv({ cls: "ss-studio-group-frame" });
      frameEl.dataset.groupId = group.id;
      frameEl.style.setProperty("--ss-studio-group-accent", this.resolveDisplayedGroupColor(group));
      frameEl.addEventListener("pointerdown", (event) => {
        this.startGroupDrag(group.id, event as PointerEvent, frameEl);
      });

      const tagEl = this.tagLayerEl.createDiv({ cls: "ss-studio-group-tag" });
      tagEl.dataset.groupId = group.id;
      const tagRowEl = tagEl.createDiv({ cls: "ss-studio-group-tag-row" });

      const nameSlotEl = tagRowEl.createDiv({ cls: "ss-studio-group-tag-name-slot" });
      const nameButtonEl = nameSlotEl.createEl("button", {
        cls: "ss-studio-group-tag-button",
        text: normalizeGroupName(group.name) || nextDefaultGroupName(project),
      });
      nameButtonEl.type = "button";
      nameButtonEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      nameButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.startGroupNameEdit(group.id, { selectText: true });
      });
      nameButtonEl.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.startGroupNameEdit(group.id, { selectText: true });
      });

      const alignButtonEl = tagRowEl.createEl("button", {
        cls: "ss-studio-group-tag-action ss-studio-group-align-button",
        text: "Align",
        attr: {
          "aria-label": "Auto-align group nodes",
          title: "Auto-align group nodes",
        },
      });
      alignButtonEl.type = "button";
      alignButtonEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      alignButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.alignGroup(group.id);
      });

      const colorButtonEl = tagRowEl.createEl("button", {
        cls: "ss-studio-group-tag-action ss-studio-group-color-button",
        attr: {
          "aria-label": "Choose group color",
          title: "Choose group color",
        },
      });
      colorButtonEl.type = "button";
      const colorChipEl = document.createElement("span");
      colorChipEl.className = "ss-studio-group-color-chip";
      colorButtonEl.appendChild(colorChipEl);
      colorButtonEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      colorButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleColorPalette(group.id);
      });

      if (this.openColorPaletteGroupId === group.id) {
        this.renderColorPalette(tagEl, group);
      }

      this.groupElsById.set(group.id, {
        frameEl,
        tagEl,
        nameSlotEl,
        nameButtonEl,
        colorChipEl,
      });
    }

    this.refreshGroupBounds();

    if (this.pendingNameEditGroupId) {
      const pendingId = this.pendingNameEditGroupId;
      this.pendingNameEditGroupId = null;
      this.startGroupNameEdit(pendingId, { selectText: true });
    }
  }

  refreshGroupBounds(): void {
    const project = this.host.getCurrentProject();
    if (!project || !this.frameLayerEl || !this.tagLayerEl) {
      return;
    }

    const nodeMap = buildNodeMap(project);
    for (const group of project.graph.groups || []) {
      const elements = this.groupElsById.get(group.id);
      if (!elements) {
        continue;
      }
      const bounds = this.computeGroupBounds(group, nodeMap);
      if (!bounds) {
        elements.frameEl.style.display = "none";
        elements.tagEl.style.display = "none";
        continue;
      }
      elements.frameEl.style.display = "";
      elements.tagEl.style.display = "";
      elements.frameEl.style.left = `${bounds.left}px`;
      elements.frameEl.style.top = `${bounds.top}px`;
      elements.frameEl.style.width = `${bounds.width}px`;
      elements.frameEl.style.height = `${bounds.height}px`;
      elements.tagEl.style.left = `${bounds.left + bounds.width / 2}px`;
      elements.tagEl.style.top = `${bounds.top + bounds.height}px`;
      const displayedColor = this.resolveDisplayedGroupColor(group);
      elements.frameEl.style.setProperty("--ss-studio-group-accent", displayedColor);
      elements.colorChipEl.style.background = displayedColor;

      if (this.editingGroupId !== group.id && elements.nameButtonEl) {
        elements.nameButtonEl.setText(normalizeGroupName(group.name) || nextDefaultGroupName(project));
      }
    }
  }

  requestGroupNameEdit(groupId: string): void {
    const normalizedGroupId = String(groupId || "").trim();
    if (!normalizedGroupId) {
      return;
    }
    this.pendingNameEditGroupId = normalizedGroupId;
    this.startGroupNameEdit(normalizedGroupId, { selectText: true });
  }

  private bindWindowListeners(): void {
    if (this.windowListenersBound) {
      return;
    }
    window.addEventListener("pointerdown", this.onWindowPointerDown);
    window.addEventListener("keydown", this.onWindowKeyDown);
    this.windowListenersBound = true;
  }

  private unbindWindowListeners(): void {
    if (!this.windowListenersBound) {
      return;
    }
    window.removeEventListener("pointerdown", this.onWindowPointerDown);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.windowListenersBound = false;
  }

  private toggleColorPalette(groupId: string): void {
    const normalizedGroupId = String(groupId || "").trim();
    if (!normalizedGroupId) {
      return;
    }
    if (this.openColorPaletteGroupId === normalizedGroupId) {
      this.closeColorPalette();
      return;
    } else {
      this.openColorPaletteGroupId = normalizedGroupId;
      this.previewColorByGroupId.delete(normalizedGroupId);
    }
    this.renderGroupLayer();
  }

  private renderColorPalette(tagEl: HTMLElement, group: StudioNodeGroup): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    const paletteEl = tagEl.createDiv({ cls: "ss-studio-group-color-palette" });
    paletteEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    paletteEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const selectedColor = resolveGroupColor(group);
    for (const swatchColor of GROUP_COLOR_PALETTE) {
      const swatchEl = paletteEl.createEl("button", {
        cls: "ss-studio-group-color-swatch",
        attr: {
          type: "button",
          "aria-label": `Set group color ${swatchColor}`,
          title: swatchColor,
        },
      });
      swatchEl.style.background = swatchColor;
      swatchEl.classList.toggle("is-active", swatchColor === selectedColor);
      swatchEl.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      swatchEl.addEventListener("pointerenter", () => {
        this.setGroupPreviewColor(group.id, swatchColor);
      });
      swatchEl.addEventListener("pointerleave", () => {
        this.setGroupPreviewColor(group.id, null);
      });
      swatchEl.addEventListener("focus", () => {
        this.setGroupPreviewColor(group.id, swatchColor);
      });
      swatchEl.addEventListener("blur", () => {
        this.setGroupPreviewColor(group.id, null);
      });
      swatchEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const changed = setGroupColor(project, group.id, swatchColor);
        this.openColorPaletteGroupId = null;
        this.previewColorByGroupId.delete(group.id);
        if (changed) {
          this.host.scheduleProjectSave();
        }
        this.renderGroupLayer();
      });
    }
  }

  private closeColorPalette(): void {
    if (!this.openColorPaletteGroupId && this.previewColorByGroupId.size === 0) {
      return;
    }
    this.openColorPaletteGroupId = null;
    this.previewColorByGroupId.clear();
    this.renderGroupLayer();
  }

  private resolveDisplayedGroupColor(group: StudioNodeGroup): string {
    return this.previewColorByGroupId.get(group.id) || resolveGroupColor(group);
  }

  private setGroupPreviewColor(groupId: string, color: string | null): void {
    const normalizedGroupId = String(groupId || "").trim();
    if (!normalizedGroupId) {
      return;
    }
    if (!color) {
      this.previewColorByGroupId.delete(normalizedGroupId);
    } else {
      this.previewColorByGroupId.set(normalizedGroupId, color);
    }
    this.refreshRenderedGroupAccent(normalizedGroupId);
  }

  private refreshRenderedGroupAccent(groupId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }
    const group = (project.graph.groups || []).find((entry) => entry.id === groupId);
    const elements = this.groupElsById.get(groupId);
    if (!group || !elements) {
      return;
    }
    const displayedColor = this.resolveDisplayedGroupColor(group);
    elements.frameEl.style.setProperty("--ss-studio-group-accent", displayedColor);
    elements.colorChipEl.style.background = displayedColor;
  }

  private alignGroup(groupId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    const result = autoAlignGroupNodes(project, groupId, {
      getNodeHeight: (nodeId) => {
        const nodeEl = this.host.getNodeElement(nodeId);
        if (!nodeEl) {
          return null;
        }
        return Math.max(MIN_NODE_HEIGHT, nodeEl.offsetHeight || FALLBACK_NODE_HEIGHT);
      },
    });
    if (!result.changed) {
      return;
    }

    const nodeMap = buildNodeMap(project);
    for (const nodeId of result.movedNodeIds) {
      const node = nodeMap.get(nodeId);
      const nodeEl = this.host.getNodeElement(nodeId);
      if (!node || !nodeEl) {
        continue;
      }
      nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
    }
    this.host.notifyNodePositionsChanged();
    this.host.scheduleProjectSave();
  }

  private startGroupDrag(groupId: string, startEvent: PointerEvent, dragSurfaceEl: HTMLElement): void {
    if (this.host.isBusy() || startEvent.button !== 0) {
      return;
    }

    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }
    const group = (project.graph.groups || []).find((entry) => entry.id === groupId);
    if (!group) {
      return;
    }

    const nodeMap = buildNodeMap(project);
    const dragNodes = group.nodeIds
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is StudioProjectV1["graph"]["nodes"][number] => Boolean(node));
    if (dragNodes.length === 0) {
      return;
    }

    startEvent.preventDefault();
    startEvent.stopPropagation();

    const pointerId = startEvent.pointerId;
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    const zoom = this.host.getGraphZoom() || 1;
    const originByNodeId = new Map(
      dragNodes.map((node) => [
        node.id,
        {
          x: node.position.x,
          y: node.position.y,
        },
      ] as const)
    );
    let dragged = false;

    if (typeof dragSurfaceEl.setPointerCapture === "function") {
      try {
        dragSurfaceEl.setPointerCapture(pointerId);
      } catch {
        // Pointer capture can fail in some environments.
      }
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const travel = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragged && travel > 3) {
        dragged = true;
        dragSurfaceEl.classList.add("is-dragging");
        this.host.onNodeDragStateChange?.(true);
      }
      if (!dragged) {
        return;
      }

      const deltaX = (moveEvent.clientX - startX) / zoom;
      const deltaY = (moveEvent.clientY - startY) / zoom;
      for (const node of dragNodes) {
        const origin = originByNodeId.get(node.id);
        if (!origin) {
          continue;
        }
        node.position.x = Math.max(24, Math.round(origin.x + deltaX));
        node.position.y = Math.max(24, Math.round(origin.y + deltaY));
        const nodeEl = this.host.getNodeElement(node.id);
        if (nodeEl) {
          nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
        }
      }
      this.host.notifyNodePositionsChanged();
    };

    const finishDrag = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);

      if (typeof dragSurfaceEl.releasePointerCapture === "function") {
        try {
          dragSurfaceEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore release failures.
        }
      }

      dragSurfaceEl.classList.remove("is-dragging");
      if (!dragged) {
        return;
      }
      this.host.onNodeDragStateChange?.(false);
      this.host.scheduleProjectSave();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }

  private computeGroupBounds(
    group: StudioNodeGroup,
    nodeMap: Map<string, StudioProjectV1["graph"]["nodes"][number]>
  ): GroupBounds | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const nodeId of group.nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        continue;
      }
      const nodeEl = this.host.getNodeElement(nodeId);
      const nodeHeight = Math.max(MIN_NODE_HEIGHT, nodeEl?.offsetHeight || FALLBACK_NODE_HEIGHT);

      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.position.y + nodeHeight);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    const left = minX - GROUP_PADDING_X;
    const top = minY - GROUP_PADDING_TOP;
    const width = Math.max(GROUP_MIN_WIDTH, maxX - minX + GROUP_PADDING_X * 2);
    const height = Math.max(GROUP_MIN_HEIGHT, maxY - minY + GROUP_PADDING_TOP + GROUP_PADDING_BOTTOM);

    return { left, top, width, height };
  }

  private startGroupNameEdit(groupId: string, options?: { selectText?: boolean }): void {
    const normalizedGroupId = String(groupId || "").trim();
    if (!normalizedGroupId) {
      return;
    }

    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }
    const group = (project.graph.groups || []).find((entry) => entry.id === normalizedGroupId);
    const elements = this.groupElsById.get(normalizedGroupId);
    if (!group || !elements) {
      return;
    }

    const currentEditingId = this.editingGroupId;
    if (currentEditingId && currentEditingId !== normalizedGroupId) {
      this.host.requestRender();
      return;
    }
    if (currentEditingId === normalizedGroupId) {
      return;
    }

    this.openColorPaletteGroupId = null;
    this.previewColorByGroupId.delete(normalizedGroupId);
    this.editingGroupId = normalizedGroupId;
    elements.nameSlotEl.empty();
    elements.nameButtonEl = null;
    const inputEl = elements.nameSlotEl.createEl("input", {
      cls: "ss-studio-group-tag-input",
      type: "text",
      attr: {
        "aria-label": "Group name",
      },
    });
    inputEl.value = normalizeGroupName(group.name) || nextDefaultGroupName(project);
    inputEl.spellcheck = false;
    inputEl.autocomplete = "off";

    let finalized = false;
    const finalize = (mode: "commit" | "cancel"): void => {
      if (finalized) {
        return;
      }
      finalized = true;

      if (mode === "commit") {
        const fallbackName = normalizeGroupName(group.name) || nextDefaultGroupName(project);
        const nextName = normalizeGroupName(inputEl.value) || fallbackName;
        const changed = renameGroup(project, group.id, nextName);
        if (changed) {
          this.host.scheduleProjectSave();
        }
      }

      this.editingGroupId = null;
      this.host.requestRender();
    };

    inputEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    inputEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finalize("commit");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finalize("cancel");
      }
    });
    inputEl.addEventListener("blur", () => {
      finalize("commit");
    });

    window.requestAnimationFrame(() => {
      try {
        inputEl.focus({ preventScroll: true });
      } catch {
        inputEl.focus();
      }
      if (options?.selectText) {
        inputEl.select();
      }
    });
  }
}
