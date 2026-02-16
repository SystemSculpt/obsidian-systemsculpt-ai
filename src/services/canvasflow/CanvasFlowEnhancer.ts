import { App, Modal, Notice, Platform, setIcon, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import YAML from "yaml";
import type SystemSculptPlugin from "../../main";
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
  CANVASFLOW_PROMPT_NODE_MAX_HEIGHT_PX,
  CANVASFLOW_PROMPT_NODE_MAX_WIDTH_PX,
  CANVASFLOW_PROMPT_NODE_MIN_HEIGHT_PX,
  CANVASFLOW_PROMPT_NODE_MIN_WIDTH_PX,
  CANVASFLOW_PROMPT_NODE_WIDTH_PX,
} from "./CanvasFlowUiConstants";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatImageAspectRatioLabel,
  formatCuratedImageModelOptionText,
  getCuratedImageGenerationModel,
  getCuratedImageGenerationModelGroups,
  mergeImageGenerationServerCatalogModels,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";
import {
  queueCanvasFlowLastUsedPatch,
  resolveCanvasFlowPromptDefaults,
} from "./CanvasFlowPromptDefaults";
import { SystemSculptImageGenerationService } from "./SystemSculptImageGenerationService";
import { tryCopyImageFileToClipboard } from "../../utils/clipboard";
import { findCanvasSelectionMenu } from "./CanvasFlowSelectionMenuHelpers";
import { CanvasFlowCanvasAdapter } from "./CanvasFlowCanvasAdapter";
import {
  clampImageCount,
  cloneCanvasFlowPromptDraft,
  createCanvasFlowPromptDraft,
  getDraftAspectRatioOrDefault,
  getEffectiveDraftModel,
  type CanvasFlowPromptDraft,
  type CanvasFlowPromptDraftEntry,
} from "./CanvasFlowPromptDraftState";

type PromptCacheEntry = {
  mtime: number;
  body: string;
  frontmatter: Record<string, unknown>;
  config: CanvasFlowPromptConfig;
};

type PromptNodeRenderState = {
  nodeId: string;
  nodeEl: HTMLElement;
  promptFile: TFile;
  promptBody: string;
  promptFrontmatter: Record<string, unknown>;
  promptConfig: CanvasFlowPromptConfig;
  promptMtime: number;
};

type PromptNodeControllerState = {
  nodeId: string;
  host: HTMLElement;
  cardEl: HTMLElement;
  titleEl: HTMLElement;
  modelBadgeEl: HTMLElement;
  metaEl: HTMLElement;
  pathEl: HTMLElement;
  excerptEl: HTMLElement;
  hintEl: HTMLElement;
  statusEl: HTMLElement;
  editBtn: HTMLButtonElement;
  openBtn: HTMLButtonElement;
  runBtn: HTMLButtonElement;
  promptFile: TFile;
};

type PromptInspectorState = {
  modal: CanvasFlowPromptInspectorModal;
  isOpen: boolean;
  closingProgrammatically: boolean;
  rootEl: HTMLElement;
  titleEl: HTMLElement;
  pathEl: HTMLElement;
  modelSelect: HTMLSelectElement;
  imageCountButtons: HTMLButtonElement[];
  aspectRatioButtons: HTMLButtonElement[];
  promptTextarea: HTMLTextAreaElement;
  openBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  runBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  boundNodeId: string | null;
  suppressDraftEvents: boolean;
  saveTimer: number | null;
  saveChain: Promise<void>;
};

const SIMPLE_ASPECT_RATIO_OPTIONS = ["16:9", "1:1", "9:16"] as const;
const DEFAULT_SIMPLE_ASPECT_RATIO = "1:1";

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
  pendingFocusNodeId: string | null;
  pendingFocusAttempts: number;
  promptNodeControllers: Map<string, PromptNodeControllerState>;
  promptDrafts: Map<string, CanvasFlowPromptDraftEntry>;
  latestPromptStates: Map<string, PromptNodeRenderState>;
  selectedPromptNodeId: string | null;
  inspector: PromptInspectorState | null;
};

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

class CanvasFlowPromptInspectorModal extends Modal {
  constructor(
    app: App,
    private readonly onDidOpen: () => void,
    private readonly onDidClose: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.onDidOpen();
  }

  onClose(): void {
    this.onDidClose();
  }
}

export class CanvasFlowEnhancer {
  private static readonly IMAGE_MODEL_CATALOG_REFRESH_INTERVAL_MS = 5 * 60_000;

  private readonly controllers = new Map<WorkspaceLeaf, LeafController>();
  private readonly runner: CanvasFlowRunner;
  private readonly canvasAdapter = new CanvasFlowCanvasAdapter();
  private runningNodeKeys = new Set<string>();
  private creatingFromImageKeys = new Set<string>();
  private copyingImageKeys = new Set<string>();
  private workspaceEventRefs: any[] = [];
  private imageModelCatalogRefreshInFlight: Promise<boolean> | null = null;
  private lastImageModelCatalogRefreshAt = 0;

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
      controller.promptNodeControllers.clear();
      controller.promptDrafts.clear();
      controller.latestPromptStates.clear();
      this.hidePromptInspector(controller);
      controller.selectedPromptNodeId = null;
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

    const root = this.canvasAdapter.getRoot(leaf);
    if (!root) {
      return;
    }

