import { App, Notice, Platform, setIcon, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import YAML from "yaml";
import type SystemSculptPlugin from "../../main";
import {
  findCanvasNodeContentHost,
  findCanvasNodeElements,
  findCanvasNodeElementsFromInternalCanvas,
  trySetInternalCanvasNodeSize,
} from "./CanvasDomAdapter";
import {
  addEdge,
  addFileNode,
  computeNextNodePosition,
  indexCanvas,
  isCanvasFileNode,
  isImagePath,
  parseCanvasDocument,
  serializeCanvasDocument,
} from "./CanvasFlowGraph";
import {
  parseCanvasFlowPromptNote,
  parseMarkdownFrontmatter,
  replaceMarkdownFrontmatterAndBody,
  type CanvasFlowPromptConfig,
} from "./PromptNote";
import { CanvasFlowRunner } from "./CanvasFlowRunner";
import { sanitizeChatTitle } from "../../utils/titleUtils";
import {
  CANVASFLOW_PROMPT_NODE_CSS_VAR_HEIGHT,
  CANVASFLOW_PROMPT_NODE_CSS_VAR_WIDTH,
  CANVASFLOW_PROMPT_NODE_HEIGHT_PX,
  CANVASFLOW_PROMPT_NODE_WIDTH_PX,
} from "./CanvasFlowUiConstants";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatCuratedImageModelOptionText,
  getDefaultImageAspectRatio,
  getCuratedImageGenerationModel,
  getCuratedImageGenerationModelGroups,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";
import { tryCopyImageFileToClipboard } from "../../utils/clipboard";
import {
  findCanvasSelectionMenu,
  getSelectedNodeIdsFromDom,
  getSelectedNodeIdsFromInternalCanvas,
} from "./CanvasFlowSelectionMenuHelpers";
import {
  deriveCanvasFlowPromptUiDefaults,
  syncCanvasFlowAspectRatioPresetControls,
} from "./CanvasFlowPromptNodeState";

type PromptCacheEntry = {
  mtime: number;
  body: string;
  frontmatter: Record<string, unknown>;
  config: CanvasFlowPromptConfig;
};

type LeafController = {
  leaf: WorkspaceLeaf;
  observer: MutationObserver;
  updating: boolean;
  pending: boolean;
  selectionMenuUpdateQueued: boolean;
  canvasFilePath: string | null;
  canvasFileMtime: number;
  cachedCanvasDoc: ReturnType<typeof parseCanvasDocument> | null;
  promptFileCache: Map<string, PromptCacheEntry>;
  normalizedInternalNodeSizes: Set<string>;
  pendingFocusNodeId: string | null;
  pendingFocusAttempts: number;
};

const CANVASFLOW_PROMPT_UI_VERSION = "4";

function isCanvasLeaf(leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf {
  if (!leaf) return false;
  const vt = (leaf.view as any)?.getViewType?.();
  return vt === "canvas";
}

function stopEvent(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

function stopPropagationOnly(e: Event): void {
  e.stopPropagation();
}

function formatImageModelBadge(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): { text: string; title: string } {
  const id = String(modelId || "").trim();
  if (!id) {
    return { text: "(no model)", title: "" };
  }

  const curated = getCuratedImageGenerationModel(id, serverModels);
  if (!curated) {
    return { text: id, title: id };
  }

  return { text: curated.label, title: curated.id };
}

export class CanvasFlowEnhancer {
  private readonly controllers = new Map<WorkspaceLeaf, LeafController>();
  private readonly runner: CanvasFlowRunner;
  private runningNodeKeys = new Set<string>();
  private creatingFromImageKeys = new Set<string>();
  private copyingImageKeys = new Set<string>();
  private workspaceEventRefs: any[] = [];

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin
  ) {
    this.runner = new CanvasFlowRunner(app, plugin);
  }

  start(): void {
    if (!Platform.isDesktopApp) {
      return;
    }

    // Attach to existing canvas leaves.
    this.attachAllCanvasLeaves();

    // Keep attaching as the user opens new canvases.
    this.workspaceEventRefs.push(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || !isCanvasLeaf(leaf)) return;
        this.attachLeaf(leaf);
      })
    );

    this.workspaceEventRefs.push(
      this.app.workspace.on("layout-change", () => {
        this.attachAllCanvasLeaves();
      })
    );
  }

  stop(): void {
    for (const ref of this.workspaceEventRefs) {
      try {
        this.app.workspace.offref(ref);
      } catch {}
    }
    this.workspaceEventRefs = [];

    for (const controller of this.controllers.values()) {
      try {
        controller.observer.disconnect();
      } catch {}
      try {
        this.removeInjectedControls(controller.leaf);
      } catch {}
    }
    this.controllers.clear();
    this.runningNodeKeys = new Set();
    this.creatingFromImageKeys = new Set();
    this.copyingImageKeys = new Set();
  }

  async runPromptNode(options: {
    canvasFile: TFile;
    promptNodeId: string;
    status?: (status: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.runner.runPromptNode(options);
  }

  private attachAllCanvasLeaves(): void {
    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      this.attachLeaf(leaf);
    }
  }

  private attachLeaf(leaf: WorkspaceLeaf): void {
    if (this.controllers.has(leaf)) {
      return;
    }

    const root = (leaf.view as any)?.containerEl as HTMLElement | null;
    if (!root) {
      return;
    }

    const controller: LeafController = {
      leaf,
      observer: new MutationObserver((records) => {
        if (this.isSelectionOnlyMutation(records)) {
          this.scheduleSelectionMenuUpdate(controller);
          return;
        }
        if (!this.shouldScheduleUpdateFromMutations(records)) {
          return;
        }
        this.scheduleUpdate(controller);
      }),
      updating: false,
      pending: false,
      selectionMenuUpdateQueued: false,
      canvasFilePath: null,
      canvasFileMtime: 0,
      cachedCanvasDoc: null,
      promptFileCache: new Map(),
      normalizedInternalNodeSizes: new Set(),
      pendingFocusNodeId: null,
      pendingFocusAttempts: 0,
    };

    // Canvas selection changes are often reflected as class toggles (e.g. `.is-selected`),
    // not DOM insertions/removals. Observe class attribute changes so we can update the
    // injected selection-toolbar Run button when the user selects a node.
    controller.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    this.controllers.set(leaf, controller);

    // Initial pass.
    this.scheduleUpdate(controller);
  }

  private scheduleUpdate(controller: LeafController): void {
    if (controller.updating) {
      controller.pending = true;
      return;
    }
    controller.updating = true;
    // Run async without blocking the mutation observer callback.
    setTimeout(() => {
      void this.updateLeaf(controller).finally(() => {
        controller.updating = false;
        if (controller.pending) {
          controller.pending = false;
          this.scheduleUpdate(controller);
        }
      });
    }, 100);
  }

  private isSelectionOnlyMutation(records: MutationRecord[]): boolean {
    if (!records.length) return false;
    for (const record of records) {
      if (record.type !== "attributes" || record.attributeName !== "class") {
        return false;
      }
      const targetEl = this.nodeToElement(record.target);
      if (!targetEl) {
        return false;
      }
      const isCanvasSelectionClassToggle =
        targetEl.classList.contains("canvas-node") ||
        targetEl.classList.contains("canvas-node-container") ||
        targetEl.closest(".canvas-node, .canvas-node-container") !== null;
      if (!isCanvasSelectionClassToggle) {
        return false;
      }
    }
    return true;
  }

  private scheduleSelectionMenuUpdate(controller: LeafController): void {
    if (controller.selectionMenuUpdateQueued) return;
    controller.selectionMenuUpdateQueued = true;
    window.setTimeout(() => {
      controller.selectionMenuUpdateQueued = false;
      void this.updateSelectionMenuButtonsOnly(controller);
    }, 0);
  }

  private async updateSelectionMenuButtonsOnly(controller: LeafController): Promise<void> {
    if (this.plugin.settings.canvasFlowEnabled !== true) {
      return;
    }

    const root = (controller.leaf.view as any)?.containerEl as HTMLElement | null;
    if (!root) return;

    const canvasFile = ((controller.leaf.view as any)?.file as TFile | undefined) || null;
    if (!canvasFile) return;

    const canvasMtime = canvasFile.stat?.mtime ?? 0;
    const pathChanged = controller.canvasFilePath !== canvasFile.path;
    if (pathChanged || controller.canvasFileMtime !== canvasMtime || !controller.cachedCanvasDoc) {
      this.scheduleUpdate(controller);
      return;
    }

    const { nodesById } = indexCanvas(controller.cachedCanvasDoc);
    await this.ensureSelectionMenuButtons({
      controller,
      root,
      canvasFile,
      nodesById,
    });
  }

  private shouldScheduleUpdateFromMutations(records: MutationRecord[]): boolean {
    if (!records.length) return false;
    for (const record of records) {
      if (this.isMutationInsideCanvasFlowOwnedUi(record)) continue;
      if (this.isRelevantCanvasMutation(record)) return true;
    }
    return false;
  }

  private isRelevantCanvasMutation(record: MutationRecord): boolean {
    if (record.type === "attributes") {
      const targetEl = this.nodeToElement(record.target);
      if (!targetEl) return false;
      return this.isCanvasMutationRelevantElement(targetEl);
    }

    if (record.type === "childList") {
      const targetEl = this.nodeToElement(record.target);
      if (targetEl && this.isCanvasMutationRelevantElement(targetEl)) {
        return true;
      }

      for (const node of Array.from(record.addedNodes)) {
        if (this.isRelevantCanvasMutationNode(node)) return true;
      }
      for (const node of Array.from(record.removedNodes)) {
        if (this.isRelevantCanvasMutationNode(node)) return true;
      }
    }

    return false;
  }

  private isRelevantCanvasMutationNode(node: Node): boolean {
    const el = this.nodeToElement(node);
    if (!el) return false;
    if (this.isCanvasMutationRelevantElement(el)) return true;
    try {
      return !!el.querySelector?.(".canvas-node, .canvas-menu, .canvas-menu-container");
    } catch {
      return false;
    }
  }

  private isCanvasMutationRelevantElement(el: HTMLElement): boolean {
    if (
      el.classList?.contains("canvas-node") ||
      el.classList?.contains("canvas-node-content") ||
      el.classList?.contains("canvas-node-container") ||
      el.classList?.contains("canvas-menu") ||
      el.classList?.contains("canvas-menu-container")
    ) {
      return true;
    }
    return !!el.closest(".canvas-node, .canvas-menu, .canvas-menu-container");
  }

  private isMutationInsideCanvasFlowOwnedUi(record: MutationRecord): boolean {
    if (record.type === "attributes") {
      return this.isCanvasFlowOwnedNode(record.target);
    }

    if (record.type === "childList") {
      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (changedNodes.length === 0) {
        return this.isCanvasFlowOwnedNode(record.target);
      }
      return changedNodes.every((node) => this.isCanvasFlowOwnedNode(node));
    }

    return false;
  }

  private isCanvasFlowOwnedNode(node: Node | null): boolean {
    const el = this.nodeToElement(node);
    if (!el) return false;

    if (el.classList?.contains("ss-canvasflow-controls")) return true;
    if (el.closest(".ss-canvasflow-controls")) return true;
    if (el.classList?.contains("ss-canvasflow-menu-run")) return true;
    if (el.classList?.contains("ss-canvasflow-menu-copy-image")) return true;
    if (el.classList?.contains("ss-canvasflow-menu-new-prompt")) return true;
    if (el.closest(".ss-canvasflow-menu-run, .ss-canvasflow-menu-copy-image, .ss-canvasflow-menu-new-prompt")) return true;

    return false;
  }

  private nodeToElement(node: Node | null): HTMLElement | null {
    if (!node) return null;
    const anyNode = node as any;
    if (anyNode.nodeType === 1) {
      return anyNode as HTMLElement;
    }
    return (anyNode.parentElement as HTMLElement | null) || null;
  }

  private isControlFocused(el: HTMLElement | null | undefined): boolean {
    if (!el) return false;
    const doc = el.ownerDocument;
    if (!doc) return false;
    return doc.activeElement === el;
  }

  private removeInjectedControls(leaf: WorkspaceLeaf): void {
    const root = (leaf.view as any)?.containerEl as HTMLElement | null;
    if (!root) return;
    root.querySelectorAll(".ss-canvasflow-controls").forEach((el) => el.remove());
    root.querySelectorAll(".canvas-node.ss-canvasflow-prompt-node").forEach((el) => el.classList.remove("ss-canvasflow-prompt-node"));
    // The selection menu may not be a descendant of the leaf's containerEl (some Obsidian builds append it
    // higher up in the DOM), so remove from both the view root and the document.
    root.querySelectorAll(".ss-canvasflow-menu-run").forEach((el) => el.remove());
    root.ownerDocument?.querySelectorAll?.(".ss-canvasflow-menu-run")?.forEach?.((el: any) => el?.remove?.());
    root.querySelectorAll(".ss-canvasflow-menu-copy-image").forEach((el) => el.remove());
    root.ownerDocument?.querySelectorAll?.(".ss-canvasflow-menu-copy-image")?.forEach?.((el: any) => el?.remove?.());
    root.querySelectorAll(".ss-canvasflow-menu-new-prompt").forEach((el) => el.remove());
    root.ownerDocument?.querySelectorAll?.(".ss-canvasflow-menu-new-prompt")?.forEach?.((el: any) => el?.remove?.());
  }

  private async updateLeaf(controller: LeafController): Promise<void> {
    if (this.plugin.settings.canvasFlowEnabled !== true) {
      this.removeInjectedControls(controller.leaf);
      return;
    }

    const leaf = controller.leaf;
    const root = (leaf.view as any)?.containerEl as HTMLElement | null;
    if (!root) return;

    const canvasFile = ((leaf.view as any)?.file as TFile | undefined) || null;
    if (!canvasFile) {
      return;
    }

    const canvasMtime = canvasFile.stat?.mtime ?? 0;
    const pathChanged = controller.canvasFilePath !== canvasFile.path;
    if (pathChanged || controller.canvasFileMtime !== canvasMtime) {
      if (pathChanged) {
        controller.normalizedInternalNodeSizes.clear();
      }
      controller.canvasFilePath = canvasFile.path;
      controller.canvasFileMtime = canvasMtime;
      const raw = await this.app.vault.read(canvasFile);
      controller.cachedCanvasDoc = parseCanvasDocument(raw);
    }

    const doc = controller.cachedCanvasDoc;
    if (!doc) return;
    const { nodesById } = indexCanvas(doc);

    let canvasDocDirty = false;

    const internalCanvas = (leaf.view as any)?.canvas ?? null;
    const nodeEls: Array<{ el: HTMLElement; nodeId: string }> = [];
    if (internalCanvas) {
      nodeEls.push(...findCanvasNodeElementsFromInternalCanvas(internalCanvas, root));
    }
    nodeEls.push(...findCanvasNodeElements(root));

    const seenNodeIds = new Set<string>();
    for (const { el: nodeEl, nodeId } of nodeEls) {
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const node = nodesById.get(nodeId);
      if (!node || !isCanvasFileNode(node)) continue;

      const filePath = node.file;
      if (!filePath.toLowerCase().endsWith(".md")) continue;

      const promptFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(promptFile instanceof TFile)) continue;

      const promptInfo = await this.getPromptNoteCached(controller, promptFile);
      if (!promptInfo) {
        this.removeControlsForNode(nodeEl, nodeId);
        continue;
      }

      // Keep the Canvas doc's notion of width/height aligned with our fixed-size UI.
      // Otherwise, edges/ports can render offset from the visual node (Canvas uses doc dims for layout).
      const desiredWidth = CANVASFLOW_PROMPT_NODE_WIDTH_PX;
      const desiredHeight = CANVASFLOW_PROMPT_NODE_HEIGHT_PX;

      // Best-effort: normalize internal Canvas sizing at least once per node, so connection handles/edges
      // don't render offset when we clamp the DOM.
      try {
        if (internalCanvas && !controller.normalizedInternalNodeSizes.has(nodeId)) {
          const did = trySetInternalCanvasNodeSize(internalCanvas, nodeId, desiredWidth, desiredHeight);
          if (did) {
            controller.normalizedInternalNodeSizes.add(nodeId);
          }
        }
      } catch {}

      const currentWidth = typeof node.width === "number" && Number.isFinite(node.width) ? (node.width as number) : null;
      const currentHeight = typeof node.height === "number" && Number.isFinite(node.height) ? (node.height as number) : null;
      if (currentWidth !== desiredWidth || currentHeight !== desiredHeight) {
        (node as any).width = desiredWidth;
        (node as any).height = desiredHeight;
        canvasDocDirty = true;
      }

      this.ensureControls({
        leaf,
        canvasFile,
        nodeEl,
        nodeId,
        promptFile,
        promptBody: promptInfo.body,
        promptFrontmatter: promptInfo.frontmatter,
        promptConfig: promptInfo.config,
      });
    }

    if (canvasDocDirty) {
      try {
        await this.app.vault.modify(canvasFile, serializeCanvasDocument(doc));
        controller.cachedCanvasDoc = doc;
        controller.canvasFileMtime = canvasFile.stat?.mtime ?? controller.canvasFileMtime;
      } catch {
        // Ignore; best-effort.
      }
    }

    await this.ensureSelectionMenuButtons({
      controller,
      root,
      canvasFile,
      nodesById,
    });

    this.tryFocusPendingPrompt(controller, root);
  }

  private async getPromptNoteCached(
    controller: LeafController,
    file: TFile
  ): Promise<{ body: string; frontmatter: Record<string, unknown>; config: CanvasFlowPromptConfig } | null> {
    const mtime = file.stat?.mtime ?? 0;
    const cached = controller.promptFileCache.get(file.path);
    if (cached && cached.mtime === mtime) {
      return { body: cached.body, frontmatter: cached.frontmatter, config: cached.config };
    }

    const raw = await this.app.vault.read(file);
    const parsed = parseCanvasFlowPromptNote(raw);
    if (!parsed.ok) {
      return null;
    }

    const body = String(parsed.body || "").trim();
    const entry: PromptCacheEntry = { mtime, body, frontmatter: parsed.frontmatter, config: parsed.config };
    controller.promptFileCache.set(file.path, entry);
    return { body, frontmatter: parsed.frontmatter, config: parsed.config };
  }

  private getCachedImageGenerationModels(): ImageGenerationServerCatalogModel[] {
    const raw = this.plugin.settings.imageGenerationModelCatalogCache?.models;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((model) => ({
        id: String((model as any)?.id || "").trim(),
        name: String((model as any)?.name || "").trim() || undefined,
        provider: String((model as any)?.provider || "").trim() || undefined,
        input_modalities: Array.isArray((model as any)?.input_modalities)
          ? (model as any).input_modalities.map((value: unknown) => String(value || ""))
          : undefined,
        output_modalities: Array.isArray((model as any)?.output_modalities)
          ? (model as any).output_modalities.map((value: unknown) => String(value || ""))
          : undefined,
        supports_image_input:
          typeof (model as any)?.supports_image_input === "boolean"
            ? (model as any).supports_image_input
            : undefined,
        max_images_per_job:
          typeof (model as any)?.max_images_per_job === "number" && Number.isFinite((model as any).max_images_per_job)
            ? Math.max(1, Math.floor((model as any).max_images_per_job))
            : undefined,
        default_aspect_ratio: String((model as any)?.default_aspect_ratio || "").trim() || undefined,
        allowed_aspect_ratios: Array.isArray((model as any)?.allowed_aspect_ratios)
          ? (model as any).allowed_aspect_ratios.map((value: unknown) => String(value || ""))
          : undefined,
      }))
      .filter((model) => model.id.length > 0);
  }

  private renderModelSelect(
    select: HTMLSelectElement,
    options: {
      settingsModelSlug: string;
      modelFromNote: string;
      selectedValue?: string;
    }
  ): void {
    const settingsModelSlug = String(options.settingsModelSlug || "").trim();
    const modelFromNote = String(options.modelFromNote || "").trim();
    const selectedValue = String(options.selectedValue ?? "").trim();

    const keepSelected = selectedValue || modelFromNote;
    const extras = new Set<string>();
    if (keepSelected) extras.add(keepSelected);
    if (modelFromNote) extras.add(modelFromNote);

    const serverModels = this.getCachedImageGenerationModels();
    const groups = getCuratedImageGenerationModelGroups(serverModels);
    const curatedSlugs = new Set<string>();
    for (const group of groups) {
      for (const model of group.models) {
        curatedSlugs.add(model.id);
      }
    }

    const extraSlugs = Array.from(extras.values())
      .map((s) => String(s || "").trim())
      .filter((s) => s && !curatedSlugs.has(s))
      .sort((a, b) => a.localeCompare(b));

    select.empty();
    const defaultEntry = settingsModelSlug ? getCuratedImageGenerationModel(settingsModelSlug, serverModels) : null;
    const defaultLabel = defaultEntry
      ? `(Default: ${defaultEntry.label} (${defaultEntry.id})  ${defaultEntry.pricing.summary})`
      : settingsModelSlug
        ? `(Default: ${settingsModelSlug})`
        : "(Default model)";
    select.createEl("option", { value: "", text: defaultLabel });

    for (const group of groups) {
      const optgroup = select.createEl("optgroup");
      optgroup.label = group.provider;
      for (const model of group.models) {
        optgroup.createEl("option", { value: model.id, text: formatCuratedImageModelOptionText(model) });
      }
    }

    if (extraSlugs.length) {
      const optgroup = select.createEl("optgroup");
      optgroup.label = "Custom";
      for (const slug of extraSlugs) {
        optgroup.createEl("option", { value: slug, text: slug });
      }
    }

    // Ensure selection sticks even if the chosen model isn't in the latest list.
    select.value = keepSelected || "";
  }

  private populateModelSelect(select: HTMLSelectElement, options: { settingsModelSlug: string; modelFromNote: string }): void {
    select.dataset.ssCanvasflowSettingsModelSlug = String(options.settingsModelSlug || "").trim();
    select.dataset.ssCanvasflowNoteModelSlug = String(options.modelFromNote || "").trim();

    this.renderModelSelect(select, {
      settingsModelSlug: options.settingsModelSlug,
      modelFromNote: options.modelFromNote,
      selectedValue: select.value,
    });
  }

  private ensureControls(options: {
    leaf: WorkspaceLeaf;
    canvasFile: TFile;
    nodeEl: HTMLElement;
    nodeId: string;
    promptFile: TFile;
    promptBody: string;
    promptFrontmatter: Record<string, unknown>;
    promptConfig: CanvasFlowPromptConfig;
  }): void {
    this.enforcePromptNodeSizing(options.nodeEl);

    const host = findCanvasNodeContentHost(options.nodeEl);
    const settingsModelSlug = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim();
    const modelFromNote = String(options.promptConfig.imageModelId || "").trim();
    const versionFromNote =
      options.promptConfig.seed !== null && Number.isFinite(options.promptConfig.seed)
        ? String(options.promptConfig.seed)
        : "";
    const effectiveModelSlug = modelFromNote || settingsModelSlug;
    const serverModels = this.getCachedImageGenerationModels();

    const promptUiDefaults = deriveCanvasFlowPromptUiDefaults({
      frontmatter: options.promptFrontmatter,
      promptConfig: options.promptConfig,
    });
    const imageCount = promptUiDefaults.imageCount;
    const width = promptUiDefaults.width;
    const height = promptUiDefaults.height;
    const nanoDefaults = promptUiDefaults.nanoDefaults;
    const preferredAspectRatio = promptUiDefaults.preferredAspectRatio;

    let existing = host.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(options.nodeId)}"]`);
    if (existing && existing.dataset.ssCanvasflowUiVersion !== CANVASFLOW_PROMPT_UI_VERSION) {
      try {
        existing.remove();
      } catch {}
      existing = null;
    }
    if (existing) {
      options.nodeEl.classList.add("ss-canvasflow-prompt-node");
      this.enforcePromptNodeSizing(options.nodeEl);

      const textarea = existing.querySelector<HTMLTextAreaElement>("textarea.ss-canvasflow-prompt");
      if (textarea && textarea.value !== options.promptBody && textarea !== document.activeElement) {
        textarea.value = options.promptBody;
      }

      const modelSelect = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-model");
      if (modelSelect) {
        const anySelect = modelSelect as any;
        const modelSelectFocused = this.isControlFocused(modelSelect);
        const shouldPopulateModelSelect =
          anySelect.__ssCanvasflowModelInit !== true ||
          (modelSelect.dataset.ssCanvasflowSettingsModelSlug || "") !== settingsModelSlug ||
          (modelSelect.dataset.ssCanvasflowNoteModelSlug || "") !== modelFromNote ||
          modelSelect.dataset.ssCanvasflowNeedsPopulate === "true";

        if (shouldPopulateModelSelect) {
          if (modelSelectFocused) {
            modelSelect.dataset.ssCanvasflowNeedsPopulate = "true";
          } else {
            anySelect.__ssCanvasflowModelInit = true;
            this.populateModelSelect(modelSelect, { settingsModelSlug, modelFromNote });
            delete modelSelect.dataset.ssCanvasflowNeedsPopulate;
          }
        }

        if (modelSelect.value !== modelFromNote && !modelSelectFocused) {
          modelSelect.value = modelFromNote;
        }
      }

      const versionInput = existing.querySelector<HTMLInputElement>("input.ss-canvasflow-version");
      if (versionInput && versionInput.value !== versionFromNote && versionInput !== document.activeElement) {
        versionInput.value = versionFromNote;
      }

      const modelBadge = existing.querySelector<HTMLElement>("[data-ss-canvasflow-model-badge]");
      if (modelBadge) {
        const badge = formatImageModelBadge(effectiveModelSlug, serverModels);
        modelBadge.setText(badge.text);
        modelBadge.title = badge.title;
      }

      const imageCountSelect = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-image-count");
      if (imageCountSelect && imageCountSelect.value !== String(imageCount) && imageCountSelect !== document.activeElement) {
        imageCountSelect.value = String(imageCount);
        imageCountSelect.dataset.ssCanvasflowInitial = imageCountSelect.value;
      }

      const ratioSelect = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-aspect-ratio-preset");
      const ratioHelp = existing.querySelector<HTMLElement>(".ss-canvasflow-aspect-ratio-help");
      const ratioSelectFocused = this.isControlFocused(ratioSelect);
      const selectedRatio = syncCanvasFlowAspectRatioPresetControls({
        select: ratioSelect,
        modelId: effectiveModelSlug || DEFAULT_IMAGE_GENERATION_MODEL_ID,
        preferred: preferredAspectRatio,
        helpEl: ratioHelp,
        serverModels,
        deferWhileFocused: true,
      });
      if (ratioSelect && selectedRatio && ratioSelect.value !== selectedRatio && !ratioSelectFocused) {
        ratioSelect.value = selectedRatio;
      }

      const widthInput = existing.querySelector<HTMLInputElement>("input.ss-canvasflow-width");
      const nextWidth = width !== null ? String(Math.max(1, Math.floor(width))) : "";
      if (widthInput && widthInput.value !== nextWidth && widthInput !== document.activeElement) {
        widthInput.value = nextWidth;
        widthInput.dataset.ssCanvasflowInitial = widthInput.value;
      }

      const heightInput = existing.querySelector<HTMLInputElement>("input.ss-canvasflow-height");
      const nextHeight = height !== null ? String(Math.max(1, Math.floor(height))) : "";
      if (heightInput && heightInput.value !== nextHeight && heightInput !== document.activeElement) {
        heightInput.value = nextHeight;
        heightInput.dataset.ssCanvasflowInitial = heightInput.value;
      }

      const isNano = effectiveModelSlug === "google/nano-banana-pro";
      const ratioField = existing.querySelector<HTMLElement>(".ss-canvasflow-field-aspect-ratio-preset");
      const widthField = existing.querySelector<HTMLElement>(".ss-canvasflow-field-width");
      const heightField = existing.querySelector<HTMLElement>(".ss-canvasflow-field-height");
      const nanoWrap = existing.querySelector<HTMLElement>(".ss-canvasflow-nano-config");
      if (ratioField) ratioField.style.display = isNano ? "none" : "";
      if (widthField) widthField.style.display = isNano ? "none" : "";
      if (heightField) heightField.style.display = isNano ? "none" : "";
      if (nanoWrap) {
        nanoWrap.style.display = isNano ? "" : "none";
      }

      if (isNano) {
        const aspect = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-aspect-ratio");
        if (aspect && aspect.value !== nanoDefaults.aspect_ratio) aspect.value = nanoDefaults.aspect_ratio;
        const resolution = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-resolution");
        if (resolution && resolution.value !== nanoDefaults.resolution) resolution.value = nanoDefaults.resolution;
        const format = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-output-format");
        if (format && format.value !== nanoDefaults.output_format) format.value = nanoDefaults.output_format;
        const safety = existing.querySelector<HTMLSelectElement>("select.ss-canvasflow-safety");
        if (safety && safety.value !== nanoDefaults.safety_filter_level) safety.value = nanoDefaults.safety_filter_level;
      }
      return;
    }

    options.nodeEl.classList.add("ss-canvasflow-prompt-node");
    this.enforcePromptNodeSizing(options.nodeEl);

    const controls = host.createDiv({ cls: "ss-canvasflow-controls" });
    controls.dataset.ssNodeId = options.nodeId;
    controls.dataset.ssCanvasflowUiVersion = CANVASFLOW_PROMPT_UI_VERSION;

    // Keep Canvas interactions sane.
    // Important: avoid `preventDefault()` here (it can break textarea focus/selection).
    // Stopping propagation in the bubble phase is enough to keep Canvas from starting drags on the node.
    const stopUnlessHeader = (e: Event) => {
      const target = (e.target as HTMLElement | null) || null;
      // Let Canvas handle drag interactions from our custom header (ComfyUI-style "grab handle").
      if (target?.closest?.(".ss-canvasflow-node-header")) {
        return;
      }
      stopPropagationOnly(e as any);
    };
    controls.addEventListener("pointerdown", stopUnlessHeader);
    controls.addEventListener("mousedown", stopUnlessHeader);
    controls.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        try {
          // Canvas uses wheel/trackpad scroll to pan. Only stop propagation when the user is
          // actually scrolling inside a scrollable control (e.g. a long textarea).
          // Always allow modifier-wheel (pinch/zoom) through.
          if (e.ctrlKey || e.metaKey) return;

          const target = (e.target as HTMLElement | null) || null;
          if (!target) return;

          const textarea = target.closest?.("textarea") as HTMLTextAreaElement | null;
          if (!textarea) return;

          const maxScrollTop = textarea.scrollHeight - textarea.clientHeight;
          if (maxScrollTop <= 0) return;

          const deltaY = e.deltaY || 0;
          if (!deltaY) return;

          const canScrollUp = textarea.scrollTop > 0;
          const canScrollDown = textarea.scrollTop < maxScrollTop;
          const wantsUp = deltaY < 0;
          const wantsDown = deltaY > 0;

          if ((wantsUp && canScrollUp) || (wantsDown && canScrollDown)) {
            e.stopPropagation();
          }
        } catch {
          // If our handler breaks for any reason, prefer letting Canvas handle wheel.
          return;
        }
      },
      { passive: true }
    );

    const header = controls.createDiv({ cls: "ss-canvasflow-node-header" });
    header.createDiv({ text: "SystemSculpt Prompt", cls: "ss-canvasflow-node-title" });
    const badges = header.createDiv({ cls: "ss-canvasflow-node-badges" });
    badges.createEl("code", { text: options.promptFile.basename, cls: "ss-canvasflow-node-badge" });
    const modelBadgeData = formatImageModelBadge(effectiveModelSlug, serverModels);
    const modelBadge = badges.createEl("code", { text: modelBadgeData.text, cls: "ss-canvasflow-node-badge" });
    modelBadge.title = modelBadgeData.title;
    modelBadge.dataset.ssCanvasflowModelBadge = "true";

    const fields = controls.createDiv({ cls: "ss-canvasflow-fields" });

    const readPositiveInt = (value: string): number | null => {
      const raw = String(value || "").trim();
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      const out = Math.floor(n);
      return out >= 1 ? out : null;
    };

    const roundDownToMultiple = (value: number, multiple: number): number => {
      if (!Number.isFinite(value) || value <= 0) return multiple;
      const m = Math.max(1, Math.floor(multiple));
      return Math.max(m, Math.floor(value / m) * m);
    };

    const modelField = fields.createDiv({ cls: "ss-canvasflow-field" });
    modelField.createDiv({ text: "Model (optional)", cls: "ss-canvasflow-field-label" });
    const modelSelect = modelField.createEl("select", { cls: "ss-canvasflow-model" });
    (modelSelect as any).__ssCanvasflowModelInit = true;
    this.populateModelSelect(modelSelect, { settingsModelSlug, modelFromNote });

    const versionField = fields.createDiv({ cls: "ss-canvasflow-field" });
    versionField.createDiv({ text: "Seed (optional)", cls: "ss-canvasflow-field-label" });
    const versionInput = versionField.createEl("input", { cls: "ss-canvasflow-field-input ss-canvasflow-version" });
    versionInput.type = "text";
    versionInput.value = versionFromNote;
    versionInput.placeholder = "Random if empty";

    const imageCountField = fields.createDiv({ cls: "ss-canvasflow-field" });
    imageCountField.createDiv({ text: "Images", cls: "ss-canvasflow-field-label" });
    const imageCountSelect = imageCountField.createEl("select", { cls: "ss-canvasflow-image-count" });
    for (const n of [1, 2, 3, 4]) {
      imageCountSelect.createEl("option", { value: String(n), text: String(n) });
    }
    imageCountSelect.value = String(imageCount);
    imageCountSelect.dataset.ssCanvasflowInitial = imageCountSelect.value;

    const aspectRatioField = fields.createDiv({ cls: "ss-canvasflow-field ss-canvasflow-field-aspect-ratio-preset" });
    aspectRatioField.createDiv({ text: "Aspect ratio", cls: "ss-canvasflow-field-label" });
    const aspectRatioPresetSelect = aspectRatioField.createEl("select", { cls: "ss-canvasflow-aspect-ratio-preset" });
    const aspectRatioHelp = aspectRatioField.createDiv({ cls: "ss-canvasflow-field-hint ss-canvasflow-aspect-ratio-help" });
    syncCanvasFlowAspectRatioPresetControls({
      select: aspectRatioPresetSelect,
      modelId: effectiveModelSlug || DEFAULT_IMAGE_GENERATION_MODEL_ID,
      preferred: preferredAspectRatio,
      helpEl: aspectRatioHelp,
      serverModels,
      deferWhileFocused: true,
    });

    const widthField = fields.createDiv({ cls: "ss-canvasflow-field ss-canvasflow-field-width" });
    widthField.createDiv({ text: "Width", cls: "ss-canvasflow-field-label" });
    const widthInput = widthField.createEl("input", { cls: "ss-canvasflow-field-input ss-canvasflow-width" });
    widthInput.type = "number";
    widthInput.min = "1";
    widthInput.placeholder = "Default";
    widthInput.value = width !== null ? String(Math.max(1, Math.floor(width))) : "";
    widthInput.dataset.ssCanvasflowInitial = widthInput.value;

    const heightField = fields.createDiv({ cls: "ss-canvasflow-field ss-canvasflow-field-height" });
    heightField.createDiv({ text: "Height", cls: "ss-canvasflow-field-label" });
    const heightInput = heightField.createEl("input", { cls: "ss-canvasflow-field-input ss-canvasflow-height" });
    heightInput.type = "number";
    heightInput.min = "1";
    heightInput.placeholder = "Default";
    heightInput.value = height !== null ? String(Math.max(1, Math.floor(height))) : "";
    heightInput.dataset.ssCanvasflowInitial = heightInput.value;

    controls.createDiv({ text: "Prompt", cls: "ss-canvasflow-field-label ss-canvasflow-prompt-label" });
    const textarea = controls.createEl("textarea", { cls: "ss-canvasflow-prompt" });
    textarea.value = options.promptBody;
    textarea.placeholder = "What should happen next?";

    const nanoWrap = controls.createDiv({ cls: "ss-canvasflow-nano-config" });
    nanoWrap.style.display = effectiveModelSlug === "google/nano-banana-pro" ? "" : "none";
    nanoWrap.createDiv({ text: "Nano Banana Pro", cls: "ss-canvasflow-section-title" });
    const nanoGrid = nanoWrap.createDiv({ cls: "ss-canvasflow-grid" });

    const createSelectField = (parent: HTMLElement, label: string, cls: string, values: string[], value: string) => {
      const field = parent.createDiv({ cls: "ss-canvasflow-field" });
      field.createDiv({ text: label, cls: "ss-canvasflow-field-label" });
      const select = field.createEl("select", { cls });
      for (const v of values) {
        const opt = select.createEl("option", { value: v, text: v });
        if (v === value) opt.selected = true;
      }
      return select;
    };

    const aspectRatioSelect = createSelectField(
      nanoGrid,
      "Aspect ratio",
      "ss-canvasflow-aspect-ratio",
      ["match_input_image", "9:16", "16:9", "1:1", "4:3", "3:4"],
      nanoDefaults.aspect_ratio
    );
    const resolutionSelect = createSelectField(
      nanoGrid,
      "Resolution",
      "ss-canvasflow-resolution",
      ["1080p", "2K", "4K"],
      nanoDefaults.resolution
    );
    const outputFormatSelect = createSelectField(
      nanoGrid,
      "Output format",
      "ss-canvasflow-output-format",
      ["jpg", "png", "webp"],
      nanoDefaults.output_format
    );
    const safetySelect = createSelectField(
      nanoGrid,
      "Safety filter",
      "ss-canvasflow-safety",
      ["block_only_high", "block_medium_and_above", "block_low_and_above"],
      nanoDefaults.safety_filter_level
    );

    const actions = controls.createDiv({ cls: "ss-canvasflow-actions" });
    const status = controls.createDiv({ cls: "ss-canvasflow-status" });
    status.setText("");

    const openBtn = actions.createEl("button", { text: "Open", cls: "ss-canvasflow-btn" });
    openBtn.type = "button";
    openBtn.addEventListener("click", async (e) => {
      stopEvent(e);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(options.promptFile);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    });

    const runBtn = actions.createEl("button", { text: "Run", cls: "ss-canvasflow-btn ss-canvasflow-btn-primary" });
    runBtn.type = "button";

    const setStatus = (text: string) => {
      status.setText(text);
      const lower = String(text || "").toLowerCase();
      status.classList.toggle("ss-is-error", /\b(failed|error)\b/.test(lower));
      status.classList.toggle("ss-is-success", /\bdone\b/.test(lower));
    };

    let saveTimer: number | null = null;
    let saveChain: Promise<void> = Promise.resolve();

    const getEffectiveModel = (): string => {
      const explicit = String(modelSelect.value || "").trim();
      return explicit || settingsModelSlug;
    };

    const updateModelBadgeAndVisibility = () => {
      const effective = getEffectiveModel();
      const badge = formatImageModelBadge(effective, serverModels);
      modelBadge.setText(badge.text);
      modelBadge.title = badge.title;
      const isNano = effective === "google/nano-banana-pro";
      nanoWrap.style.display = isNano ? "" : "none";
      aspectRatioField.style.display = isNano ? "none" : "";
      widthField.style.display = isNano ? "none" : "";
      heightField.style.display = isNano ? "none" : "";
      if (isNano) {
        aspectRatioHelp.setText("");
        return;
      }

      const preferred = String(aspectRatioPresetSelect.value || "").trim() || preferredAspectRatio;
      syncCanvasFlowAspectRatioPresetControls({
        select: aspectRatioPresetSelect,
        modelId: effective || DEFAULT_IMAGE_GENERATION_MODEL_ID,
        preferred,
        helpEl: aspectRatioHelp,
        serverModels,
        deferWhileFocused: true,
      });
    };

    const saveAll = async (reason: string): Promise<void> => {
      try {
        const raw = await this.app.vault.read(options.promptFile);
        const parsed = parseMarkdownFrontmatter(raw);
        if (!parsed.ok) {
          throw new Error(parsed.reason);
        }

        const nextFrontmatter: Record<string, unknown> = { ...(parsed.frontmatter || {}) };
        nextFrontmatter["ss_flow_kind"] = "prompt";
        nextFrontmatter["ss_flow_backend"] = "openrouter";

        const explicitModel = String(modelSelect.value || "").trim();
        const explicitVersion = String(versionInput.value || "").trim();
        if (explicitModel) {
          nextFrontmatter["ss_image_model"] = explicitModel;
        } else {
          delete nextFrontmatter["ss_image_model"];
        }
        const parsedSeed = explicitVersion ? Number(explicitVersion) : NaN;
        if (Number.isFinite(parsedSeed) && parsedSeed >= 0) {
          nextFrontmatter["ss_seed"] = Math.floor(parsedSeed);
        } else {
          delete nextFrontmatter["ss_seed"];
        }

        const countRaw = Number(imageCountSelect.value);
        const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(4, Math.floor(countRaw))) : 1;
        if (count > 1) {
          nextFrontmatter["ss_image_count"] = count;
        } else {
          delete nextFrontmatter["ss_image_count"];
        }

        let applySizeToImageOptions = false;
        let nextWidth: number | null = null;
        let nextHeight: number | null = null;

        const hadSizeFrontmatter =
          Object.prototype.hasOwnProperty.call(parsed.frontmatter || {}, "ss_image_width") ||
          Object.prototype.hasOwnProperty.call(parsed.frontmatter || {}, "ss_image_height");
        const initialWidthText = String(widthInput.dataset.ssCanvasflowInitial || "");
        const initialHeightText = String(heightInput.dataset.ssCanvasflowInitial || "");
        const didSizeChange = String(widthInput.value || "") !== initialWidthText || String(heightInput.value || "") !== initialHeightText;
        if (hadSizeFrontmatter || didSizeChange) {
          applySizeToImageOptions = true;
          const widthValue = readPositiveInt(widthInput.value);
          const heightValue = readPositiveInt(heightInput.value);
          const normalizedWidth = widthValue ?? heightValue;
          const normalizedHeight = heightValue ?? widthValue;
          if (normalizedWidth !== null && normalizedHeight !== null) {
            nextWidth = normalizedWidth;
            nextHeight = normalizedHeight;
            nextFrontmatter["ss_image_width"] = normalizedWidth;
            nextFrontmatter["ss_image_height"] = normalizedHeight;
          } else {
            delete nextFrontmatter["ss_image_width"];
            delete nextFrontmatter["ss_image_height"];
          }
        }

        const effectiveModel = explicitModel || settingsModelSlug || DEFAULT_IMAGE_GENERATION_MODEL_ID;
        const existingInput = readRecord(nextFrontmatter["ss_image_options"]);
        const nextInput: Record<string, unknown> = { ...existingInput };

        if (effectiveModel === "google/nano-banana-pro") {
          nextInput.aspect_ratio = aspectRatioSelect.value;
          nextInput.resolution = resolutionSelect.value;
          nextInput.output_format = outputFormatSelect.value;
          nextInput.safety_filter_level = safetySelect.value;
        } else {
          // Avoid leaking model-specific keys into other models.
          delete (nextInput as any).aspect_ratio;
          delete (nextInput as any).resolution;
          delete (nextInput as any).output_format;
          delete (nextInput as any).safety_filter_level;
        }

        if (applySizeToImageOptions) {
          if (nextWidth !== null && nextHeight !== null) {
            nextInput.width = nextWidth;
            nextInput.height = nextHeight;
          } else {
            delete (nextInput as any).width;
            delete (nextInput as any).height;
          }
        }

        nextFrontmatter["ss_image_options"] = nextInput;
        if (effectiveModel === "google/nano-banana-pro") {
          delete nextFrontmatter["ss_image_aspect_ratio"];
        } else {
          const selectedAspectRatio = String(aspectRatioPresetSelect.value || "").trim();
          const fallbackAspectRatio = getDefaultImageAspectRatio(effectiveModel);
          nextFrontmatter["ss_image_aspect_ratio"] = selectedAspectRatio || fallbackAspectRatio;
        }

        const updated = replaceMarkdownFrontmatterAndBody(raw, nextFrontmatter, textarea.value);
        if (updated !== raw) {
          await this.app.vault.modify(options.promptFile, updated);
          controllerSafeUpdateCache(this.controllers.get(options.leaf), options.promptFile.path);
          imageCountSelect.dataset.ssCanvasflowInitial = imageCountSelect.value;
          widthInput.dataset.ssCanvasflowInitial = widthInput.value;
          heightInput.dataset.ssCanvasflowInitial = heightInput.value;
        }

        if (reason === "run") {
          setStatus("Saved.");
        }
      } catch (error: any) {
        setStatus("Save failed.");
        new Notice(`SystemSculpt: failed to save prompt: ${error?.message || error}`);
      }
    };

    const enqueueSave = (reason: string): Promise<void> => {
      saveChain = saveChain.then(() => saveAll(reason));
      return saveChain;
    };

    const scheduleSave = (reason: string) => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void enqueueSave(reason);
      }, 650);
    };

    const applyAspectRatioPreset = (preset: string) => {
      const ratioText = String(preset || "").trim();
      if (!ratioText) return;

      const [wStr, hStr] = ratioText.split(":");
      const wRatio = Number(wStr);
      const hRatio = Number(hStr);
      if (!Number.isFinite(wRatio) || !Number.isFinite(hRatio) || wRatio <= 0 || hRatio <= 0) {
        return;
      }

      const currentW = readPositiveInt(widthInput.value) ?? 0;
      const currentH = readPositiveInt(heightInput.value) ?? 0;
      const baseRaw = Math.max(currentW, currentH, 1024);
      const base = roundDownToMultiple(baseRaw, 8);

      let nextW: number;
      let nextH: number;
      if (wRatio >= hRatio) {
        nextW = base;
        nextH = roundDownToMultiple((base * hRatio) / wRatio, 8);
      } else {
        nextH = base;
        nextW = roundDownToMultiple((base * wRatio) / hRatio, 8);
      }

      nextW = Math.max(64, nextW);
      nextH = Math.max(64, nextH);
      widthInput.value = String(nextW);
      heightInput.value = String(nextH);
    };

    updateModelBadgeAndVisibility();

    textarea.addEventListener("input", () => {
      scheduleSave("auto");
    });

    textarea.addEventListener("blur", () => {
      scheduleSave("blur");
    });

    modelSelect.addEventListener("change", () => {
      updateModelBadgeAndVisibility();
      scheduleSave("model");
    });
    modelSelect.addEventListener("blur", () => {
      if (modelSelect.dataset.ssCanvasflowNeedsPopulate !== "true") return;
      this.populateModelSelect(modelSelect, { settingsModelSlug, modelFromNote });
      delete modelSelect.dataset.ssCanvasflowNeedsPopulate;
      updateModelBadgeAndVisibility();
    });

    versionInput.addEventListener("input", () => {
      scheduleSave("version");
    });

    imageCountSelect.addEventListener("change", () => {
      scheduleSave("count");
    });

    aspectRatioPresetSelect.addEventListener("change", () => {
      applyAspectRatioPreset(aspectRatioPresetSelect.value);
      scheduleSave("size");
    });
    aspectRatioPresetSelect.addEventListener("blur", () => {
      if (aspectRatioPresetSelect.dataset.ssCanvasflowAspectSyncDeferred !== "true") return;
      const preferred = String(aspectRatioPresetSelect.value || "").trim() || preferredAspectRatio;
      syncCanvasFlowAspectRatioPresetControls({
        select: aspectRatioPresetSelect,
        modelId: getEffectiveModel() || DEFAULT_IMAGE_GENERATION_MODEL_ID,
        preferred,
        helpEl: aspectRatioHelp,
        serverModels,
        deferWhileFocused: true,
      });
    });

    widthInput.addEventListener("input", () => scheduleSave("size"));
    heightInput.addEventListener("input", () => scheduleSave("size"));

    aspectRatioSelect.addEventListener("change", () => scheduleSave("config"));
    resolutionSelect.addEventListener("change", () => scheduleSave("config"));
    outputFormatSelect.addEventListener("change", () => scheduleSave("config"));
    safetySelect.addEventListener("change", () => scheduleSave("config"));

    textarea.addEventListener("keydown", (e) => {
      const isModEnter = (e.key === "Enter" || e.code === "Enter") && (e.ctrlKey || e.metaKey);
      if (!isModEnter) return;
      e.preventDefault();
      void run();
    });

    const run = async (): Promise<void> => {
      const key = this.getRunKey(options.canvasFile.path, options.nodeId);
      if (this.runningNodeKeys.has(key)) {
        return;
      }

      this.runningNodeKeys.add(key);
      runBtn.disabled = true;
      runBtn.classList.add("ss-canvasflow-is-loading");
      setStatus("Saving...");
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      await enqueueSave("run");

      try {
        setStatus("Running...");
        await this.runner.runPromptNode({
          canvasFile: options.canvasFile,
          promptNodeId: options.nodeId,
          status: setStatus,
        });
      } catch (error: any) {
        setStatus(String(error?.message || error || "Run failed"));
        new Notice(`SystemSculpt run failed: ${error?.message || error}`);
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove("ss-canvasflow-is-loading");
        this.runningNodeKeys.delete(key);
      }
    };

    runBtn.addEventListener("click", (e) => {
      stopEvent(e);
      void run();
    });
  }

  private enforcePromptNodeSizing(nodeEl: HTMLElement): void {
    const widthPx = CANVASFLOW_PROMPT_NODE_WIDTH_PX;
    const heightPx = CANVASFLOW_PROMPT_NODE_HEIGHT_PX;
    const width = `${widthPx}px`;
    const height = `${heightPx}px`;

    try {
      nodeEl.style.setProperty(CANVASFLOW_PROMPT_NODE_CSS_VAR_WIDTH, width);
      nodeEl.style.setProperty(CANVASFLOW_PROMPT_NODE_CSS_VAR_HEIGHT, height);

      // Keep Obsidian Canvas rendering consistent even if internal state changes.
      nodeEl.style.width = width;
      nodeEl.style.height = height;
      nodeEl.style.minWidth = width;
      nodeEl.style.maxWidth = width;
      nodeEl.style.minHeight = height;
      nodeEl.style.maxHeight = height;
      nodeEl.style.setProperty("--canvas-node-width", width);
      nodeEl.style.setProperty("--canvas-node-height", height);
    } catch {}

    this.disablePromptNodeResizing(nodeEl);
  }

  private disablePromptNodeResizing(nodeEl: HTMLElement): void {
    const anyEl = nodeEl as any;
    if (anyEl.__ssCanvasflowResizeGuard === true) {
      return;
    }
    anyEl.__ssCanvasflowResizeGuard = true;

    const win = nodeEl.ownerDocument?.defaultView || window;
    const isResizeHandle = (el: HTMLElement): boolean => {
      const cls = String((el as any)?.className || "").toLowerCase();
      if (cls.includes("resize") || cls.includes("resizer")) return true;
      try {
        const cursor = win.getComputedStyle(el).cursor || "";
        return cursor.includes("resize");
      } catch {
        return false;
      }
    };

    const blockIfResize = (e: Event) => {
      const target = (e.target as HTMLElement | null) || null;
      if (!target) return;
      if (!nodeEl.contains(target)) return;

      let el: HTMLElement | null = target;
      while (el && el !== nodeEl) {
        if (isResizeHandle(el)) {
          try {
            (e as any).preventDefault?.();
          } catch {}
          try {
            e.stopPropagation();
          } catch {}
          return;
        }
        el = el.parentElement;
      }
    };

    // Capture phase so we beat Canvas' own handlers.
    nodeEl.addEventListener("pointerdown", blockIfResize, true);
    nodeEl.addEventListener("mousedown", blockIfResize, true);

    const hideHandles = () => {
      try {
        const all = Array.from(nodeEl.querySelectorAll<HTMLElement>("*"));
        for (const el of all) {
          if (!isResizeHandle(el)) continue;
          el.style.pointerEvents = "none";
          el.style.display = "none";
        }
      } catch {}
    };

    // Some Obsidian builds only add resize handles on selection/hover; try now and soon after.
    hideHandles();
    window.setTimeout(hideHandles, 0);
    window.setTimeout(hideHandles, 250);
  }

  private removeControlsForNode(nodeEl: HTMLElement, nodeId: string): void {
    try {
      const host = findCanvasNodeContentHost(nodeEl);
      host
        .querySelectorAll<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(nodeId)}"]`)
        .forEach((el) => el.remove());
    } catch {}
    nodeEl.classList.remove("ss-canvasflow-prompt-node");
  }

  private tryFocusPendingPrompt(controller: LeafController, root: HTMLElement): void {
    const nodeId = String(controller.pendingFocusNodeId || "").trim();
    if (!nodeId) {
      controller.pendingFocusAttempts = 0;
      return;
    }

    const textarea = root.querySelector<HTMLTextAreaElement>(
      `.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(nodeId)}"] textarea.ss-canvasflow-prompt`
    );
    if (!textarea) {
      controller.pendingFocusAttempts += 1;
      if (controller.pendingFocusAttempts > 25) {
        controller.pendingFocusNodeId = null;
        controller.pendingFocusAttempts = 0;
      }
      return;
    }

    controller.pendingFocusNodeId = null;
    controller.pendingFocusAttempts = 0;
    try {
      textarea.focus();
      // Put the caret at the end so you can start typing immediately.
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    } catch {}
  }

  private getRunKey(canvasPath: string, nodeId: string): string {
    return `${canvasPath}::${nodeId}`;
  }

  private ensureMenuRunButton(menuEl: HTMLElement): HTMLButtonElement {
    const existing = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-run");
    if (existing) {
      return existing;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clickable-icon ss-canvasflow-menu-run";
    btn.setAttribute("aria-label", "SystemSculpt - Run");
    btn.setAttribute("data-tooltip-position", "top");
    this.setMenuButtonIcon(btn, "play");

    // Append to the end so it becomes the 5th icon (after trash/palette/zoom/edit).
    menuEl.appendChild(btn);
    return btn;
  }

  private removeMenuRunButton(menuEl: HTMLElement): void {
    menuEl.querySelectorAll(".ss-canvasflow-menu-run").forEach((el) => el.remove());
  }

  private ensureMenuCopyImageButton(menuEl: HTMLElement): HTMLButtonElement {
    const existing = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-copy-image");
    const newPromptBtn = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-new-prompt");
    if (existing) {
      if (newPromptBtn && existing.nextElementSibling !== newPromptBtn) {
        menuEl.insertBefore(existing, newPromptBtn);
      }
      return existing;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clickable-icon ss-canvasflow-menu-copy-image";
    btn.setAttribute("aria-label", "SystemSculpt - Copy Image to Clipboard");
    btn.setAttribute("data-tooltip-position", "top");
    this.setMenuButtonIcon(btn, "copy");

    if (newPromptBtn) {
      menuEl.insertBefore(btn, newPromptBtn);
    } else {
      menuEl.appendChild(btn);
    }

    return btn;
  }

  private removeMenuCopyImageButton(menuEl: HTMLElement): void {
    menuEl.querySelectorAll(".ss-canvasflow-menu-copy-image").forEach((el) => el.remove());
  }

  private ensureMenuNewPromptButton(menuEl: HTMLElement): HTMLButtonElement {
    const existing = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-new-prompt");
    if (existing) {
      return existing;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clickable-icon ss-canvasflow-menu-new-prompt";
    btn.setAttribute("aria-label", "SystemSculpt - New Prompt");
    btn.setAttribute("data-tooltip-position", "top");
    this.setMenuButtonIcon(btn, "sparkles");

    // Append to the end so it becomes the 5th icon (after trash/palette/zoom/edit).
    menuEl.appendChild(btn);
    return btn;
  }

  private removeMenuNewPromptButton(menuEl: HTMLElement): void {
    menuEl.querySelectorAll(".ss-canvasflow-menu-new-prompt").forEach((el) => el.remove());
  }

  private setMenuButtonIcon(btn: HTMLElement, iconName: string): void {
    const current = String(btn.getAttribute("data-ss-canvasflow-icon") || "").trim();
    if (current === iconName) {
      return;
    }
    btn.setAttribute("data-ss-canvasflow-icon", iconName);
    setIcon(btn, iconName);
  }

  private clearSelectionMenuButtons(menuEl: HTMLElement): void {
    this.removeMenuRunButton(menuEl);
    this.removeMenuCopyImageButton(menuEl);
    this.removeMenuNewPromptButton(menuEl);
  }

  private async ensureSelectionMenuButtons(options: {
    controller: LeafController;
    root: HTMLElement;
    canvasFile: TFile;
    nodesById: Map<string, any>;
  }): Promise<void> {
    const menuEl = findCanvasSelectionMenu(options.root);
    if (!menuEl) {
      return;
    }

    const viewAny = (options.controller.leaf.view as any) || null;
    const internalSelection = getSelectedNodeIdsFromInternalCanvas(viewAny?.canvas || null);
    const selectedIds = internalSelection !== null ? internalSelection : getSelectedNodeIdsFromDom(options.root);
    if (selectedIds.length !== 1) {
      this.clearSelectionMenuButtons(menuEl);
      return;
    }

    const selectedNodeId = selectedIds[0];
    const node = options.nodesById.get(selectedNodeId);
    if (!node || !isCanvasFileNode(node)) {
      this.clearSelectionMenuButtons(menuEl);
      return;
    }

    const filePath = String(node.file || "");
    const lower = filePath.toLowerCase();

    // SystemSculpt prompt note -> show Run button.
    if (lower.endsWith(".md")) {
      this.removeMenuCopyImageButton(menuEl);
      this.removeMenuNewPromptButton(menuEl);

      const promptAbs = this.app.vault.getAbstractFileByPath(filePath);
      if (!(promptAbs instanceof TFile)) {
        this.removeMenuRunButton(menuEl);
        return;
      }

      const promptInfo = await this.getPromptNoteCached(options.controller, promptAbs);
      if (!promptInfo) {
        this.removeMenuRunButton(menuEl);
        return;
      }

      const btn = this.ensureMenuRunButton(menuEl);
      btn.dataset.ssCanvasflowCanvasPath = options.canvasFile.path;
      btn.dataset.ssCanvasflowNodeId = selectedNodeId;

      const key = this.getRunKey(options.canvasFile.path, selectedNodeId);
      const running = this.runningNodeKeys.has(key);
      btn.disabled = running;
      btn.classList.toggle("ss-canvasflow-is-loading", running);
      this.setMenuButtonIcon(btn, running ? "loader" : "play");

      if (!(btn as any).__ssCanvasflowRunBound) {
        (btn as any).__ssCanvasflowRunBound = true;
        btn.addEventListener("click", (e) => {
          stopEvent(e);

          const canvasPath = String(btn.dataset.ssCanvasflowCanvasPath || "").trim();
          const nodeId = String(btn.dataset.ssCanvasflowNodeId || "").trim();
          if (!canvasPath || !nodeId) {
            return;
          }

          const canvasAbs = this.app.vault.getAbstractFileByPath(canvasPath);
          if (!(canvasAbs instanceof TFile)) {
            new Notice("SystemSculpt: canvas file not found.");
            return;
          }

          const runKey = this.getRunKey(canvasPath, nodeId);
          if (this.runningNodeKeys.has(runKey)) {
            return;
          }

          const originalLabel = btn.getAttribute("aria-label") || "SystemSculpt - Run";
          btn.disabled = true;
          btn.classList.add("ss-canvasflow-is-loading");
          this.setMenuButtonIcon(btn, "loader");
          btn.setAttribute("aria-label", "SystemSculpt - Running...");

          this.runningNodeKeys.add(runKey);
          void this.runner
            .runPromptNode({
              canvasFile: canvasAbs,
              promptNodeId: nodeId,
              status: (status) => {
                btn.setAttribute("aria-label", `SystemSculpt - ${status}`);
              },
            })
            .catch((error: any) => {
              new Notice(`SystemSculpt run failed: ${error?.message || error}`);
            })
            .finally(() => {
              this.runningNodeKeys.delete(runKey);
              btn.disabled = false;
              btn.classList.remove("ss-canvasflow-is-loading");
              this.setMenuButtonIcon(btn, "play");
              btn.setAttribute("aria-label", originalLabel);
            });
        });
      }

      return;
    }

    // Image node -> show "New prompt" button.
    if (isImagePath(filePath)) {
      this.removeMenuRunButton(menuEl);

      const copyBtn = this.ensureMenuCopyImageButton(menuEl);
      copyBtn.dataset.ssCanvasflowCanvasPath = options.canvasFile.path;
      copyBtn.dataset.ssCanvasflowImageNodeId = selectedNodeId;

      const copyKey = this.getCopyKey(options.canvasFile.path, selectedNodeId);
      const copying = this.copyingImageKeys.has(copyKey);
      copyBtn.disabled = copying;
      copyBtn.classList.toggle("ss-canvasflow-is-loading", copying);
      this.setMenuButtonIcon(copyBtn, copying ? "loader" : "copy");

      if (!(copyBtn as any).__ssCanvasflowCopyImageBound) {
        (copyBtn as any).__ssCanvasflowCopyImageBound = true;
        copyBtn.addEventListener("click", (e) => {
          stopEvent(e);
          void this.handleCopySelectedImageToClipboard(copyBtn);
        });
      }

      const newPromptBtn = this.ensureMenuNewPromptButton(menuEl);
      newPromptBtn.dataset.ssCanvasflowCanvasPath = options.canvasFile.path;
      newPromptBtn.dataset.ssCanvasflowImageNodeId = selectedNodeId;

      const createKey = this.getCreateKey(options.canvasFile.path, selectedNodeId);
      const creating = this.creatingFromImageKeys.has(createKey);
      newPromptBtn.disabled = creating;
      newPromptBtn.classList.toggle("ss-canvasflow-is-loading", creating);
      this.setMenuButtonIcon(newPromptBtn, creating ? "loader" : "sparkles");

      if (!(newPromptBtn as any).__ssCanvasflowNewPromptBound) {
        (newPromptBtn as any).__ssCanvasflowNewPromptBound = true;
        newPromptBtn.addEventListener("click", (e) => {
          stopEvent(e);
          void this.handleCreatePromptFromSelectedImage(newPromptBtn);
        });
      }

      return;
    }

    // Default: neither prompt nor image.
    this.clearSelectionMenuButtons(menuEl);
  }

  private getCreateKey(canvasPath: string, imageNodeId: string): string {
    return `${canvasPath}::image::${imageNodeId}`;
  }

  private getCopyKey(canvasPath: string, imageNodeId: string): string {
    return `${canvasPath}::image-copy::${imageNodeId}`;
  }

  private findControllerForCanvasPath(canvasPath: string): LeafController | null {
    const path = String(canvasPath || "").trim();
    if (!path) return null;

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      try {
        const file = ((leaf.view as any)?.file as TFile | undefined) || null;
        if (file?.path === path) {
          return this.controllers.get(leaf) || null;
        }
      } catch {}
    }

    // Fallback: match by last-seen controller state.
    for (const controller of this.controllers.values()) {
      if (controller.canvasFilePath === path) {
        return controller;
      }
    }

    return null;
  }

  private async handleCopySelectedImageToClipboard(btn: HTMLButtonElement): Promise<void> {
    const canvasPath = String(btn.dataset.ssCanvasflowCanvasPath || "").trim();
    const imageNodeId = String(btn.dataset.ssCanvasflowImageNodeId || "").trim();
    if (!canvasPath || !imageNodeId) {
      return;
    }

    const canvasAbs = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!(canvasAbs instanceof TFile)) {
      new Notice("SystemSculpt: canvas file not found.");
      return;
    }

    const copyKey = this.getCopyKey(canvasPath, imageNodeId);
    if (this.copyingImageKeys.has(copyKey)) {
      return;
    }

    const originalLabel =
      btn.getAttribute("aria-label") || "SystemSculpt - Copy Image to Clipboard";
    const originalIcon = String(btn.getAttribute("data-ss-canvasflow-icon") || "copy");

    this.copyingImageKeys.add(copyKey);
    btn.disabled = true;

    try {
      const canvasRaw = await this.app.vault.read(canvasAbs);
      const doc = parseCanvasDocument(canvasRaw);
      if (!doc) {
        new Notice("SystemSculpt: failed to parse .canvas file.");
        return;
      }

      const { nodesById } = indexCanvas(doc);
      const imageNode = nodesById.get(imageNodeId);
      if (!imageNode || !isCanvasFileNode(imageNode)) {
        new Notice("SystemSculpt: selected node is not a file node.");
        return;
      }

      const imagePath = String(imageNode.file || "").trim();
      if (!imagePath || !isImagePath(imagePath)) {
        new Notice("SystemSculpt: selected node is not an image.");
        return;
      }

      const imageAbs = this.app.vault.getAbstractFileByPath(imagePath);
      if (!(imageAbs instanceof TFile)) {
        new Notice("SystemSculpt: image file not found.");
        return;
      }

      btn.classList.add("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, "loader");
      btn.setAttribute("aria-label", "SystemSculpt - Copying Image...");

      const copied = await tryCopyImageFileToClipboard(this.app, imageAbs);
      if (copied) {
        new Notice("Image copied to clipboard.");
      } else {
        new Notice("Unable to copy image to clipboard.");
      }
    } catch {
      new Notice("Unable to copy image to clipboard.");
    } finally {
      this.copyingImageKeys.delete(copyKey);
      btn.disabled = false;
      btn.classList.remove("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, originalIcon);
      btn.setAttribute("aria-label", originalLabel);
    }
  }

  private async handleCreatePromptFromSelectedImage(btn: HTMLButtonElement): Promise<void> {
    const canvasPath = String(btn.dataset.ssCanvasflowCanvasPath || "").trim();
    const imageNodeId = String(btn.dataset.ssCanvasflowImageNodeId || "").trim();
    if (!canvasPath || !imageNodeId) {
      return;
    }

    const canvasAbs = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!(canvasAbs instanceof TFile)) {
      new Notice("SystemSculpt: canvas file not found.");
      return;
    }

    const createKey = this.getCreateKey(canvasPath, imageNodeId);
    if (this.creatingFromImageKeys.has(createKey)) {
      return;
    }

    const originalLabel = btn.getAttribute("aria-label") || "SystemSculpt - New Prompt";
    const originalIcon = String(btn.getAttribute("data-ss-canvasflow-icon") || "sparkles");

    this.creatingFromImageKeys.add(createKey);
    btn.disabled = true;

    try {
      const canvasRaw = await this.app.vault.read(canvasAbs);
      const doc = parseCanvasDocument(canvasRaw);
      if (!doc) {
        new Notice("SystemSculpt: failed to parse .canvas file.");
        return;
      }

      const { nodesById } = indexCanvas(doc);
      const imageNode = nodesById.get(imageNodeId);
      if (!imageNode || !isCanvasFileNode(imageNode)) {
        new Notice("SystemSculpt: selected node is not a file node.");
        return;
      }

      const imagePath = String(imageNode.file || "").trim();
      if (!imagePath || !isImagePath(imagePath)) {
        new Notice("SystemSculpt: selected node is not an image.");
        return;
      }

      const modelId = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim() || DEFAULT_IMAGE_GENERATION_MODEL_ID;

      btn.classList.add("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, "loader");
      btn.setAttribute("aria-label", "SystemSculpt - Creating Prompt...");

      const imageOptions: Record<string, unknown> =
        modelId === "google/nano-banana-pro"
          ? {
              aspect_ratio: "match_input_image",
              resolution: "4K",
              output_format: "jpg",
              safety_filter_level: "block_only_high",
            }
          : {};
      const promptAspectRatio = modelId === "google/nano-banana-pro" ? null : getDefaultImageAspectRatio(modelId);

      const created = await this.createPromptNodeConnectedToImage({
        canvasFile: canvasAbs,
        doc,
        imageNodeId,
        imageNode,
        modelId,
        aspectRatio: promptAspectRatio,
        promptText: "",
        imageOptions,
      });

      const controller = this.findControllerForCanvasPath(canvasPath);
      if (controller) {
        controller.pendingFocusNodeId = created.promptNodeId;
        controller.pendingFocusAttempts = 0;
        this.scheduleUpdate(controller);
      }

      new Notice("SystemSculpt: prompt created. Type your prompt and press Cmd/Ctrl+Enter to run.");
    } catch (error: any) {
      new Notice(`SystemSculpt: failed to create prompt: ${error?.message || error}`);
    } finally {
      this.creatingFromImageKeys.delete(createKey);
      btn.disabled = false;
      btn.classList.remove("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, originalIcon);
      btn.setAttribute("aria-label", originalLabel);
    }
  }

  private async createPromptNodeConnectedToImage(options: {
    canvasFile: TFile;
    doc: NonNullable<ReturnType<typeof parseCanvasDocument>>;
    imageNodeId: string;
    imageNode: any;
    modelId: string;
    aspectRatio: string | null;
    promptText: string;
    imageOptions: Record<string, unknown>;
  }): Promise<{ promptNodeId: string; promptFile: TFile }> {
    const promptsDir = "SystemSculpt/CanvasFlow/Prompts";
    await this.ensureFolder(promptsDir);

    const inputLines = this.formatImageOptionsFrontmatter(options.imageOptions);

    const template = [
      "---",
      "ss_flow_kind: prompt",
      "ss_flow_backend: openrouter",
      `ss_image_model: ${options.modelId}`,
      options.aspectRatio ? `ss_image_aspect_ratio: ${options.aspectRatio}` : "",
      ...inputLines,
      "---",
      "",
      String(options.promptText || "").trim(),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

    const notePath = await this.getAvailableNotePath(promptsDir, `SystemSculpt Prompt ${this.nowStamp()}`);
    const promptFile = await this.app.vault.create(notePath, template.endsWith("\n") ? template : `${template}\n`);

    const placed = computeNextNodePosition(options.imageNode, {
      dx: 80,
      defaultWidth: CANVASFLOW_PROMPT_NODE_WIDTH_PX,
      defaultHeight: CANVASFLOW_PROMPT_NODE_HEIGHT_PX,
    });
    let updatedDoc = options.doc;
    const added = addFileNode(updatedDoc, {
      filePath: promptFile.path,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    });
    updatedDoc = added.doc;
    updatedDoc = addEdge(updatedDoc, { fromNode: options.imageNodeId, toNode: added.nodeId }).doc;

    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));
    return { promptNodeId: added.nodeId, promptFile };
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized) return;
    const exists = await this.app.vault.adapter.exists(normalized);
    if (exists) return;

    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const segmentExists = await this.app.vault.adapter.exists(current);
      if (segmentExists) continue;
      await this.app.vault.createFolder(current);
    }
  }

  private nowStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  private async getAvailableNotePath(folderPath: string, baseName: string): Promise<string> {
    const safeBase = sanitizeChatTitle(baseName).trim() || "SystemSculpt Prompt";
    let attempt = 0;
    while (attempt < 1000) {
      const suffix = attempt === 0 ? "" : ` (${attempt})`;
      const candidate = normalizePath(`${folderPath}/${safeBase}${suffix}.md`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
      attempt += 1;
    }
    return normalizePath(`${folderPath}/${safeBase}-${Date.now().toString(16)}.md`);
  }

  private formatImageOptionsFrontmatter(input: Record<string, unknown>): string[] {
    const keys = Object.keys(input || {});
    if (keys.length === 0) {
      return ["ss_image_options: {}"];
    }

    // Preserve key order for readability.
    const yaml: Record<string, unknown> = {};
    for (const k of keys) {
      yaml[k] = (input as any)[k];
    }

    const yamlText = String(YAML.stringify(yaml) || "").trimEnd();
    const indented = yamlText
      .split("\n")
      .map((line) => (line.trim().length ? `  ${line}` : line))
      .join("\n");

    return ["ss_image_options:", indented];
  }
}

function controllerSafeUpdateCache(controller: LeafController | undefined, promptPath: string): void {
  if (!controller) return;
  controller.promptFileCache.delete(promptPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}
