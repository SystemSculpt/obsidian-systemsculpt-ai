import { App, Notice, Platform, setIcon, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import YAML from "yaml";
import type SystemSculptPlugin from "../../main";
import {
  findCanvasNodeContentHost,
  findCanvasNodeElements,
  findCanvasNodeElementsFromInternalCanvas,
  getCanvasNodeId,
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
  canvasFilePath: string | null;
  canvasFileMtime: number;
  cachedCanvasDoc: ReturnType<typeof parseCanvasDocument> | null;
  promptFileCache: Map<string, PromptCacheEntry>;
  pendingFocusNodeId: string | null;
  pendingFocusAttempts: number;
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

export class CanvasFlowEnhancer {
  private readonly controllers = new Map<WorkspaceLeaf, LeafController>();
  private readonly runner: CanvasFlowRunner;
  private runningNodeKeys = new Set<string>();
  private creatingFromImageKeys = new Set<string>();
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
      observer: new MutationObserver(() => {
        this.scheduleUpdate(controller);
      }),
      updating: false,
      pending: false,
      canvasFilePath: null,
      canvasFileMtime: 0,
      cachedCanvasDoc: null,
      promptFileCache: new Map(),
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
    }, 0);
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
    if (controller.canvasFilePath !== canvasFile.path || controller.canvasFileMtime !== canvasMtime) {
      controller.canvasFilePath = canvasFile.path;
      controller.canvasFileMtime = canvasMtime;
      const raw = await this.app.vault.read(canvasFile);
      controller.cachedCanvasDoc = parseCanvasDocument(raw);
    }

    const doc = controller.cachedCanvasDoc;
    if (!doc) return;
    const { nodesById } = indexCanvas(doc);

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
    const host = findCanvasNodeContentHost(options.nodeEl);
    const settingsModelSlug = String(this.plugin.settings.replicateDefaultModelSlug || "").trim();
    const modelFromNote = String(options.promptConfig.replicateModelSlug || "").trim();
    const versionFromNote = String(options.promptConfig.replicateVersionId || "").trim();
    const effectiveModelSlug = modelFromNote || settingsModelSlug;

    const replicateInputRaw = readRecord(options.promptFrontmatter["ss_replicate_input"]);
    const nanoDefaults = {
      aspect_ratio: readString(replicateInputRaw["aspect_ratio"]) || "match_input_image",
      resolution: readString(replicateInputRaw["resolution"]) || "4K",
      output_format: readString(replicateInputRaw["output_format"]) || "jpg",
      safety_filter_level: readString(replicateInputRaw["safety_filter_level"]) || "block_only_high",
    };

    const existing = host.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(options.nodeId)}"]`);
    if (existing) {
      options.nodeEl.classList.add("ss-canvasflow-prompt-node");

      const textarea = existing.querySelector<HTMLTextAreaElement>("textarea.ss-canvasflow-prompt");
      if (textarea && textarea.value !== options.promptBody && textarea !== document.activeElement) {
        textarea.value = options.promptBody;
      }

      const modelInput = existing.querySelector<HTMLInputElement>("input.ss-canvasflow-model");
      if (modelInput && modelInput.value !== modelFromNote && modelInput !== document.activeElement) {
        modelInput.value = modelFromNote;
      }

      const versionInput = existing.querySelector<HTMLInputElement>("input.ss-canvasflow-version");
      if (versionInput && versionInput.value !== versionFromNote && versionInput !== document.activeElement) {
        versionInput.value = versionFromNote;
      }

      const modelBadge = existing.querySelector<HTMLElement>("[data-ss-canvasflow-model-badge]");
      if (modelBadge) {
        modelBadge.setText(effectiveModelSlug || "(no model)");
      }

      const isNano = effectiveModelSlug === "google/nano-banana-pro";
      const nanoWrap = existing.querySelector<HTMLElement>(".ss-canvasflow-nano-config");
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

    const controls = host.createDiv({ cls: "ss-canvasflow-controls" });
    controls.dataset.ssNodeId = options.nodeId;

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
    header.createDiv({ text: "CanvasFlow Prompt", cls: "ss-canvasflow-node-title" });
    const badges = header.createDiv({ cls: "ss-canvasflow-node-badges" });
    badges.createEl("code", { text: options.promptFile.basename, cls: "ss-canvasflow-node-badge" });
    const modelBadge = badges.createEl("code", { text: effectiveModelSlug || "(no model)", cls: "ss-canvasflow-node-badge" });
    modelBadge.dataset.ssCanvasflowModelBadge = "true";

    const fields = controls.createDiv({ cls: "ss-canvasflow-fields" });

    const modelField = fields.createDiv({ cls: "ss-canvasflow-field" });
    modelField.createDiv({ text: "Model (optional)", cls: "ss-canvasflow-field-label" });
    const modelInput = modelField.createEl("input", { cls: "ss-canvasflow-field-input ss-canvasflow-model" });
    modelInput.type = "text";
    modelInput.value = modelFromNote;
    modelInput.placeholder = settingsModelSlug ? `Default: ${settingsModelSlug}` : "owner/model";

    const versionField = fields.createDiv({ cls: "ss-canvasflow-field" });
    versionField.createDiv({ text: "Version (optional)", cls: "ss-canvasflow-field-label" });
    const versionInput = versionField.createEl("input", { cls: "ss-canvasflow-field-input ss-canvasflow-version" });
    versionInput.type = "text";
    versionInput.value = versionFromNote;
    versionInput.placeholder = "Pinned Replicate version id";

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
      const explicit = String(modelInput.value || "").trim();
      return explicit || settingsModelSlug;
    };

    const updateModelBadgeAndVisibility = () => {
      const effective = getEffectiveModel();
      modelBadge.setText(effective || "(no model)");
      nanoWrap.style.display = effective === "google/nano-banana-pro" ? "" : "none";
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
        nextFrontmatter["ss_flow_backend"] = "replicate";

        const explicitModel = String(modelInput.value || "").trim();
        const explicitVersion = String(versionInput.value || "").trim();
        if (explicitModel) {
          nextFrontmatter["ss_replicate_model"] = explicitModel;
        } else {
          delete nextFrontmatter["ss_replicate_model"];
        }
        if (explicitVersion) {
          nextFrontmatter["ss_replicate_version"] = explicitVersion;
        } else {
          delete nextFrontmatter["ss_replicate_version"];
        }

        const effectiveModel = explicitModel || settingsModelSlug;
        const existingInput = readRecord(nextFrontmatter["ss_replicate_input"]);
        const nextInput: Record<string, unknown> = { ...existingInput };

        if (effectiveModel === "google/nano-banana-pro") {
          nextInput.aspect_ratio = aspectRatioSelect.value;
          nextInput.resolution = resolutionSelect.value;
          nextInput.output_format = outputFormatSelect.value;
          nextInput.safety_filter_level = safetySelect.value;
        }

        nextFrontmatter["ss_replicate_input"] = nextInput;

        // Make Nano Banana work out of the box when a model is explicitly chosen.
        const currentImageKey = String(nextFrontmatter["ss_replicate_image_key"] || "").trim();
        if (explicitModel) {
          if (explicitModel === "google/nano-banana-pro") {
            nextFrontmatter["ss_replicate_image_key"] = "image_input";
          } else if (currentImageKey === "image_input") {
            delete nextFrontmatter["ss_replicate_image_key"];
          }
        }

        const updated = replaceMarkdownFrontmatterAndBody(raw, nextFrontmatter, textarea.value);
        if (updated !== raw) {
          await this.app.vault.modify(options.promptFile, updated);
          controllerSafeUpdateCache(this.controllers.get(options.leaf), options.promptFile.path);
        }

        if (reason === "run") {
          setStatus("Saved.");
        }
      } catch (error: any) {
        setStatus("Save failed.");
        new Notice(`CanvasFlow: failed to save prompt: ${error?.message || error}`);
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

    textarea.addEventListener("input", () => {
      scheduleSave("auto");
    });

    textarea.addEventListener("blur", () => {
      scheduleSave("blur");
    });

    modelInput.addEventListener("input", () => {
      updateModelBadgeAndVisibility();
      scheduleSave("model");
    });

    versionInput.addEventListener("input", () => {
      scheduleSave("version");
    });

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
        new Notice(`CanvasFlow run failed: ${error?.message || error}`);
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

  private getSelectedNodeIdsInternal(leaf: WorkspaceLeaf): string[] | null {
    const viewAny = (leaf.view as any) || null;
    const canvas = viewAny?.canvas || null;
    if (!canvas) {
      return null;
    }

    const tryExtract = (value: any): string[] | null => {
      if (!value) return null;

      // Some builds may wrap selection in an object.
      const nested = value?.nodes ?? value?.items ?? value?.selected ?? value?.selection ?? null;
      if (nested && nested !== value) {
        const inner = tryExtract(nested);
        if (inner) return inner;
      }

      const ids: string[] = [];
      const pushMaybeId = (item: any) => {
        const id = String(item?.id || item?.node?.id || "").trim();
        if (id) ids.push(id);
      };

      try {
        if (typeof value?.[Symbol.iterator] === "function") {
          for (const item of value as any) {
            pushMaybeId(item);
          }
        } else if (typeof value?.forEach === "function") {
          value.forEach((item: any) => pushMaybeId(item));
        } else if (Array.isArray(value)) {
          value.forEach((item) => pushMaybeId(item));
        }
      } catch {
        // Ignore and fall back.
      }

      const deduped = dedupeStable(ids);
      return deduped.length ? deduped : null;
    };

    return (
      tryExtract(canvas.selection) ||
      tryExtract(canvas.selectionManager?.selection) ||
      tryExtract(canvas.selectionManager?.selected) ||
      tryExtract(canvas.selectionManager?.selectedNodes) ||
      null
    );
  }

  private getSelectedNodeIds(root: HTMLElement): string[] {
    // Obsidian Canvas uses `.canvas-node.is-selected` for selected items.
    const selectedEls = Array.from(root.querySelectorAll<HTMLElement>(".canvas-node.is-selected"));
    const ids = selectedEls.map(getCanvasNodeId).filter(Boolean) as string[];
    return dedupeStable(ids);
  }

  private findCanvasSelectionMenu(root: HTMLElement): HTMLElement | null {
    // This is the floating selection menu you see when selecting a node: trash, palette, zoom-to-selection, edit.
    const doc = root.ownerDocument || document;

    const inRoot =
      root.querySelector<HTMLElement>(".canvas-menu-container .canvas-menu") ||
      root.querySelector<HTMLElement>(".canvas-menu");
    if (inRoot) return inRoot;

    const leafEl = root.closest<HTMLElement>(".workspace-leaf");
    if (leafEl) {
      const inLeaf =
        leafEl.querySelector<HTMLElement>(".canvas-menu-container .canvas-menu") ||
        leafEl.querySelector<HTMLElement>(".canvas-menu");
      if (inLeaf) return inLeaf;
    }

    // Fallback: look globally. Prefer a visible menu.
    const all = Array.from(doc.querySelectorAll<HTMLElement>(".canvas-menu"));
    const win = doc.defaultView || window;
    for (const el of all) {
      try {
        const style = win.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return el;
        }
      } catch {}
    }
    return all[0] || null;
  }

  private ensureMenuRunButton(menuEl: HTMLElement): HTMLButtonElement {
    const existing = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-run");
    if (existing) {
      return existing;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clickable-icon ss-canvasflow-menu-run";
    btn.setAttribute("aria-label", "CanvasFlow: Run");
    btn.setAttribute("data-tooltip-position", "top");
    this.setMenuButtonIcon(btn, "play");

    // Append to the end so it becomes the 5th icon (after trash/palette/zoom/edit).
    menuEl.appendChild(btn);
    return btn;
  }

  private removeMenuRunButton(menuEl: HTMLElement): void {
    menuEl.querySelectorAll(".ss-canvasflow-menu-run").forEach((el) => el.remove());
  }

  private ensureMenuNewPromptButton(menuEl: HTMLElement): HTMLButtonElement {
    const existing = menuEl.querySelector<HTMLButtonElement>("button.ss-canvasflow-menu-new-prompt");
    if (existing) {
      return existing;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clickable-icon ss-canvasflow-menu-new-prompt";
    btn.setAttribute("aria-label", "CanvasFlow: New prompt");
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

  private async ensureSelectionMenuButtons(options: {
    controller: LeafController;
    root: HTMLElement;
    canvasFile: TFile;
    nodesById: Map<string, any>;
  }): Promise<void> {
    const menuEl = this.findCanvasSelectionMenu(options.root);
    if (!menuEl) {
      return;
    }

    const internalSelection = this.getSelectedNodeIdsInternal(options.controller.leaf);
    const selectedIds = internalSelection !== null ? internalSelection : this.getSelectedNodeIds(options.root);
    if (selectedIds.length !== 1) {
      this.removeMenuRunButton(menuEl);
      this.removeMenuNewPromptButton(menuEl);
      return;
    }

    const selectedNodeId = selectedIds[0];
    const node = options.nodesById.get(selectedNodeId);
    if (!node || !isCanvasFileNode(node)) {
      this.removeMenuRunButton(menuEl);
      this.removeMenuNewPromptButton(menuEl);
      return;
    }

    const filePath = String(node.file || "");
    const lower = filePath.toLowerCase();

    // CanvasFlow prompt note -> show Run button.
    if (lower.endsWith(".md")) {
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
            new Notice("CanvasFlow: canvas file not found.");
            return;
          }

          const runKey = this.getRunKey(canvasPath, nodeId);
          if (this.runningNodeKeys.has(runKey)) {
            return;
          }

          const originalLabel = btn.getAttribute("aria-label") || "CanvasFlow: Run";
          btn.disabled = true;
          btn.classList.add("ss-canvasflow-is-loading");
          this.setMenuButtonIcon(btn, "loader");
          btn.setAttribute("aria-label", "CanvasFlow: Running...");

          this.runningNodeKeys.add(runKey);
          void this.runner
            .runPromptNode({
              canvasFile: canvasAbs,
              promptNodeId: nodeId,
              status: (status) => {
                btn.setAttribute("aria-label", `CanvasFlow: ${status}`);
              },
            })
            .catch((error: any) => {
              new Notice(`CanvasFlow run failed: ${error?.message || error}`);
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

      const btn = this.ensureMenuNewPromptButton(menuEl);
      btn.dataset.ssCanvasflowCanvasPath = options.canvasFile.path;
      btn.dataset.ssCanvasflowImageNodeId = selectedNodeId;

      const createKey = this.getCreateKey(options.canvasFile.path, selectedNodeId);
      const creating = this.creatingFromImageKeys.has(createKey);
      btn.disabled = creating;
      btn.classList.toggle("ss-canvasflow-is-loading", creating);
      this.setMenuButtonIcon(btn, creating ? "loader" : "sparkles");

      if (!(btn as any).__ssCanvasflowNewPromptBound) {
        (btn as any).__ssCanvasflowNewPromptBound = true;
        btn.addEventListener("click", (e) => {
          stopEvent(e);
          void this.handleCreatePromptFromSelectedImage(btn);
        });
      }

      return;
    }

    // Default: neither prompt nor image.
    this.removeMenuRunButton(menuEl);
    this.removeMenuNewPromptButton(menuEl);
  }

  private getCreateKey(canvasPath: string, imageNodeId: string): string {
    return `${canvasPath}::image::${imageNodeId}`;
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

  private async handleCreatePromptFromSelectedImage(btn: HTMLButtonElement): Promise<void> {
    const canvasPath = String(btn.dataset.ssCanvasflowCanvasPath || "").trim();
    const imageNodeId = String(btn.dataset.ssCanvasflowImageNodeId || "").trim();
    if (!canvasPath || !imageNodeId) {
      return;
    }

    const canvasAbs = this.app.vault.getAbstractFileByPath(canvasPath);
    if (!(canvasAbs instanceof TFile)) {
      new Notice("CanvasFlow: canvas file not found.");
      return;
    }

    const createKey = this.getCreateKey(canvasPath, imageNodeId);
    if (this.creatingFromImageKeys.has(createKey)) {
      return;
    }

    const originalLabel = btn.getAttribute("aria-label") || "CanvasFlow: New prompt";
    const originalIcon = String(btn.getAttribute("data-ss-canvasflow-icon") || "sparkles");

    this.creatingFromImageKeys.add(createKey);
    btn.disabled = true;

    try {
      const canvasRaw = await this.app.vault.read(canvasAbs);
      const doc = parseCanvasDocument(canvasRaw);
      if (!doc) {
        new Notice("CanvasFlow: failed to parse .canvas file.");
        return;
      }

      const { nodesById } = indexCanvas(doc);
      const imageNode = nodesById.get(imageNodeId);
      if (!imageNode || !isCanvasFileNode(imageNode)) {
        new Notice("CanvasFlow: selected node is not a file node.");
        return;
      }

      const imagePath = String(imageNode.file || "").trim();
      if (!imagePath || !isImagePath(imagePath)) {
        new Notice("CanvasFlow: selected node is not an image.");
        return;
      }

      const modelSlug = String(this.plugin.settings.replicateDefaultModelSlug || "").trim();
      if (!modelSlug) {
        new Notice("CanvasFlow: set a default Replicate model first (Settings -> Image Generation).");
        return;
      }

      btn.classList.add("ss-canvasflow-is-loading");
      this.setMenuButtonIcon(btn, "loader");
      btn.setAttribute("aria-label", "CanvasFlow: Creating prompt...");

      const replicateInput: Record<string, unknown> =
        modelSlug === "google/nano-banana-pro"
          ? {
              aspect_ratio: "match_input_image",
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
        modelSlug,
        promptText: "",
        replicateInput,
      });

      const controller = this.findControllerForCanvasPath(canvasPath);
      if (controller) {
        controller.pendingFocusNodeId = created.promptNodeId;
        controller.pendingFocusAttempts = 0;
        this.scheduleUpdate(controller);
      }

      new Notice("CanvasFlow: prompt created. Type your prompt and press Cmd/Ctrl+Enter to run.");
    } catch (error: any) {
      new Notice(`CanvasFlow: failed to create prompt: ${error?.message || error}`);
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
    modelSlug: string;
    promptText: string;
    replicateInput: Record<string, unknown>;
  }): Promise<{ promptNodeId: string; promptFile: TFile }> {
    const promptsDir = "SystemSculpt/CanvasFlow/Prompts";
    await this.ensureFolder(promptsDir);

    const imageKeyLine = options.modelSlug === "google/nano-banana-pro" ? "ss_replicate_image_key: image_input" : "";
    const inputLines = this.formatReplicateInputFrontmatter(options.replicateInput);

    const template = [
      "---",
      "ss_flow_kind: prompt",
      "ss_flow_backend: replicate",
      `ss_replicate_model: ${options.modelSlug}`,
      imageKeyLine,
      ...inputLines,
      "---",
      "",
      String(options.promptText || "").trim(),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

    const notePath = await this.getAvailableNotePath(promptsDir, `CanvasFlow Prompt ${this.nowStamp()}`);
    const promptFile = await this.app.vault.create(notePath, template.endsWith("\n") ? template : `${template}\n`);

    const placed = computeNextNodePosition(options.imageNode, { dx: 80, defaultWidth: 420, defaultHeight: 260 });
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
    const safeBase = sanitizeChatTitle(baseName).trim() || "CanvasFlow Prompt";
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

  private formatReplicateInputFrontmatter(input: Record<string, unknown>): string[] {
    const keys = Object.keys(input || {});
    if (keys.length === 0) {
      return ["ss_replicate_input: {}"];
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

    return ["ss_replicate_input:", indented];
  }
}

function controllerSafeUpdateCache(controller: LeafController | undefined, promptPath: string): void {
  if (!controller) return;
  controller.promptFileCache.delete(promptPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = String(v || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
