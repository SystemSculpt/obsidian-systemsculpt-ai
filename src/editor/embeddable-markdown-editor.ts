import type { App } from "obsidian";
import * as obsidian from "obsidian";
import { createSurfaceElement, resolveSurfaceDomContext } from "../core/ui/surface";

/**
 * Obsidian's native Canvas text cards do not construct a detached CodeMirror
 * editor. They mount the internal markdown-embed component, let that component
 * own preview/edit mode, and point the workspace at it while focused.
 *
 * Obsidian does not export that component. Resolve its base class from the
 * registered markdown embed (the registered file embed subclasses the generic
 * markdown embed), then build the smallest Canvas-style owner around it. If the
 * internal shape ever changes, callers receive null and keep their textarea
 * fallback.
 */

export type EmbeddableMarkdownEditorPoint = {
  x: number;
  y: number;
};

export type EmbeddableMarkdownEditorSelection = {
  anchor: number;
  head: number;
};

export type EmbeddableMarkdownEditorSnapshot = {
  selection: EmbeddableMarkdownEditorSelection;
  scrollTop: number;
  focused: boolean;
};

export type EmbeddableMarkdownEditorOptions = {
  value?: string;
  placeholder?: string;
  /** Extra class applied to the native markdown editor wrapper. */
  cls?: string;
  /** Canvas-style pointer position used to place the caret on edit entry. */
  focusAt?: EmbeddableMarkdownEditorPoint;
  /** Vault-relative context for links, editor extensions, and fold state. */
  sourcePath?: string;
  nodeId?: string;
  onChange?: (value: string) => void;
  onEscape?: () => void;
  onBlur?: () => void;
  onPaste?: (event: ClipboardEvent) => void;
};

export type EmbeddableMarkdownEditorHandle = {
  readonly value: string;
  set(value: string): void;
  commit(): string;
  focus(): void;
  focusAt(point: EmbeddableMarkdownEditorPoint): void;
  selectAll(): void;
  captureSnapshot(): EmbeddableMarkdownEditorSnapshot;
  restoreSnapshot(snapshot: EmbeddableMarkdownEditorSnapshot): void;
  destroy(): void;
  readonly editorEl: HTMLElement | null;
  /** Raw internal markdown-embed instance — advanced use and tests only. */
  readonly editor: unknown;
};

type InternalCodeMirror = {
  state?: {
    doc?: { toString(): string; length?: number };
    selection?: { main?: { anchor?: number; head?: number } };
  };
  dispatch?: (spec: unknown) => void;
  contentDOM?: HTMLElement;
  scrollDOM?: HTMLElement;
  focus?: () => void;
  posAtCoords?: (point: EmbeddableMarkdownEditorPoint, precise?: boolean) => number | null;
  hasFocus?: boolean;
};

type InternalMarkdownEditMode = {
  cm?: InternalCodeMirror;
  editor?: { cm?: InternalCodeMirror };
  editorEl?: HTMLElement;
  focus?: () => void;
  set?: (value: string, clear?: boolean) => void;
};

type InternalMarkdownEmbedInstance = {
  app?: App;
  containerEl?: HTMLElement;
  editorEl?: HTMLElement;
  previewEl?: HTMLElement;
  editMode?: InternalMarkdownEditMode | null;
  editable?: boolean;
  useIframe?: boolean;
  text?: string;
  _loaded?: boolean;
  set?: (value: string, clear?: boolean) => void;
  save?: (value: string, clear?: boolean) => void;
  showEditor?: (point?: EmbeddableMarkdownEditorPoint) => void;
  showPreview?: (clear?: boolean) => void;
  load?: () => void;
  unload?: () => void;
  register?: (disposer: () => void) => void;
};

type InternalMarkdownEmbedConstructor = new (
  app: App,
  containerEl: HTMLElement,
  file: null,
  state?: unknown
) => InternalMarkdownEmbedInstance;

const resolvedMarkdownEmbedByApp = new WeakMap<
  object,
  InternalMarkdownEmbedConstructor | null
>();

function looksLikeMarkdownEmbedConstructor(
  candidate: unknown
): candidate is InternalMarkdownEmbedConstructor {
  if (typeof candidate !== "function") {
    return false;
  }
  const prototype = (candidate as { prototype?: Record<string, unknown> }).prototype;
  return Boolean(
    prototype &&
      typeof prototype.set === "function" &&
      typeof prototype.showEditor === "function" &&
      typeof prototype.showPreview === "function"
  );
}