    const controller: LeafController = {
      leaf,
      observer: new MutationObserver((records) => {
        if (this.isSelectionOnlyMutation(records)) {
          this.scheduleSelectionUiUpdate(controller);
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
      pendingFocusNodeId: null,
      pendingFocusAttempts: 0,
      promptNodeControllers: new Map(),
      promptDrafts: new Map(),
      latestPromptStates: new Map(),
      selectedPromptNodeId: null,
      inspector: null,
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

  private scheduleSelectionUiUpdate(controller: LeafController): void {
    if (controller.selectionMenuUpdateQueued) return;
    controller.selectionMenuUpdateQueued = true;
    window.setTimeout(() => {
      controller.selectionMenuUpdateQueued = false;
      void this.updateSelectionUiOnly(controller);
    }, 0);
  }

  private async updateSelectionUiOnly(controller: LeafController): Promise<void> {
    if (this.plugin.settings.canvasFlowEnabled !== true) {
      return;
    }

    const root = this.canvasAdapter.getRoot(controller.leaf);
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

    this.syncPromptInspectorSelection(controller, root, canvasFile.path);
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
    if (el.classList?.contains("ss-canvasflow-node-card")) return true;
    if (el.closest(".ss-canvasflow-node-card")) return true;
    if (el.classList?.contains("ss-canvasflow-inspector")) return true;
    if (el.closest(".ss-canvasflow-inspector")) return true;
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

  private removeInjectedControls(leaf: WorkspaceLeaf): void {
    const root = this.canvasAdapter.getRoot(leaf);
    if (!root) return;
    root.querySelectorAll(".ss-canvasflow-controls").forEach((el) => el.remove());
    root.querySelectorAll(".ss-canvasflow-node-card").forEach((el) => el.remove());
    root.querySelectorAll(".ss-canvasflow-inspector").forEach((el) => el.remove());
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
      controller.promptNodeControllers.clear();
      controller.latestPromptStates.clear();
      this.hidePromptInspector(controller);
      controller.selectedPromptNodeId = null;
      return;
    }

    const leaf = controller.leaf;
    const root = this.canvasAdapter.getRoot(leaf);
    if (!root) return;

    const canvasFile = ((leaf.view as any)?.file as TFile | undefined) || null;
    if (!canvasFile) {
      this.teardownPromptNodeControllers(controller);
      this.hidePromptInspector(controller);
      return;
    }

    const canvasMtime = canvasFile.stat?.mtime ?? 0;
    const pathChanged = controller.canvasFilePath !== canvasFile.path;
    if (pathChanged || controller.canvasFileMtime !== canvasMtime) {
      controller.canvasFilePath = canvasFile.path;
      controller.canvasFileMtime = canvasMtime;
      const raw = await this.app.vault.read(canvasFile);
      controller.cachedCanvasDoc = parseCanvasDocument(raw);
    }

    const doc = controller.cachedCanvasDoc;
    if (!doc) return;
    const { nodesById } = indexCanvas(doc);

    let canvasDocDirty = false;
    const promptStates = new Map<string, PromptNodeRenderState>();
    const nodeEls = this.canvasAdapter.listNodeElements(leaf, root);
    for (const { el: nodeEl, nodeId } of nodeEls) {
      const node = nodesById.get(nodeId);
      if (!node || !isCanvasFileNode(node)) continue;

      const filePath = node.file;
      if (!filePath.toLowerCase().endsWith(".md")) continue;

      const promptFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(promptFile instanceof TFile)) continue;

      const promptInfo = await this.getPromptNoteCached(controller, promptFile);
      if (!promptInfo) {
        continue;
      }

      const promptMtime = promptFile.stat?.mtime ?? 0;
      const state: PromptNodeRenderState = {
        nodeId,
        nodeEl,
        promptFile,
        promptBody: promptInfo.body,
        promptFrontmatter: promptInfo.frontmatter,
        promptConfig: promptInfo.config,
        promptMtime,
      };
      promptStates.set(nodeId, state);
      this.syncPromptDraftFromSource(controller, state);
    }

    controller.latestPromptStates = promptStates;
    canvasDocDirty =
      this.reconcilePromptNodeControllers(controller, promptStates, canvasFile, nodesById) || canvasDocDirty;

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

    this.syncPromptInspectorSelection(controller, root, canvasFile.path);
    this.tryFocusPendingPrompt(controller);
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
        supports_generation:
          typeof (model as any)?.supports_generation === "boolean"
            ? (model as any).supports_generation
            : undefined,
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
        estimated_cost_per_image_usd:
          typeof (model as any)?.estimated_cost_per_image_usd === "number" &&
          Number.isFinite((model as any).estimated_cost_per_image_usd)
            ? (model as any).estimated_cost_per_image_usd
            : undefined,
        estimated_cost_per_image_low_usd:
          typeof (model as any)?.estimated_cost_per_image_low_usd === "number" &&
          Number.isFinite((model as any).estimated_cost_per_image_low_usd)
            ? (model as any).estimated_cost_per_image_low_usd
            : undefined,
        estimated_cost_per_image_high_usd:
          typeof (model as any)?.estimated_cost_per_image_high_usd === "number" &&
          Number.isFinite((model as any).estimated_cost_per_image_high_usd)
            ? (model as any).estimated_cost_per_image_high_usd
            : undefined,
        pricing_source: String((model as any)?.pricing_source || "").trim() || undefined,
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
    const hasSupportMetadata =
      serverModels.some((model) => typeof model.supports_generation === "boolean") ||
      groups.some((group) => group.models.some((model) => model.supportsGeneration === false));
    const curatedSlugs = new Set<string>();
    const curatedSupportBySlug = new Map<string, boolean>();
    for (const group of groups) {
      for (const model of group.models) {
        curatedSlugs.add(model.id);
        curatedSupportBySlug.set(model.id, model.supportsGeneration);
      }
    }

    const extraSlugs = Array.from(extras.values())
      .map((s) => String(s || "").trim())
      .filter((s) => s && s !== "openrouter/auto" && !curatedSlugs.has(s))
      .sort((a, b) => a.localeCompare(b));

    select.empty();
    const defaultEntry = settingsModelSlug ? getCuratedImageGenerationModel(settingsModelSlug, serverModels) : null;
    const defaultLabel = defaultEntry
      ? `(Default: ${defaultEntry.label}  ${defaultEntry.pricing.summary})`
      : settingsModelSlug
        ? "(Default: configured model)"
        : "(Default model)";
    select.createEl("option", { value: "", text: defaultLabel });

    for (const group of groups) {
      const optgroup = select.createEl("optgroup");
      optgroup.label = group.provider;
      for (const model of group.models) {
        const isSupported = hasSupportMetadata ? model.supportsGeneration === true : true;
        const option = optgroup.createEl("option", {
          value: model.id,
          text: isSupported ? formatCuratedImageModelOptionText(model) : `${formatCuratedImageModelOptionText(model)} (Not supported yet)`,
        });
        option.disabled = !isSupported;
      }
    }

    if (extraSlugs.length) {
      const optgroup = select.createEl("optgroup");
      optgroup.label = "Custom";
      for (const slug of extraSlugs) {
        const isSupported = hasSupportMetadata ? curatedSupportBySlug.get(slug) === true : true;
        const option = optgroup.createEl("option", {
          value: slug,
          text: isSupported ? slug : `${slug} (Not supported yet)`,
        });
        option.disabled = !isSupported;
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

  private teardownPromptNodeControllers(controller: LeafController): void {
    for (const nodeId of Array.from(controller.promptNodeControllers.keys())) {
      this.removePromptNodeController(controller, nodeId);
    }
    controller.promptNodeControllers.clear();
  }

  private removePromptNodeController(controller: LeafController, nodeId: string): void {
    const existing = controller.promptNodeControllers.get(nodeId);
    if (!existing) return;

    try {
      existing.cardEl.remove();
    } catch {}

    try {
      existing.host
        .querySelectorAll<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(nodeId)}"]`)
        .forEach((el) => el.remove());
    } catch {}

    try {
      const state = controller.latestPromptStates.get(nodeId);
      state?.nodeEl?.classList?.remove?.("ss-canvasflow-prompt-node");
    } catch {}

    controller.promptNodeControllers.delete(nodeId);
  }

  private syncPromptDraftFromSource(controller: LeafController, state: PromptNodeRenderState): void {
    const promptPath = state.promptFile.path;
    const existing = controller.promptDrafts.get(promptPath);
    if (existing) {
      if (!existing.dirty && existing.sourceMtime !== state.promptMtime) {
        existing.sourceMtime = state.promptMtime;
        existing.draft = createCanvasFlowPromptDraft({
          promptBody: state.promptBody,
          frontmatter: state.promptFrontmatter,
          promptConfig: state.promptConfig,
        });
      }
      return;
    }

    controller.promptDrafts.set(promptPath, {
      promptPath,
      sourceMtime: state.promptMtime,
      dirty: false,
      draft: createCanvasFlowPromptDraft({
        promptBody: state.promptBody,
        frontmatter: state.promptFrontmatter,
        promptConfig: state.promptConfig,
      }),
    });
  }

  private getPromptDraftEntry(controller: LeafController, state: PromptNodeRenderState): CanvasFlowPromptDraftEntry {
    const existing = controller.promptDrafts.get(state.promptFile.path);
    if (existing) {
      return existing;
    }

    const created: CanvasFlowPromptDraftEntry = {
      promptPath: state.promptFile.path,
      sourceMtime: state.promptMtime,
      dirty: false,
      draft: createCanvasFlowPromptDraft({
        promptBody: state.promptBody,
        frontmatter: state.promptFrontmatter,
        promptConfig: state.promptConfig,
      }),
    };
    controller.promptDrafts.set(state.promptFile.path, created);
    return created;
  }

  private getPromptExcerpt(text: string): string {
    const normalized = String(text || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!normalized) return "Empty prompt";
    if (normalized.length <= 140) return normalized;
    return `${normalized.slice(0, 137)}...`;
  }

  private formatPromptCardMeta(options: {
    draft: CanvasFlowPromptDraft;
    effectiveModel: string;
    serverModels: readonly ImageGenerationServerCatalogModel[];
    isDirty: boolean;
  }): string {
    const imageCount = clampImageCount(options.draft.imageCount);
    const imagesPart = imageCount === 1 ? "1 image" : `${imageCount} images`;

    const isNano = options.effectiveModel === "google/nano-banana-pro";
    const ratioRaw = isNano
      ? String(options.draft.nano.aspect_ratio || "match_input_image").trim()
      : getDraftAspectRatioOrDefault({
          draftAspectRatio: options.draft.aspectRatioPreset,
          effectiveModel: options.effectiveModel,
          serverModels: options.serverModels,
        });
    const ratioPart =
      ratioRaw === "match_input_image"
        ? "Match input"
        : ratioRaw.includes(":")
          ? formatImageAspectRatioLabel(ratioRaw)
        : ratioRaw || "Default ratio";

    const dirtyPart = options.isDirty ? "Unsaved" : "Saved";
    return [imagesPart, ratioPart, dirtyPart].join(" • ");
  }

  private setPromptNodeStatus(card: PromptNodeControllerState, text: string): void {
    card.statusEl.setText(String(text || ""));
    const lower = String(text || "").toLowerCase();
    card.statusEl.classList.toggle("ss-is-error", /\b(failed|error)\b/.test(lower));
    card.statusEl.classList.toggle("ss-is-success", /\bdone|saved\b/.test(lower));
  }

  private getActiveCanvasFile(controller: LeafController): TFile | null {
    const fromView = ((controller.leaf.view as any)?.file as TFile | undefined) || null;
    if (fromView instanceof TFile) return fromView;
    const path = String(controller.canvasFilePath || "").trim();
    if (!path) return null;
    const abs = this.app.vault.getAbstractFileByPath(path);
    return abs instanceof TFile ? abs : null;
  }

  private refreshPromptNodeCard(controller: LeafController, nodeId: string): void {
    const state = controller.latestPromptStates.get(nodeId);
    const card = controller.promptNodeControllers.get(nodeId);
    if (!state || !card) return;
    this.updatePromptNodeCard(controller, card, state, controller.canvasFilePath || "");
    this.syncPromptNodeSizing(controller, state, card, null);
  }

  private reconcilePromptNodeControllers(
    controller: LeafController,
    promptStates: Map<string, PromptNodeRenderState>,
    canvasFile: TFile,
    nodesById: Map<string, any>
  ): boolean {
    let canvasDocDirty = false;
    const staleNodeIds = Array.from(controller.promptNodeControllers.keys()).filter((nodeId) => !promptStates.has(nodeId));
    for (const staleNodeId of staleNodeIds) {
      this.removePromptNodeController(controller, staleNodeId);
    }

    for (const state of promptStates.values()) {
      state.nodeEl.classList.add("ss-canvasflow-prompt-node");
      const host = this.canvasAdapter.findNodeContentHost(state.nodeEl);

      // Remove any legacy full-node control UIs if they still exist from an older build.
      host
        .querySelectorAll<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(state.nodeId)}"]`)
        .forEach((el) => el.remove());

      let nodeController = controller.promptNodeControllers.get(state.nodeId) || null;
      if (!nodeController || nodeController.host !== host || !host.contains(nodeController.cardEl)) {
        if (nodeController) {
          this.removePromptNodeController(controller, state.nodeId);
        }
        nodeController = this.createPromptNodeCard(controller, state, host, canvasFile.path);
        controller.promptNodeControllers.set(state.nodeId, nodeController);
      } else {
        nodeController.promptFile = state.promptFile;
      }

      this.updatePromptNodeCard(controller, nodeController, state, canvasFile.path);
      const node = nodesById.get(state.nodeId) || null;
      canvasDocDirty = this.syncPromptNodeSizing(controller, state, nodeController, node) || canvasDocDirty;
    }

    return canvasDocDirty;
  }

  private syncPromptNodeSizing(
    controller: LeafController,
    state: PromptNodeRenderState,
    nodeController: PromptNodeControllerState,
    canvasNode: any | null
  ): boolean {
    const desiredWidth = this.measurePromptNodeWidth(state.nodeEl, nodeController.cardEl);
    const readPx = (value: string | null | undefined): number | null => {
      const parsed = Number.parseInt(String(value || "").replace("px", "").trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const styleWidth = readPx(state.nodeEl.style.getPropertyValue(CANVASFLOW_PROMPT_NODE_CSS_VAR_WIDTH)) ?? readPx(state.nodeEl.style.width);
    const styleHeight =
      readPx(state.nodeEl.style.getPropertyValue(CANVASFLOW_PROMPT_NODE_CSS_VAR_HEIGHT)) ?? readPx(state.nodeEl.style.height);

    let desiredHeight = this.measurePromptNodeHeight(state.nodeEl, nodeController.cardEl);
    if (styleWidth !== desiredWidth) {
      this.enforcePromptNodeSizing(state.nodeEl, {
        widthPx: desiredWidth,
        heightPx: styleHeight ?? desiredHeight,
      });
      desiredHeight = this.measurePromptNodeHeight(state.nodeEl, nodeController.cardEl);
    }

    const needsDomSizing = styleWidth !== desiredWidth || styleHeight !== desiredHeight;
    if (needsDomSizing) {
      this.enforcePromptNodeSizing(state.nodeEl, { widthPx: desiredWidth, heightPx: desiredHeight });
    }

    let needsCanvasNodeUpdate = false;
    if (canvasNode && isCanvasFileNode(canvasNode)) {
      const currentWidth =
        typeof canvasNode.width === "number" && Number.isFinite(canvasNode.width) ? (canvasNode.width as number) : null;
      const currentHeight =
        typeof canvasNode.height === "number" && Number.isFinite(canvasNode.height) ? (canvasNode.height as number) : null;
      needsCanvasNodeUpdate = currentWidth !== desiredWidth || currentHeight !== desiredHeight;
      if (needsCanvasNodeUpdate) {
        (canvasNode as any).width = desiredWidth;
        (canvasNode as any).height = desiredHeight;
      }
    }

    if (needsDomSizing || needsCanvasNodeUpdate) {
      try {
        this.canvasAdapter.trySetPromptNodeSize(controller.leaf, state.nodeId, desiredWidth, desiredHeight);
      } catch {}
    }

    return needsCanvasNodeUpdate;
  }

  private measurePromptNodeWidth(nodeEl: HTMLElement, cardEl: HTMLElement): number {
    const parsePx = (value: string | null | undefined): number => {
      const parsed = Number.parseFloat(String(value || "").replace("px", "").trim());
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const readGap = (el: HTMLElement | null): number => {
      if (!el) return 0;
      try {
        const win = el.ownerDocument?.defaultView || window;
        return parsePx(win.getComputedStyle(el).columnGap || win.getComputedStyle(el).gap);
      } catch {
        return 0;
      }
    };

    const sumWidths = (els: HTMLElement[]): number => {
      let total = 0;
      for (const el of els) {
        total += Math.ceil(el.scrollWidth || 0);
      }
      return total;
    };

    const headerEl = cardEl.querySelector<HTMLElement>(".ss-canvasflow-node-card-header");
    const titleEl = cardEl.querySelector<HTMLElement>(".ss-canvasflow-node-card-title");
    const modelBadgeEl = cardEl.querySelector<HTMLElement>(".ss-canvasflow-node-card-model");
    const actionsEl = cardEl.querySelector<HTMLElement>(".ss-canvasflow-node-card-actions");
    const metaEl = cardEl.querySelector<HTMLElement>(".ss-canvasflow-node-card-meta");

    const headerChildren: HTMLElement[] = [];
    if (titleEl) headerChildren.push(titleEl);
    if (modelBadgeEl) headerChildren.push(modelBadgeEl);
    const headerGap = headerChildren.length > 1 ? readGap(headerEl) * (headerChildren.length - 1) : 0;
    const headerWidth = sumWidths(headerChildren) + headerGap;

    const actionButtons = actionsEl ? Array.from(actionsEl.querySelectorAll<HTMLElement>("button")) : [];
    const actionsGap = actionButtons.length > 1 ? readGap(actionsEl) * (actionButtons.length - 1) : 0;
    const actionsWidth = sumWidths(actionButtons) + actionsGap;

    const metaWidth = metaEl ? Math.min(Math.ceil(metaEl.scrollWidth || 0), 420) : 0;

    let cardHorizontalPadding = 0;
    try {
      const win = nodeEl.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(cardEl);
      cardHorizontalPadding = parsePx(style.paddingLeft) + parsePx(style.paddingRight);
    } catch {}

    const contentWidth = Math.max(260, headerWidth, actionsWidth, metaWidth);
    const raw = Math.ceil(contentWidth + cardHorizontalPadding + 18);
    return Math.max(CANVASFLOW_PROMPT_NODE_MIN_WIDTH_PX, Math.min(CANVASFLOW_PROMPT_NODE_MAX_WIDTH_PX, raw));
  }

  private measurePromptNodeHeight(nodeEl: HTMLElement, cardEl: HTMLElement): number {
    let measured = 0;
    try {
      measured = Math.ceil(cardEl.scrollHeight);
    } catch {}

    if (!Number.isFinite(measured) || measured <= 0) {
      try {
        measured = Math.ceil(cardEl.getBoundingClientRect().height);
      } catch {
        measured = 0;
      }
    }

    let borderTop = 0;
    let borderBottom = 0;
    try {
      const win = nodeEl.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(nodeEl);
      borderTop = Number.parseFloat(style.borderTopWidth || "0") || 0;
      borderBottom = Number.parseFloat(style.borderBottomWidth || "0") || 0;
    } catch {}

    const next = Math.ceil(Math.max(0, measured) + borderTop + borderBottom + 2);
    const fallback = CANVASFLOW_PROMPT_NODE_HEIGHT_PX;
    const clamped = Math.max(
      CANVASFLOW_PROMPT_NODE_MIN_HEIGHT_PX,
      Math.min(CANVASFLOW_PROMPT_NODE_MAX_HEIGHT_PX, Number.isFinite(next) && next > 0 ? next : fallback)
    );
    return Math.floor(clamped);
  }

  private createPromptNodeCard(
    controller: LeafController,
    state: PromptNodeRenderState,
    host: HTMLElement,
    canvasPath: string
  ): PromptNodeControllerState {
    const cardEl = host.createDiv({ cls: "ss-canvasflow-node-card" });
    cardEl.dataset.ssNodeId = state.nodeId;

    const headerEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-header" });
    const titleEl = headerEl.createDiv({ cls: "ss-canvasflow-node-card-title" });
    const modelBadgeEl = headerEl.createEl("code", { cls: "ss-canvasflow-node-card-model" });
    const metaEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-meta" });
    const pathEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-path" });

    const excerptEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-excerpt" });
    const hintEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-hint" });

    const actionsEl = cardEl.createDiv({ cls: "ss-canvasflow-node-card-actions" });
    const editBtn = actionsEl.createEl("button", { text: "Edit", cls: "ss-canvasflow-btn" });
    editBtn.type = "button";
    const openBtn = actionsEl.createEl("button", { text: "Open", cls: "ss-canvasflow-btn" });
    openBtn.type = "button";
    const runBtn = actionsEl.createEl("button", { text: "Run", cls: "ss-canvasflow-btn ss-canvasflow-btn-primary" });
    runBtn.type = "button";
    const statusEl = cardEl.createDiv({ cls: "ss-canvasflow-status ss-canvasflow-node-card-status" });
    statusEl.setText("");

    const nodeController: PromptNodeControllerState = {
      nodeId: state.nodeId,
      host,
      cardEl,
      titleEl,
      modelBadgeEl,
      metaEl,
      pathEl,
      excerptEl,
      hintEl,
      statusEl,
      editBtn,
      openBtn,
      runBtn,
      promptFile: state.promptFile,
    };

    editBtn.addEventListener("click", (e) => {
      stopEvent(e);
      this.focusPromptInspectorForNode(controller, state.nodeId, true);
    });

    openBtn.addEventListener("click", (e) => {
      stopEvent(e);
      const file = nodeController.promptFile;
      void this.openPromptFileInEditor(file);
    });

    runBtn.addEventListener("click", (e) => {
      stopEvent(e);
      this.setPromptNodeStatus(nodeController, "Saving...");
      void this.runPromptNodeWithDraftSave({
        controller,
        nodeId: state.nodeId,
        status: (text) => this.setPromptNodeStatus(nodeController, text),
      });
    });

    let pointerDownX = 0;
    let pointerDownY = 0;
    let suppressClickOpen = false;

    // Keep canvas drag behavior intact when interacting with card copy.
    cardEl.addEventListener("pointerdown", (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null) || null;
      if (target?.closest("button")) {
        stopPropagationOnly(e);
        return;
      }
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
      suppressClickOpen = false;
    });
    cardEl.addEventListener("mousedown", (e) => {
      const target = (e.target as HTMLElement | null) || null;
      if (target?.closest("button")) {
        stopPropagationOnly(e);
      }
    });
    cardEl.addEventListener("pointermove", (e: PointerEvent) => {
      const dx = Math.abs(e.clientX - pointerDownX);
      const dy = Math.abs(e.clientY - pointerDownY);
      if (dx > 4 || dy > 4) {
        suppressClickOpen = true;
      }
    });
    cardEl.addEventListener("pointercancel", () => {
      suppressClickOpen = false;
    });
    // Open inspector modal only on explicit click, not on selection changes from drag operations.
    cardEl.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null) || null;
      if (target?.closest("button")) return;
      if (suppressClickOpen) {
        suppressClickOpen = false;
        return;
      }
      this.focusPromptInspectorForNode(controller, state.nodeId, false);
    });

    this.updatePromptNodeCard(controller, nodeController, state, canvasPath);
    return nodeController;
  }

  private updatePromptNodeCard(
    controller: LeafController,
    card: PromptNodeControllerState,
    state: PromptNodeRenderState,
    canvasPath: string
  ): void {
    card.promptFile = state.promptFile;
    card.titleEl.setText(state.promptFile.basename);

    const draftEntry = this.getPromptDraftEntry(controller, state);
    const draft = draftEntry.draft;
    const settingsModelSlug = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim();
    const serverModels = this.getCachedImageGenerationModels();
    const effectiveModel = getEffectiveDraftModel({
      explicitModel: draft.explicitModel,
      settingsModelSlug,
    });
    const badge = formatImageModelBadge(effectiveModel, serverModels);
    card.modelBadgeEl.setText(badge.text);
    card.modelBadgeEl.title = badge.title;

    card.metaEl.setText(
      this.formatPromptCardMeta({
        draft,
        effectiveModel,
        serverModels,
        isDirty: draftEntry.dirty,
      })
    );
    card.pathEl.setText(state.promptFile.path);
    card.pathEl.title = state.promptFile.path;
    card.cardEl.classList.toggle("is-dirty", draftEntry.dirty);
    card.excerptEl.setText(this.getPromptExcerpt(draft.body || state.promptBody));
    card.cardEl.classList.toggle("is-selected", controller.selectedPromptNodeId === state.nodeId);

    const runKey = this.getRunKey(canvasPath, state.nodeId);
    const running = this.runningNodeKeys.has(runKey);
    card.runBtn.disabled = running;
    card.runBtn.classList.toggle("ss-canvasflow-is-loading", running);
    card.runBtn.setText(running ? "Running..." : "Run");

    const isSelected = controller.selectedPromptNodeId === state.nodeId;
    if (running) {
      card.hintEl.setText("Running generation...");
    } else if (isSelected) {
      card.hintEl.setText("Editing in modal. Press Cmd/Ctrl+Enter to run.");
    } else if (draftEntry.dirty) {
      card.hintEl.setText("Unsaved edits. Select this node to review.");
    } else {
      card.hintEl.setText("Select this node to edit prompt settings.");
    }

    if (running) {
      const currentStatus = String(card.statusEl.textContent || "").trim();
      if (!currentStatus || /^unsaved edits\.?$/i.test(currentStatus)) {
        this.setPromptNodeStatus(card, "Running...");
      }
    } else if (draftEntry.dirty) {
      this.setPromptNodeStatus(card, "Unsaved edits.");
    } else if (/^(unsaved edits\.?|saved\.?|done\.?)$/i.test(String(card.statusEl.textContent || "").trim())) {
      this.setPromptNodeStatus(card, "");
    }
  }

  private async openPromptFileInEditor(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private focusPromptInspectorForNode(controller: LeafController, nodeId: string, focusPrompt: boolean): void {
    const state = controller.latestPromptStates.get(nodeId);
    if (!state) return;

    controller.selectedPromptNodeId = nodeId;
    for (const [id, nodeController] of controller.promptNodeControllers.entries()) {
      nodeController.cardEl.classList.toggle("is-selected", id === nodeId);
    }

    const inspector = this.ensurePromptInspector(controller);
    this.bindInspectorToPromptNode(controller, inspector, state, focusPrompt);
  }

  private ensurePromptInspector(controller: LeafController): PromptInspectorState {
    const existing = controller.inspector;
    if (existing) return existing;

    let inspectorRef: PromptInspectorState | null = null;
    const modal = new CanvasFlowPromptInspectorModal(
      this.app,
      () => {
        if (inspectorRef) {
          inspectorRef.isOpen = true;
        }
      },
      () => {
        const inspector = inspectorRef;
        if (!inspector) return;

        inspector.isOpen = false;
        const closedProgrammatically = inspector.closingProgrammatically;
        inspector.closingProgrammatically = false;
        inspector.boundNodeId = null;
        if (inspector.saveTimer !== null) {
          window.clearTimeout(inspector.saveTimer);
          inspector.saveTimer = null;
        }

        if (controller.inspector === inspector) {
          controller.inspector = null;
        }

        if (!closedProgrammatically) {
          this.handleManualInspectorClose(controller);
        }
      }
    );
    modal.modalEl.addClass("ss-canvasflow-inspector-modal");
    modal.titleEl.setText("SystemSculpt Prompt");

    const inspectorRoot = modal.contentEl.createDiv({ cls: "ss-canvasflow-inspector" });
    const header = inspectorRoot.createDiv({ cls: "ss-canvasflow-inspector-header" });
    const titleEl = header.createDiv({ cls: "ss-canvasflow-inspector-title" });
    const pathEl = header.createEl("code", { cls: "ss-canvasflow-inspector-path" });

    const fields = inspectorRoot.createDiv({ cls: "ss-canvasflow-fields ss-canvasflow-inspector-fields" });
    const createField = (label: string, cls = "ss-canvasflow-field") => {
      const field = fields.createDiv({ cls });
      field.createDiv({ text: label, cls: "ss-canvasflow-field-label" });
      return field;
    };

    const modelField = createField("Model (optional)");
    const modelSelect = modelField.createEl("select", { cls: "ss-canvasflow-model" });

    const imageCountField = createField("Images");
    const imageCountButtonsWrap = imageCountField.createDiv({ cls: "ss-canvasflow-choice-row ss-canvasflow-image-count-row" });
    const imageCountButtons: HTMLButtonElement[] = [];
    for (const n of [1, 2, 3, 4]) {
      const btn = imageCountButtonsWrap.createEl("button", {
        text: String(n),
        cls: "ss-canvasflow-choice-btn ss-canvasflow-image-count-btn",
      });
      btn.type = "button";
      btn.dataset.value = String(n);
      imageCountButtons.push(btn);
    }

    const aspectRatioField = createField("Aspect ratio");
    const aspectRatioButtonsWrap = aspectRatioField.createDiv({ cls: "ss-canvasflow-choice-row ss-canvasflow-aspect-ratio-row" });
    const aspectRatioButtons: HTMLButtonElement[] = [];
    for (const ratio of SIMPLE_ASPECT_RATIO_OPTIONS) {
      const btn = aspectRatioButtonsWrap.createEl("button", {
        text: ratio,
        cls: "ss-canvasflow-choice-btn ss-canvasflow-aspect-ratio-btn",
      });
      btn.type = "button";
      btn.dataset.value = ratio;
      aspectRatioButtons.push(btn);
    }

    inspectorRoot.createDiv({ text: "Prompt", cls: "ss-canvasflow-field-label ss-canvasflow-prompt-label" });
    const promptTextarea = inspectorRoot.createEl("textarea", { cls: "ss-canvasflow-prompt ss-canvasflow-inspector-prompt" });
    promptTextarea.placeholder = "What should happen next?";

    const actions = inspectorRoot.createDiv({ cls: "ss-canvasflow-actions ss-canvasflow-inspector-actions" });
    const openBtn = actions.createEl("button", { text: "Open", cls: "ss-canvasflow-btn" });
    openBtn.type = "button";
    const saveBtn = actions.createEl("button", { text: "Save", cls: "ss-canvasflow-btn" });
    saveBtn.type = "button";
    const runBtn = actions.createEl("button", { text: "Run", cls: "ss-canvasflow-btn ss-canvasflow-btn-primary" });
    runBtn.type = "button";
    const statusEl = inspectorRoot.createDiv({ cls: "ss-canvasflow-status ss-canvasflow-inspector-status" });
    statusEl.setText("");

    const inspector: PromptInspectorState = {
      modal,
      isOpen: false,
      closingProgrammatically: false,
      rootEl: inspectorRoot,
      titleEl,
      pathEl,
      modelSelect,
      imageCountButtons,
      aspectRatioButtons,
      promptTextarea,
      openBtn,
      saveBtn,
      runBtn,
      statusEl,
      boundNodeId: null,
      suppressDraftEvents: false,
      saveTimer: null,
      saveChain: Promise.resolve(),
    };
    inspectorRef = inspector;

    const onDraftInput = () => {
      const nodeId = this.updateDraftFromInspectorFields(controller, inspector);
      if (!nodeId) return;
      this.refreshPromptNodeCard(controller, nodeId);
    };

    const bindBlurSave = (el: HTMLElement) => {
      el.addEventListener("blur", () => {
        this.queueInspectorDraftSave(controller, inspector, "blur");
      });
    };

    modelSelect.addEventListener("change", () => {
      void queueCanvasFlowLastUsedPatch(this.plugin, {
        modelId: String(modelSelect.value || "").trim(),
      });
      onDraftInput();
    });
    bindBlurSave(modelSelect);

    for (const btn of imageCountButtons) {
      btn.addEventListener("click", (e) => {
        stopEvent(e);
        if (inspector.suppressDraftEvents) return;
        this.setActiveChoiceButtons(imageCountButtons, String(btn.dataset.value || "1"));
        void queueCanvasFlowLastUsedPatch(this.plugin, {
          imageCount: Number(btn.dataset.value || "1"),
        });
        onDraftInput();
        this.queueInspectorDraftSave(controller, inspector, "choice");
      });
    }

    for (const btn of aspectRatioButtons) {
      btn.addEventListener("click", (e) => {
        stopEvent(e);
        if (inspector.suppressDraftEvents) return;
        this.setActiveChoiceButtons(aspectRatioButtons, String(btn.dataset.value || DEFAULT_SIMPLE_ASPECT_RATIO));
        void queueCanvasFlowLastUsedPatch(this.plugin, {
          aspectRatio: String(btn.dataset.value || DEFAULT_SIMPLE_ASPECT_RATIO),
        });
        onDraftInput();
        this.queueInspectorDraftSave(controller, inspector, "choice");
      });
    }

    promptTextarea.addEventListener("input", onDraftInput);
    bindBlurSave(promptTextarea);

    promptTextarea.addEventListener("keydown", (e) => {
      const isModEnter = (e.key === "Enter" || e.code === "Enter") && (e.ctrlKey || e.metaKey);
      if (!isModEnter) return;
      e.preventDefault();
      const nodeId = inspector.boundNodeId;
      if (!nodeId) return;
      this.setInspectorStatus(inspector, "Saving...");
      void this.runPromptNodeWithDraftSave({
        controller,
        nodeId,
        status: (text) => this.setInspectorStatus(inspector, text),
      });
    });

    openBtn.addEventListener("click", (e) => {
      stopEvent(e);
      const nodeId = inspector.boundNodeId;
      if (!nodeId) return;
      const state = controller.latestPromptStates.get(nodeId);
      if (!state) return;
      void this.openPromptFileInEditor(state.promptFile);
    });

    saveBtn.addEventListener("click", (e) => {
      stopEvent(e);
      this.setInspectorStatus(inspector, "Saving...");
      void this.flushInspectorDraftSave(controller, inspector, "save");
    });

    runBtn.addEventListener("click", (e) => {
      stopEvent(e);
      const nodeId = inspector.boundNodeId;
      if (!nodeId) return;
      this.setInspectorStatus(inspector, "Saving...");
      void this.runPromptNodeWithDraftSave({
        controller,
        nodeId,
        status: (text) => this.setInspectorStatus(inspector, text),
      });
    });

    controller.inspector = inspector;
    return inspector;
  }

  private setActiveChoiceButtons(buttons: HTMLButtonElement[], value: string): void {
    const next = String(value || "").trim();
    for (const btn of buttons) {
      const isActive = String(btn.dataset.value || "").trim() === next;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  private getActiveChoiceValue(buttons: HTMLButtonElement[], fallback: string): string {
    const active = buttons.find((btn) => btn.classList.contains("is-active")) || null;
    const value = String(active?.dataset?.value || "").trim();
    return value || String(fallback || "").trim();
  }

  private handleManualInspectorClose(controller: LeafController): void {
    controller.selectedPromptNodeId = null;
    for (const nodeController of controller.promptNodeControllers.values()) {
      nodeController.cardEl.classList.remove("is-selected");
    }

    const root = this.canvasAdapter.getRoot(controller.leaf);
    this.canvasAdapter.clearSelection(controller.leaf, root);
    this.scheduleSelectionUiUpdate(controller);
  }

  private hidePromptInspector(controller: LeafController): void {
    const inspector = controller.inspector;
    if (!inspector) return;
    if (inspector.saveTimer !== null) {
      window.clearTimeout(inspector.saveTimer);
      inspector.saveTimer = null;
    }
    inspector.closingProgrammatically = true;
    try {
      inspector.modal.close();
    } catch {}
    if (controller.inspector === inspector) {
      controller.inspector = null;
    }
  }

  private syncPromptInspectorSelection(controller: LeafController, root: HTMLElement, canvasPath: string): void {
    if (controller.latestPromptStates.size === 0) {
      this.hidePromptInspector(controller);
      controller.selectedPromptNodeId = null;
      return;
    }

    const selectedNodeIds = this.canvasAdapter.getSelectedNodeIds(controller.leaf, root);
    const nextSelectedNodeId =
      selectedNodeIds.length === 1 && controller.latestPromptStates.has(selectedNodeIds[0]) ? selectedNodeIds[0] : null;
    controller.selectedPromptNodeId = nextSelectedNodeId;

    for (const [nodeId, nodeController] of controller.promptNodeControllers.entries()) {
      const state = controller.latestPromptStates.get(nodeId);
      if (!state) continue;
      nodeController.cardEl.classList.toggle("is-selected", nodeId === nextSelectedNodeId);
      this.updatePromptNodeCard(controller, nodeController, state, canvasPath);
      this.syncPromptNodeSizing(controller, state, nodeController, null);
    }

    if (!nextSelectedNodeId) {
      this.hidePromptInspector(controller);
      return;
    }

    const state = controller.latestPromptStates.get(nextSelectedNodeId);
    if (!state) {
      this.hidePromptInspector(controller);
      return;
    }

    const inspector = controller.inspector;
    if (!inspector) {
      return;
    }
    if (inspector.boundNodeId !== nextSelectedNodeId) {
      this.hidePromptInspector(controller);
      return;
    }

    const entry = this.getPromptDraftEntry(controller, state);
    if (entry.dirty) {
      this.setInspectorStatus(inspector, "Unsaved edits.");
      return;
    }

    this.bindInspectorToPromptNode(controller, inspector, state, false);
  }

  private bindInspectorToPromptNode(
    controller: LeafController,
    inspector: PromptInspectorState,
    state: PromptNodeRenderState,
    focusPrompt: boolean
  ): void {
    const draftEntry = this.getPromptDraftEntry(controller, state);
    const draft = cloneCanvasFlowPromptDraft(draftEntry.draft);
    const settingsModelSlug = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim();
    const preferredAspectCandidate = String(draft.aspectRatioPreset || draft.nano?.aspect_ratio || "").trim();
    const preferredAspect = SIMPLE_ASPECT_RATIO_OPTIONS.includes(preferredAspectCandidate as any)
      ? preferredAspectCandidate
      : DEFAULT_SIMPLE_ASPECT_RATIO;

    if (!inspector.isOpen) {
      inspector.modal.open();
    }

    inspector.suppressDraftEvents = true;
    inspector.boundNodeId = state.nodeId;
    inspector.modal.titleEl.setText(`SystemSculpt Prompt: ${state.promptFile.basename}`);
    inspector.titleEl.setText(state.promptFile.basename);
    inspector.pathEl.setText(state.promptFile.path);

    this.renderModelSelect(inspector.modelSelect, {
      settingsModelSlug,
      modelFromNote: draft.explicitModel || String(state.promptConfig.imageModelId || "").trim(),
      selectedValue: draft.explicitModel,
    });
    inspector.modelSelect.value = draft.explicitModel;
    this.setActiveChoiceButtons(inspector.imageCountButtons, String(clampImageCount(draft.imageCount)));
    this.setActiveChoiceButtons(inspector.aspectRatioButtons, preferredAspect);
    inspector.promptTextarea.value = draft.body;

    inspector.suppressDraftEvents = false;
    if (draftEntry.dirty) {
      this.setInspectorStatus(inspector, "Unsaved edits.");
    } else {
      this.setInspectorStatus(inspector, "");
    }

    if (focusPrompt) {
      window.setTimeout(() => {
        try {
          inspector.promptTextarea.focus();
          const end = inspector.promptTextarea.value.length;
          inspector.promptTextarea.setSelectionRange(end, end);
        } catch {}
      }, 0);
    }

    void this.refreshInspectorModelSelect(controller, inspector, state.nodeId);
  }

  private async refreshInspectorModelSelect(
    controller: LeafController,
    inspector: PromptInspectorState,
    nodeId: string
  ): Promise<void> {
    const updated = await this.refreshImageGenerationModelCatalogCache();
    if (!updated) return;
    if (!inspector.isOpen || inspector.boundNodeId !== nodeId) return;

    const state = controller.latestPromptStates.get(nodeId);
    if (!state) return;

    const entry = this.getPromptDraftEntry(controller, state);
    const settingsModelSlug = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim();
    const existingSelection = String(inspector.modelSelect.value || "").trim();
    this.renderModelSelect(inspector.modelSelect, {
      settingsModelSlug,
      modelFromNote: entry.draft.explicitModel || String(state.promptConfig.imageModelId || "").trim(),
      selectedValue: existingSelection || entry.draft.explicitModel,
    });
    inspector.modelSelect.value = existingSelection || String(entry.draft.explicitModel || "").trim();
    this.refreshPromptNodeCard(controller, nodeId);
  }

  private imageModelCatalogSignature(models: readonly ImageGenerationServerCatalogModel[]): string {
    return models
      .map((model) => ({
        id: String(model.id || "").trim(),
        name: String(model.name || "").trim(),
        provider: String(model.provider || "").trim(),
        supports_generation: typeof model.supports_generation === "boolean" ? model.supports_generation : false,
        supports_image_input: model.supports_image_input === true,
        max_images_per_job:
          typeof model.max_images_per_job === "number" && Number.isFinite(model.max_images_per_job)
            ? Math.max(1, Math.floor(model.max_images_per_job))
            : 0,
        default_aspect_ratio: String(model.default_aspect_ratio || "").trim(),
        estimated_cost_per_image_usd:
          typeof model.estimated_cost_per_image_usd === "number" && Number.isFinite(model.estimated_cost_per_image_usd)
            ? model.estimated_cost_per_image_usd
            : 0,
        estimated_cost_per_image_low_usd:
          typeof model.estimated_cost_per_image_low_usd === "number" &&
          Number.isFinite(model.estimated_cost_per_image_low_usd)
            ? model.estimated_cost_per_image_low_usd
            : 0,
        estimated_cost_per_image_high_usd:
          typeof model.estimated_cost_per_image_high_usd === "number" &&
          Number.isFinite(model.estimated_cost_per_image_high_usd)
            ? model.estimated_cost_per_image_high_usd
            : 0,
        pricing_source: String(model.pricing_source || "").trim(),
        input_modalities: Array.isArray(model.input_modalities)
          ? model.input_modalities.map((value) => String(value || "").trim()).filter(Boolean).sort()
          : [],
        output_modalities: Array.isArray(model.output_modalities)
          ? model.output_modalities.map((value) => String(value || "").trim()).filter(Boolean).sort()
          : [],
        allowed_aspect_ratios: Array.isArray(model.allowed_aspect_ratios)
          ? model.allowed_aspect_ratios.map((value) => String(value || "").trim()).filter(Boolean).sort()
          : [],
      }))
      .filter((model) => model.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => JSON.stringify(model))
      .join("|");
  }

  private async refreshImageGenerationModelCatalogCache(options?: { force?: boolean }): Promise<boolean> {
    const now = Date.now();
    if (
      options?.force !== true &&
      now - this.lastImageModelCatalogRefreshAt < CanvasFlowEnhancer.IMAGE_MODEL_CATALOG_REFRESH_INTERVAL_MS
    ) {
      return false;
    }

    if (this.imageModelCatalogRefreshInFlight) {
      return await this.imageModelCatalogRefreshInFlight;
    }

    const licenseKey = String(this.plugin.settings.licenseKey || "").trim();
    if (!licenseKey) {
      return false;
    }

    this.imageModelCatalogRefreshInFlight = (async () => {
      try {
        const current = this.getCachedImageGenerationModels();
        const service = new SystemSculptImageGenerationService({
          baseUrl: this.plugin.settings.serverUrl,
          licenseKey,
        });

        const systemCatalog = await service.listModels();
        const supportedModels = Array.isArray(systemCatalog.models) ? systemCatalog.models : [];
        if (supportedModels.length === 0) {
          return false;
        }
        const openRouterCatalog = await service.listOpenRouterMarketplaceImageModels().catch(() => []);
        const merged = mergeImageGenerationServerCatalogModels(
          supportedModels,
          openRouterCatalog
        );
        if (merged.length === 0) {
          return false;
        }

        const currentSig = this.imageModelCatalogSignature(current);
        const nextSig = this.imageModelCatalogSignature(merged);
        if (currentSig === nextSig) {
          return false;
        }

        await this.plugin.getSettingsManager().updateSettings({
          imageGenerationModelCatalogCache: {
            fetchedAt: new Date().toISOString(),
            models: merged,
          },
        });
        return true;
      } catch (error) {
        console.warn("[CanvasFlow] Failed to refresh image model catalog for inspector dropdown.", error);
        return false;
      } finally {
        this.lastImageModelCatalogRefreshAt = Date.now();
      }
    })();

    try {
      return await this.imageModelCatalogRefreshInFlight;
    } finally {
      this.imageModelCatalogRefreshInFlight = null;
    }
  }

  private setInspectorStatus(inspector: PromptInspectorState, text: string): void {
    inspector.statusEl.setText(String(text || ""));
    const lower = String(text || "").toLowerCase();
    inspector.statusEl.classList.toggle("ss-is-error", /\b(failed|error)\b/.test(lower));
    inspector.statusEl.classList.toggle("ss-is-success", /\bdone|saved\b/.test(lower));
  }

  private updateDraftFromInspectorFields(controller: LeafController, inspector: PromptInspectorState): string | null {
    if (inspector.suppressDraftEvents) return null;
    const nodeId = String(inspector.boundNodeId || "").trim();
    if (!nodeId) return null;

    const state = controller.latestPromptStates.get(nodeId);
    if (!state) return null;

    const entry = this.getPromptDraftEntry(controller, state);
    const nextDraft: CanvasFlowPromptDraft = cloneCanvasFlowPromptDraft(entry.draft);
    nextDraft.body = inspector.promptTextarea.value;
    nextDraft.explicitModel = String(inspector.modelSelect.value || "").trim();
    nextDraft.seedText = "";
    nextDraft.imageCount = clampImageCount(Number(this.getActiveChoiceValue(inspector.imageCountButtons, "1")));
    nextDraft.aspectRatioPreset = this.getActiveChoiceValue(inspector.aspectRatioButtons, DEFAULT_SIMPLE_ASPECT_RATIO);
    nextDraft.widthText = "";
    nextDraft.heightText = "";
    nextDraft.nano = {
      aspect_ratio: nextDraft.aspectRatioPreset || DEFAULT_SIMPLE_ASPECT_RATIO,
      resolution: "4K",
      output_format: "jpg",
      safety_filter_level: "block_only_high",
    };

    entry.draft = nextDraft;
    entry.dirty = true;
    controller.promptDrafts.set(state.promptFile.path, entry);
    this.setInspectorStatus(inspector, "Unsaved edits.");
    return nodeId;
  }

  private queueInspectorDraftSave(controller: LeafController, inspector: PromptInspectorState, reason: string): void {
    if (inspector.saveTimer !== null) {
      window.clearTimeout(inspector.saveTimer);
    }
    inspector.saveTimer = window.setTimeout(() => {
      inspector.saveTimer = null;
      void this.flushInspectorDraftSave(controller, inspector, reason);
    }, 160);
  }

  private async flushInspectorDraftSave(
    controller: LeafController,
    inspector: PromptInspectorState,
    reason: string
  ): Promise<void> {
    if (inspector.saveTimer !== null) {
      window.clearTimeout(inspector.saveTimer);
      inspector.saveTimer = null;
    }
    const nodeId = String(inspector.boundNodeId || "").trim();
    if (!nodeId) return;
    inspector.saveChain = inspector.saveChain.then(async () => {
      await this.flushPromptDraft(controller, nodeId, reason, (status) => this.setInspectorStatus(inspector, status));
    });
    await inspector.saveChain;
  }

  private async flushPromptDraft(
    controller: LeafController,
    nodeId: string,
    reason: string,
    status?: (status: string) => void
  ): Promise<boolean> {
    const promptState = controller.latestPromptStates.get(nodeId);
    if (!promptState) return false;

    const entry = this.getPromptDraftEntry(controller, promptState);
    if (!entry.dirty && reason !== "run") {
      return true;
    }

    const draft = cloneCanvasFlowPromptDraft(entry.draft);
    const settingsModelSlug = String(this.plugin.settings.imageGenerationDefaultModelId || "").trim();
    const selectedSimpleRatioCandidate = String(draft.aspectRatioPreset || draft.nano?.aspect_ratio || "").trim();
    const selectedSimpleRatio = SIMPLE_ASPECT_RATIO_OPTIONS.includes(selectedSimpleRatioCandidate as any)
      ? selectedSimpleRatioCandidate
      : DEFAULT_SIMPLE_ASPECT_RATIO;

    try {
      status?.("Saving...");
      const raw = await this.app.vault.read(promptState.promptFile);
      const parsed = parseMarkdownFrontmatter(raw);
      if (!parsed.ok) {
        throw new Error(parsed.reason);
      }

      const nextFrontmatter: Record<string, unknown> = { ...(parsed.frontmatter || {}) };
      nextFrontmatter["ss_flow_kind"] = "prompt";
      nextFrontmatter["ss_flow_backend"] = "openrouter";

      const explicitModel = String(draft.explicitModel || "").trim();
      if (explicitModel) {
        nextFrontmatter["ss_image_model"] = explicitModel;
      } else {
        delete nextFrontmatter["ss_image_model"];
      }

      delete nextFrontmatter["ss_seed"];

      const imageCount = clampImageCount(draft.imageCount);
      if (imageCount > 1) {
        nextFrontmatter["ss_image_count"] = imageCount;
      } else {
        delete nextFrontmatter["ss_image_count"];
      }

      delete nextFrontmatter["ss_image_width"];
      delete nextFrontmatter["ss_image_height"];

      const effectiveModel = getEffectiveDraftModel({
        explicitModel,
        settingsModelSlug,
      });
      const existingInput = readRecord(nextFrontmatter["ss_image_options"]);
      const nextInput: Record<string, unknown> = { ...existingInput };

      if (effectiveModel === "google/nano-banana-pro") {
        nextInput.aspect_ratio = selectedSimpleRatio;
        nextInput.resolution = "4K";
        nextInput.output_format = "jpg";
        nextInput.safety_filter_level = "block_only_high";
      } else {
        delete (nextInput as any).aspect_ratio;
        delete (nextInput as any).resolution;
        delete (nextInput as any).output_format;
        delete (nextInput as any).safety_filter_level;
      }

      delete (nextInput as any).width;
      delete (nextInput as any).height;

      nextFrontmatter["ss_image_options"] = nextInput;
      if (effectiveModel === "google/nano-banana-pro") {
        delete nextFrontmatter["ss_image_aspect_ratio"];
      } else {
        nextFrontmatter["ss_image_aspect_ratio"] = selectedSimpleRatio;
      }

      const updated = replaceMarkdownFrontmatterAndBody(raw, nextFrontmatter, draft.body);
      if (updated !== raw) {
        await this.app.vault.modify(promptState.promptFile, updated);
        controllerSafeUpdateCache(controller, promptState.promptFile.path);

        const reparsed = parseCanvasFlowPromptNote(updated);
        if (reparsed.ok) {
          promptState.promptBody = String(reparsed.body || "").trim();
          promptState.promptFrontmatter = reparsed.frontmatter;
          promptState.promptConfig = reparsed.config;
          promptState.promptMtime = promptState.promptFile.stat?.mtime ?? Date.now();
        }
      }

      entry.dirty = false;
      entry.sourceMtime = promptState.promptFile.stat?.mtime ?? Date.now();
      controller.promptDrafts.set(promptState.promptFile.path, entry);
      this.refreshPromptNodeCard(controller, nodeId);

      status?.("Saved.");
      return true;
    } catch (error: any) {
      status?.("Save failed.");
      new Notice(`SystemSculpt: failed to save prompt: ${error?.message || error}`);
      return false;
    }
  }

  private async runPromptNodeWithDraftSave(options: {
    controller: LeafController;
    nodeId: string;
    status?: (status: string) => void;
  }): Promise<void> {
    const nodeId = String(options.nodeId || "").trim();
    if (!nodeId) return;

    const canvasFile = this.getActiveCanvasFile(options.controller);
    if (!canvasFile) {
      new Notice("SystemSculpt: canvas file not found.");
      return;
    }

    const runKey = this.getRunKey(canvasFile.path, nodeId);
    if (this.runningNodeKeys.has(runKey)) {
      return;
    }

    this.runningNodeKeys.add(runKey);
    this.clearPromptSelectionAfterRun(options.controller, nodeId);
    this.refreshPromptNodeCard(options.controller, nodeId);

    const inspector = options.controller.inspector;
    if (inspector?.boundNodeId === nodeId) {
      inspector.runBtn.disabled = true;
    }

    try {
      const saved = await this.flushPromptDraft(options.controller, nodeId, "run", options.status);
      if (!saved) return;

      options.status?.("Running...");
      if (inspector?.boundNodeId === nodeId) {
        this.setInspectorStatus(inspector, "Running...");
      }

      await this.runner.runPromptNode({
        canvasFile,
        promptNodeId: nodeId,
        status: (statusText) => {
          options.status?.(statusText);
          if (inspector?.boundNodeId === nodeId) {
            this.setInspectorStatus(inspector, statusText);
          }
        },
      });
    } catch (error: any) {
      const message = String(error?.message || error || "Run failed");
      options.status?.(message);
      if (inspector?.boundNodeId === nodeId) {
        this.setInspectorStatus(inspector, message);
      }
      new Notice(`SystemSculpt run failed: ${message}`);
    } finally {
      this.runningNodeKeys.delete(runKey);
      if (inspector?.boundNodeId === nodeId) {
        inspector.runBtn.disabled = false;
      }
      this.refreshPromptNodeCard(options.controller, nodeId);
    }
  }

  private clearPromptSelectionAfterRun(controller: LeafController, nodeId: string): void {
    const root = this.canvasAdapter.getRoot(controller.leaf);
    this.canvasAdapter.clearSelection(controller.leaf, root);

    if (controller.selectedPromptNodeId === nodeId) {
      controller.selectedPromptNodeId = null;
    }
    for (const nodeController of controller.promptNodeControllers.values()) {
      nodeController.cardEl.classList.remove("is-selected");
    }

    if (controller.inspector?.boundNodeId === nodeId) {
      this.hidePromptInspector(controller);
    }

    this.scheduleSelectionUiUpdate(controller);
  }

  private enforcePromptNodeSizing(nodeEl: HTMLElement, options?: { widthPx?: number; heightPx?: number }): void {
    const requestedWidth = Math.floor(Number(options?.widthPx ?? CANVASFLOW_PROMPT_NODE_WIDTH_PX));
    const widthPx = Math.max(
      CANVASFLOW_PROMPT_NODE_MIN_WIDTH_PX,
      Math.min(CANVASFLOW_PROMPT_NODE_MAX_WIDTH_PX, Number.isFinite(requestedWidth) ? requestedWidth : CANVASFLOW_PROMPT_NODE_WIDTH_PX)
    );
    const requestedHeight = Math.floor(Number(options?.heightPx ?? CANVASFLOW_PROMPT_NODE_HEIGHT_PX));
    const heightPx = Math.max(
      CANVASFLOW_PROMPT_NODE_MIN_HEIGHT_PX,
      Math.min(CANVASFLOW_PROMPT_NODE_MAX_HEIGHT_PX, Number.isFinite(requestedHeight) ? requestedHeight : CANVASFLOW_PROMPT_NODE_HEIGHT_PX)
    );
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

  private tryFocusPendingPrompt(controller: LeafController): void {
    const nodeId = String(controller.pendingFocusNodeId || "").trim();
    if (!nodeId) {
      controller.pendingFocusAttempts = 0;
      return;
    }

    if (!controller.latestPromptStates.has(nodeId)) {
      controller.pendingFocusAttempts += 1;
      if (controller.pendingFocusAttempts > 25) {
        controller.pendingFocusNodeId = null;
        controller.pendingFocusAttempts = 0;
      }
      return;
    }

    controller.pendingFocusNodeId = null;
    controller.pendingFocusAttempts = 0;
    this.focusPromptInspectorForNode(controller, nodeId, true);
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

    const selectedIds = this.canvasAdapter.getSelectedNodeIds(options.controller.leaf, options.root);
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

          const runKey = this.getRunKey(canvasPath, nodeId);
          if (this.runningNodeKeys.has(runKey)) {
            return;
          }

          const controller = this.findControllerForCanvasPath(canvasPath);
          if (!controller) {
            new Notice("SystemSculpt: canvas controller not found.");
            return;
          }

          const originalLabel = btn.getAttribute("aria-label") || "SystemSculpt - Run";
          btn.disabled = true;
          btn.classList.add("ss-canvasflow-is-loading");
          this.setMenuButtonIcon(btn, "loader");
          btn.setAttribute("aria-label", "SystemSculpt - Running...");
          void this.runPromptNodeWithDraftSave({
            controller,
            nodeId,
            status: (status) => {
              btn.setAttribute("aria-label", `SystemSculpt - ${status}`);
            },
          }).finally(() => {
            const runningNow = this.runningNodeKeys.has(runKey);
            btn.disabled = runningNow;
            btn.classList.toggle("ss-canvasflow-is-loading", runningNow);
            this.setMenuButtonIcon(btn, runningNow ? "loader" : "play");
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

      const defaults = resolveCanvasFlowPromptDefaults({
        settings: this.plugin.settings,
        serverModels: this.getCachedImageGenerationModels(),
        source: "image-node",
      });
      const modelId = defaults.modelId;
      const promptImageCount = defaults.imageCount;
      const promptAspectRatio = defaults.aspectRatio;

      btn.classList.add("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, "loader");
      btn.setAttribute("aria-label", "SystemSculpt - Creating Prompt...");

      const imageOptions: Record<string, unknown> =
        modelId === "google/nano-banana-pro"
          ? {
              aspect_ratio: promptAspectRatio || "match_input_image",
              resolution: "4K",
              output_format: "jpg",
              safety_filter_level: "block_only_high",
            }
          : {};

      const created = await this.createPromptNodeConnectedToImage({
        canvasFile: canvasAbs,
        doc,
        imageNodeId,
        imageNode,
        modelId,
        imageCount: promptImageCount,
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
    imageCount: number;
    aspectRatio: string;
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
      `ss_image_count: ${Math.max(1, Math.min(4, Math.floor(options.imageCount || 1)))}`,
      `ss_image_aspect_ratio: ${String(options.aspectRatio || "").trim() || "1:1"}`,
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
