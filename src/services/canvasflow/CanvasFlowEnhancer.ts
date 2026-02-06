import { App, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { findCanvasNodeContentHost, findCanvasNodeElements, getCanvasNodeId } from "./CanvasDomAdapter";
import { indexCanvas, isCanvasFileNode, parseCanvasDocument } from "./CanvasFlowGraph";
import { parseCanvasFlowPromptNote, replaceMarkdownBodyPreservingFrontmatter } from "./PromptNote";
import { CanvasFlowRunner } from "./CanvasFlowRunner";

type LeafController = {
  leaf: WorkspaceLeaf;
  observer: MutationObserver;
  updating: boolean;
  pending: boolean;
  canvasFilePath: string | null;
  canvasFileMtime: number;
  cachedCanvasDoc: ReturnType<typeof parseCanvasDocument> | null;
  promptFileCache: Map<string, { mtime: number; body: string }>;
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
    // The selection menu may not be a descendant of the leaf's containerEl (some Obsidian builds append it
    // higher up in the DOM), so remove from both the view root and the document.
    root.querySelectorAll(".ss-canvasflow-menu-run").forEach((el) => el.remove());
    root.ownerDocument?.querySelectorAll?.(".ss-canvasflow-menu-run")?.forEach?.((el: any) => el?.remove?.());
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

    const nodeEls = findCanvasNodeElements(root);
    for (const { el: nodeEl, nodeId } of nodeEls) {
      const node = nodesById.get(nodeId);
      if (!node || !isCanvasFileNode(node)) continue;

      const filePath = node.file;
      if (!filePath.toLowerCase().endsWith(".md")) continue;

      const promptFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(promptFile instanceof TFile)) continue;

      const promptInfo = await this.getPromptBodyCached(controller, promptFile);
      if (!promptInfo) continue;

      this.ensureControls({
        leaf,
        canvasFile,
        nodeEl,
        nodeId,
        promptFile,
        promptBody: promptInfo.body,
      });
    }

    await this.ensureSelectionMenuRunButton({
      controller,
      root,
      canvasFile,
      nodesById,
    });
  }

  private async getPromptBodyCached(
    controller: LeafController,
    file: TFile
  ): Promise<{ body: string } | null> {
    const mtime = file.stat?.mtime ?? 0;
    const cached = controller.promptFileCache.get(file.path);
    if (cached && cached.mtime === mtime) {
      return { body: cached.body };
    }

    const raw = await this.app.vault.read(file);
    const parsed = parseCanvasFlowPromptNote(raw);
    if (!parsed.ok) {
      return null;
    }

    const body = String(parsed.body || "").trim();
    controller.promptFileCache.set(file.path, { mtime, body });
    return { body };
  }

  private ensureControls(options: {
    leaf: WorkspaceLeaf;
    canvasFile: TFile;
    nodeEl: HTMLElement;
    nodeId: string;
    promptFile: TFile;
    promptBody: string;
  }): void {
    const host = findCanvasNodeContentHost(options.nodeEl);

    const existing = host.querySelector<HTMLElement>(`.ss-canvasflow-controls[data-ss-node-id="${CSS.escape(options.nodeId)}"]`);
    if (existing) {
      const textarea = existing.querySelector<HTMLTextAreaElement>("textarea.ss-canvasflow-prompt");
      if (textarea && textarea.value !== options.promptBody) {
        textarea.value = options.promptBody;
      }
      return;
    }

    const controls = host.createDiv({ cls: "ss-canvasflow-controls" });
    controls.dataset.ssNodeId = options.nodeId;

    // Keep Canvas interactions sane.
    // Important: avoid `preventDefault()` here (it can break textarea focus/selection).
    // Stopping propagation in the bubble phase is enough to keep Canvas from starting drags on the node.
    controls.addEventListener("pointerdown", stopPropagationOnly);
    controls.addEventListener("mousedown", stopPropagationOnly);
    controls.addEventListener("wheel", stopPropagationOnly, { passive: true });

    const textarea = controls.createEl("textarea", { cls: "ss-canvasflow-prompt" });
    textarea.value = options.promptBody;
    textarea.placeholder = "Prompt...";

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

    const saveBody = async (): Promise<void> => {
      try {
        const raw = await this.app.vault.read(options.promptFile);
        const updated = replaceMarkdownBodyPreservingFrontmatter(raw, textarea.value);
        if (updated !== raw) {
          await this.app.vault.modify(options.promptFile, updated);
          // Bust cache for this prompt file so future refreshes re-read.
          options.promptFile.stat && controllerSafeUpdateCache(this.controllers.get(options.leaf), options.promptFile.path);
        }
      } catch (error: any) {
        new Notice(`CanvasFlow: failed to save prompt: ${error?.message || error}`);
      }
    };

    textarea.addEventListener("blur", () => {
      void saveBody();
    });

    textarea.addEventListener("keydown", (e) => {
      const isModEnter = (e.key === "Enter" || e.code === "Enter") && (e.ctrlKey || e.metaKey);
      if (!isModEnter) return;
      e.preventDefault();
      void run();
    });

    const setStatus = (text: string) => {
      status.setText(text);
    };

    const run = async (): Promise<void> => {
      const key = this.getRunKey(options.canvasFile.path, options.nodeId);
      if (this.runningNodeKeys.has(key)) {
        return;
      }

      this.runningNodeKeys.add(key);
      runBtn.disabled = true;
      setStatus("Saving...");
      await saveBody();

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
        this.runningNodeKeys.delete(key);
      }
    };

    runBtn.addEventListener("click", (e) => {
      stopEvent(e);
      void run();
    });
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
    setIcon(btn, "play");

    // Append to the end so it becomes the 5th icon (after trash/palette/zoom/edit).
    menuEl.appendChild(btn);
    return btn;
  }

  private removeMenuRunButton(menuEl: HTMLElement): void {
    menuEl.querySelectorAll(".ss-canvasflow-menu-run").forEach((el) => el.remove());
  }

  private async ensureSelectionMenuRunButton(options: {
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
      return;
    }

    const selectedNodeId = selectedIds[0];
    const node = options.nodesById.get(selectedNodeId);
    if (!node || !isCanvasFileNode(node)) {
      this.removeMenuRunButton(menuEl);
      return;
    }

    const filePath = String(node.file || "");
    if (!filePath.toLowerCase().endsWith(".md")) {
      this.removeMenuRunButton(menuEl);
      return;
    }

    const promptAbs = this.app.vault.getAbstractFileByPath(filePath);
    if (!(promptAbs instanceof TFile)) {
      this.removeMenuRunButton(menuEl);
      return;
    }

    const promptInfo = await this.getPromptBodyCached(options.controller, promptAbs);
    if (!promptInfo) {
      this.removeMenuRunButton(menuEl);
      return;
    }

    const btn = this.ensureMenuRunButton(menuEl);
    btn.dataset.ssCanvasflowCanvasPath = options.canvasFile.path;
    btn.dataset.ssCanvasflowNodeId = selectedNodeId;

    const key = this.getRunKey(options.canvasFile.path, selectedNodeId);
    btn.disabled = this.runningNodeKeys.has(key);

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
            btn.setAttribute("aria-label", originalLabel);
          });
      });
    }
  }
}

function controllerSafeUpdateCache(controller: LeafController | undefined, promptPath: string): void {
  if (!controller) return;
  controller.promptFileCache.delete(promptPath);
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