function resolveInternalMarkdownEmbedClass(
  app: App,
  ownerDocument: Document = resolveSurfaceDomContext().document
): InternalMarkdownEmbedConstructor | null {
  const appKey = app as unknown as object;
  const cached = resolvedMarkdownEmbedByApp.get(appKey);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: InternalMarkdownEmbedConstructor | null = null;
  let widget: InternalMarkdownEmbedInstance | null = null;
  try {
    const embedCreator = (app as unknown as {
      embedRegistry?: {
        embedByExtension?: Record<
          string,
          (context: unknown, file: unknown, subpath: string) => unknown
        >;
      };
    }).embedRegistry?.embedByExtension?.md;
    if (typeof embedCreator === "function") {
      const probeEl = createSurfaceElement(ownerDocument, "div");
      widget = embedCreator({ app, containerEl: probeEl }, null, "") as
        | InternalMarkdownEmbedInstance
        | null;
      if (widget) {
        // Registered .md embeds are file-aware subclasses. Canvas text cards
        // use the generic markdown-embed component one prototype above them.
        const registeredPrototype = Object.getPrototypeOf(widget) as object | null;
        const basePrototype = registeredPrototype
          ? (Object.getPrototypeOf(registeredPrototype) as { constructor?: unknown } | null)
          : null;
        const candidate = basePrototype?.constructor;
        if (looksLikeMarkdownEmbedConstructor(candidate)) {
          resolved = candidate;
        }
      }
    }
  } catch (error) {
    console.warn(
      "[SystemSculpt] Native markdown surface resolution failed; falling back to plain editing",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    try {
      widget?.unload?.();
    } catch {
      // Probe teardown is best-effort; a failed probe still falls back safely.
    }
  }

  resolvedMarkdownEmbedByApp.set(appKey, resolved);
  return resolved;
}

const embeddableClassByBase = new WeakMap<
  InternalMarkdownEmbedConstructor,
  InternalMarkdownEmbedConstructor
>();

function getCodeMirror(instance: InternalMarkdownEmbedInstance): InternalCodeMirror | null {
  return instance.editMode?.cm ?? instance.editMode?.editor?.cm ?? null;
}

function getEmbeddableMarkdownClass(
  Base: InternalMarkdownEmbedConstructor
): InternalMarkdownEmbedConstructor {
  const cached = embeddableClassByBase.get(Base);
  if (cached) {
    return cached;
  }

  class EmbeddableMarkdownSurface extends (Base as new (...args: never[]) => object) {
    private embeddableOptions: EmbeddableMarkdownEditorOptions = {};
    private embeddableScope: unknown = null;
    private embeddableScopePushed = false;
    private embeddableNativeScope: unknown = null;
    private embeddableDestroyed = false;
    private embeddableClosingThroughPreview = false;
    private embeddableLastReportedValue = "";
    private embeddableLifecycleAbort: AbortController | null = null;

    constructor(
      app: App,
      containerEl: HTMLElement,
      options: EmbeddableMarkdownEditorOptions
    ) {
      super(...([app, containerEl, null, { mode: "source" }] as never[]));
      this.embeddableOptions = options;
      this.embeddableLastReportedValue = options.value ?? "";

      const self = this as unknown as InternalMarkdownEmbedInstance;
      self.app = app;
      self.editable = true;
      // Canvas uses the same component in an iframe. Studio keeps it in the
      // card document so canvas transforms, intrinsic height, and host theme
      // variables remain stable while preserving the native editor lifecycle.
      self.useIframe = false;
      self.containerEl?.classList.add("markdown-embed");
      if (options.cls) {
        self.editorEl?.classList.add(options.cls);
      }

      this.createScope(app);
      this.bindSurfaceLifecycle(app);
      self.set?.(options.value ?? "", true);
      self.load?.();
      self.showEditor?.(options.focusAt);
    }

    private createScope(app: App): void {
      const ScopeCtor = (obsidian as { Scope?: new (parent: unknown) => unknown }).Scope;
      if (!ScopeCtor || (app as { scope?: unknown }).scope === undefined) {
        return;
      }
      const scope = new ScopeCtor((app as { scope?: unknown }).scope) as {
        register?: (modifiers: string[], key: string, handler: () => boolean) => void;
      };
      scope.register?.(["Mod"], "Enter", () => true);
      this.embeddableScope = scope;
    }

    private bindSurfaceLifecycle(app: App): void {
      const self = this as unknown as InternalMarkdownEmbedInstance;
      const focusRootEl = self.containerEl ?? self.editorEl;
      if (!focusRootEl) {
        return;
      }
      this.embeddableLifecycleAbort = new AbortController();
      const { signal } = this.embeddableLifecycleAbort;
      focusRootEl.addEventListener(
        "focusin",
        () => {
          if (this.embeddableDestroyed) {
            return;
          }
          this.pushScope(app);
          const workspace = (app as unknown as {
            workspace?: { activeEditor?: unknown };
          }).workspace;
          if (workspace) {
            workspace.activeEditor = self;
          }
        },
        { signal }
      );
      focusRootEl.addEventListener(
        "focusout",
        (event) => {
          const relatedTarget = (event as FocusEvent).relatedTarget;
          if (
            relatedTarget
            && typeof (relatedTarget as Node).nodeType === "number"
            && focusRootEl.contains(relatedTarget as Node)
          ) {
            return;
          }
          this.popScope(app);
          if (
            !this.embeddableDestroyed &&
            !this.embeddableClosingThroughPreview &&
            self._loaded !== false
          ) {
            this.embeddableOptions.onBlur?.();
          }
        },
        { signal }
      );
      focusRootEl.addEventListener(
        "paste",
        (event) => {
          if (this.embeddableDestroyed) {
            return;
          }
          this.embeddableOptions.onPaste?.(event as ClipboardEvent);
        },
        { signal }
      );
    }

    /** Native MarkdownEmbed calls this while opening/closing editor search. */
    applyScope(scope: unknown): void {
      if (scope === this.embeddableNativeScope) {
        return;
      }
      const app = (this as unknown as InternalMarkdownEmbedInstance).app;
      const keymap = (app as unknown as {
        keymap?: {
          pushScope?: (value: unknown) => void;
          popScope?: (value: unknown) => void;
        };
      })?.keymap;
      if (this.embeddableNativeScope) {
        keymap?.popScope?.(this.embeddableNativeScope);
      }
      if (scope) {
        keymap?.pushScope?.(scope);
      }
      this.embeddableNativeScope = scope;
    }

    private pushScope(app: App): void {
      if (!this.embeddableScope || this.embeddableScopePushed) {
        return;
      }
      this.embeddableScopePushed = true;
      (app as unknown as { keymap?: { pushScope?: (scope: unknown) => void } })
        .keymap?.pushScope?.(this.embeddableScope);
    }

    private popScope(app: App): void {
      if (!this.embeddableScope || !this.embeddableScopePushed) {
        return;
      }
      this.embeddableScopePushed = false;
      (app as unknown as { keymap?: { popScope?: (scope: unknown) => void } })
        .keymap?.popScope?.(this.embeddableScope);
    }

    save(value: string, clear = false): void {
      const baseSave = (Base.prototype as {
        save?: (value: string, clear?: boolean) => void;
      }).save;
      baseSave?.call(this, value, clear);
      if (value === this.embeddableLastReportedValue) {
        return;
      }
      this.embeddableLastReportedValue = value;
      this.embeddableOptions.onChange?.(value);
    }

    showPreview(clear = false): void {
      const wasEditing = Boolean(
        (this as unknown as InternalMarkdownEmbedInstance).editMode
      );
      this.embeddableClosingThroughPreview = true;
      try {
        const baseShowPreview = (Base.prototype as {
          showPreview?: (clear?: boolean) => void;
        }).showPreview;
        baseShowPreview?.call(this, clear);
      } finally {
        this.embeddableClosingThroughPreview = false;
      }
      if (wasEditing && !this.embeddableDestroyed) {
        this.embeddableOptions.onEscape?.();
      }
    }

    get linktext(): string {
      const sourcePath = String(this.embeddableOptions.sourcePath || "").trim();
      const nodeId = String(this.embeddableOptions.nodeId || "").trim();
      return nodeId ? `${sourcePath}#^${nodeId}` : sourcePath;
    }

    getFoldInfo(): unknown {
      const foldManager = (
        (this as unknown as InternalMarkdownEmbedInstance).app as unknown as {
          foldManager?: { loadPath?: (path: string) => unknown };
        }
      )?.foldManager;
      return foldManager?.loadPath?.(this.linktext) ?? null;
    }

    onMarkdownFold(): void {
      const self = this as unknown as InternalMarkdownEmbedInstance & {
        previewMode?: { renderer?: { getFoldInfo?: () => unknown } };
      };
      const foldInfo = self.editMode
        ? (self.editMode as { getFoldInfo?: () => unknown }).getFoldInfo?.()
        : self.previewMode?.renderer?.getFoldInfo?.();
      const foldManager = (self.app as unknown as {
        foldManager?: { savePath?: (path: string, info: unknown) => void };
      })?.foldManager;
      foldManager?.savePath?.(this.linktext, foldInfo);
    }

    destroyEmbeddable(): void {
      if (this.embeddableDestroyed) {
        return;
      }
      this.embeddableDestroyed = true;
      this.embeddableLifecycleAbort?.abort();
      this.embeddableLifecycleAbort = null;
      const self = this as unknown as InternalMarkdownEmbedInstance;
      const app = self.app;
      if (app) {
        this.popScope(app);
      }
      this.applyScope(null);
      try {
        self.unload?.();
      } finally {
        const workspace = (app as unknown as {
          workspace?: {
            activeEditor?: unknown;
            unsetActiveEditor?: (editor: unknown) => void;
          };
        })?.workspace;
        if (workspace?.unsetActiveEditor) {
          workspace.unsetActiveEditor(self);
        } else if (workspace?.activeEditor === self) {
          workspace.activeEditor = null;
        }
        self.containerEl?.empty?.();
      }
    }
  }

  const built = EmbeddableMarkdownSurface as unknown as InternalMarkdownEmbedConstructor;
  embeddableClassByBase.set(Base, built);
  return built;
}

export function isEmbeddableMarkdownEditorSupported(app: App): boolean {
  return resolveInternalMarkdownEmbedClass(app) !== null;
}

export function createEmbeddableMarkdownEditor(
  app: App,
  containerEl: HTMLElement,
  options: EmbeddableMarkdownEditorOptions
): EmbeddableMarkdownEditorHandle | null {
  const Base = resolveInternalMarkdownEmbedClass(app, containerEl.ownerDocument);
  if (!Base) {
    return null;
  }

  const EmbeddableClass = getEmbeddableMarkdownClass(Base);
  let instance: InternalMarkdownEmbedInstance & {
    destroyEmbeddable?: () => void;
  };
  try {
    instance = new (EmbeddableClass as unknown as new (
      app: App,
      containerEl: HTMLElement,
      options: EmbeddableMarkdownEditorOptions
    ) => InternalMarkdownEmbedInstance & { destroyEmbeddable?: () => void })(
      app,
      containerEl,
      options
    );
  } catch (error) {
    console.warn(
      "[SystemSculpt] Native markdown surface construction failed; falling back to plain editing",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }

  const readValue = (): string =>
    getCodeMirror(instance)?.state?.doc?.toString() ?? instance.text ?? "";

  const commit = (): string => {
    const value = readValue();
    instance.save?.(value, true);
    return value;
  };

  const focusAt = (point: EmbeddableMarkdownEditorPoint): void => {
    instance.showEditor?.(point);
  };

  return {
    get value(): string {
      return readValue();
    },
    set(value: string): void {
      instance.set?.(value, true);
    },
    commit,
    focus(): void {
      instance.editMode?.focus?.();
      getCodeMirror(instance)?.focus?.();
    },
    focusAt,
    selectAll(): void {
      const cm = getCodeMirror(instance);
      const length = cm?.state?.doc?.length ?? readValue().length;
      cm?.dispatch?.({ selection: { anchor: 0, head: length } });
    },
    captureSnapshot(): EmbeddableMarkdownEditorSnapshot {
      const cm = getCodeMirror(instance);
      const main = cm?.state?.selection?.main;
      return {
        selection: {
          anchor: Number(main?.anchor ?? 0),
          head: Number(main?.head ?? main?.anchor ?? 0),
        },
        scrollTop: Number(cm?.scrollDOM?.scrollTop ?? 0),
        focused: cm?.hasFocus === true,
      };
    },
    restoreSnapshot(snapshot: EmbeddableMarkdownEditorSnapshot): void {
      const cm = getCodeMirror(instance);
      const length = cm?.state?.doc?.length ?? readValue().length;
      const anchor = Math.max(0, Math.min(length, Math.round(snapshot.selection.anchor)));
      const head = Math.max(0, Math.min(length, Math.round(snapshot.selection.head)));
      cm?.dispatch?.({ selection: { anchor, head } });
      if (cm?.scrollDOM) {
        cm.scrollDOM.scrollTop = Math.max(0, snapshot.scrollTop || 0);
      }
      if (snapshot.focused) {
        instance.editMode?.focus?.();
        cm?.focus?.();
      }
    },
    destroy(): void {
      instance.destroyEmbeddable?.();
    },
    get editorEl(): HTMLElement | null {
      return instance.editorEl ?? null;
    },
    get editor(): unknown {
      return instance;
    },
  };
}
