import type { App } from "obsidian";
import * as obsidian from "obsidian";
import { Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Embeddable Obsidian markdown editor — the SAME live-preview CodeMirror
 * editor Obsidian mounts inside embedded notes and Canvas text cards, so an
 * embedded surface edits exactly like a note: inline syntax rendering,
 * checkboxes, tables, code fences, the user's editor plugins and vault
 * Live Preview setting all apply.
 *
 * Obsidian does not export this editor class, so it is resolved at runtime
 * with the community-established technique (obsidian-kanban, Fevol's
 * embeddable-editor): instantiate a throwaway markdown embed through
 * `app.embedRegistry.embedByExtension.md`, flip it editable to force the
 * editor into existence, and walk two prototype levels up from its
 * `editMode` to reach the reusable MarkdownEditor base class.
 *
 * Every touchpoint with the internal shape is defensive: if any step no
 * longer matches (future Obsidian versions, test environments without the
 * registry), `createEmbeddableMarkdownEditor` returns `null` and callers
 * fall back to their plain-text editing surface.
 */

export type EmbeddableMarkdownEditorOptions = {
  value?: string;
  placeholder?: string;
  /** Extra class applied to the editor element (the markdown-source-view). */
  cls?: string;
  onChange?: (value: string) => void;
  onEscape?: () => void;
  onBlur?: () => void;
  onPaste?: (event: ClipboardEvent) => void;
};

export type EmbeddableMarkdownEditorHandle = {
  /** Current markdown source held by the editor document. */
  readonly value: string;
  /** Replace the whole document. */
  set(value: string): void;
  focus(): void;
  selectAll(): void;
  destroy(): void;
  /** The internal editor element (markdown-source-view), when exposed. */
  readonly editorEl: HTMLElement | null;
  /** Raw internal editor instance — advanced use and tests only. */
  readonly editor: unknown;
};

type InternalEditorOwner = {
  app: App;
  onMarkdownScroll: () => void;
  getMode: () => string;
  editMode?: unknown;
  editor?: unknown;
};

type InternalMarkdownEditorConstructor = new (
  app: App,
  container: HTMLElement,
  owner: InternalEditorOwner
) => InternalMarkdownEditorInstance;

type InternalMarkdownEditorInstance = {
  editor?: {
    cm?: {
      state?: { doc?: { toString(): string; length?: number } };
      dispatch?: (spec: unknown) => void;
      contentDOM?: HTMLElement;
      focus?: () => void;
      hasFocus?: boolean;
    };
  };
  editorEl?: HTMLElement;
  containerEl?: HTMLElement;
  owner?: InternalEditorOwner;
  set?: (value: string, clear?: boolean) => void;
  register?: (disposer: () => void) => void;
  unload?: () => void;
  destroy?: () => void;
  _loaded?: boolean;
};

/**
 * Resolution result cache, per App instance. `null` records a failed
 * resolution so a broken internal shape is probed exactly once per session.
 */
const resolvedEditorClassByApp = new WeakMap<
  object,
  InternalMarkdownEditorConstructor | null
>();

function resolveInternalMarkdownEditorClass(
  app: App
): InternalMarkdownEditorConstructor | null {
  const cached = resolvedEditorClassByApp.get(app as unknown as object);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: InternalMarkdownEditorConstructor | null = null;
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
      const widget = embedCreator(
        { app, containerEl: document.createElement("div") },
        null,
        ""
      ) as {
        editable?: boolean;
        editMode?: unknown;
        showEditor?: () => void;
        unload?: () => void;
      };
      widget.editable = true;
      widget.showEditor?.();
      const editMode = widget.editMode;
      if (editMode) {
        const basePrototype = Object.getPrototypeOf(
          Object.getPrototypeOf(editMode)
        ) as { constructor?: unknown };
        if (typeof basePrototype?.constructor === "function") {
          resolved = basePrototype.constructor as InternalMarkdownEditorConstructor;
        }
      }
      widget.unload?.();
    }
  } catch (error) {
    console.warn(
      "[SystemSculpt] Embedded markdown editor resolution failed; falling back to plain editing",
      error instanceof Error ? error.message : String(error)
    );
    resolved = null;
  }

  resolvedEditorClassByApp.set(app as unknown as object, resolved);
  return resolved;
}

/**
 * Options for the editor currently being constructed. `buildLocalExtensions`
 * runs from inside the base-class constructor — before the subclass body has
 * assigned instance fields — so construction stashes the options here for
 * the synchronous window of the `new` call.
 */
let constructingOptions: EmbeddableMarkdownEditorOptions | null = null;

type WorkspaceWithSetActiveLeaf = {
  setActiveLeaf?: (...args: unknown[]) => void;
  activeEditor?: unknown;
};

type SetActiveLeafPatchState = {
  original: (...args: unknown[]) => void;
  wrapper: (...args: unknown[]) => void;
  editors: Set<InternalMarkdownEditorInstance>;
};

/**
 * One shared `setActiveLeaf` patch per workspace, reference-counted across
 * every live embedded editor. A per-editor wrap chain would break on
 * out-of-order teardown (the middle wrapper can never be unlinked); here the
 * single wrapper suppresses leaf activation while ANY live embedded editor
 * has focus, and the original method is restored when the last editor
 * releases.
 */
const setActiveLeafPatchByWorkspace = new WeakMap<object, SetActiveLeafPatchState>();

function acquireSetActiveLeafPatch(
  workspace: WorkspaceWithSetActiveLeaf,
  editor: InternalMarkdownEditorInstance
): void {
  if (typeof workspace.setActiveLeaf !== "function") {
    return;
  }
  let state = setActiveLeafPatchByWorkspace.get(workspace as object);
  if (!state) {
    const original = workspace.setActiveLeaf;
    const editors = new Set<InternalMarkdownEditorInstance>();
    const wrapper = (...args: unknown[]): void => {
      for (const activeEditor of editors) {
        if (activeEditor.editor?.cm?.hasFocus === true) {
          return;
        }
      }
      original.apply(workspace, args);
    };
    state = { original, wrapper, editors };
    setActiveLeafPatchByWorkspace.set(workspace as object, state);
    workspace.setActiveLeaf = wrapper;
  }
  state.editors.add(editor);
}

function releaseSetActiveLeafPatch(
  workspace: WorkspaceWithSetActiveLeaf | undefined,
  editor: InternalMarkdownEditorInstance
): void {
  if (!workspace) {
    return;
  }
  const state = setActiveLeafPatchByWorkspace.get(workspace as object);
  if (!state) {
    return;
  }
  state.editors.delete(editor);
  if (state.editors.size > 0) {
    return;
  }
  setActiveLeafPatchByWorkspace.delete(workspace as object);
  // Only restore when the wrapper is still installed; if something else
  // wrapped after us, the now-empty editor set makes our wrapper a pure
  // pass-through, so leaving it in a foreign chain stays harmless.
  if (workspace.setActiveLeaf === state.wrapper) {
    workspace.setActiveLeaf = state.original;
  }
}

const embeddableClassByBase = new WeakMap<
  InternalMarkdownEditorConstructor,
  InternalMarkdownEditorConstructor
>();

function getEmbeddableEditorClass(
  Base: InternalMarkdownEditorConstructor
): InternalMarkdownEditorConstructor {
  const cached = embeddableClassByBase.get(Base);
  if (cached) {
    return cached;
  }

  class EmbeddableMarkdownEditor extends (Base as new (
    ...args: never[]
  ) => object) {
    embeddableOptions: EmbeddableMarkdownEditorOptions;
    private embeddableScope: unknown = null;
    private embeddableScopePushed = false;
    private embeddableDestroyed = false;

    constructor(
      app: App,
      container: HTMLElement,
      options: EmbeddableMarkdownEditorOptions
    ) {
      super(
        ...([
          app,
          container,
          {
            app,
            // Mocks the owning MarkdownView surface the editor expects:
            // scroll bookkeeping and the mode used to pick live preview.
            onMarkdownScroll: () => {},
            getMode: () => "source",
          },
        ] as never[])
      );
      this.embeddableOptions = options;
      const self = this as unknown as InternalMarkdownEditorInstance & {
        app: App;
      };
      self.app = app;

      // Commands and link handling resolve the editor through the owner
      // view, so the mock owner must point back at this editor instance.
      const owner = self.owner;
      if (owner) {
        owner.editMode = this;
        owner.editor = self.editor;
      }

      // Hotkeys take precedence over the CM keymap; a dedicated scope keeps
      // Mod+Enter (globally "open link under cursor in new leaf") from
      // hijacking editing inside the embedded surface.
      const ScopeCtor = (obsidian as { Scope?: new (parent: unknown) => unknown })
        .Scope;
      if (ScopeCtor && (app as { scope?: unknown }).scope !== undefined) {
        const scope = new ScopeCtor((app as { scope?: unknown }).scope) as {
          register?: (
            modifiers: string[],
            key: string,
            handler: () => boolean
          ) => void;
        };
        scope.register?.(["Mod"], "Enter", () => true);
        this.embeddableScope = scope;
      }

      self.set?.(options.value ?? "", true);

      // Keep the workspace from yanking focus back to a leaf while an
      // embedded editor owns it. The patch is shared and reference-counted,
      // so any number of editors can come and go in any order.
      const workspace = (app as { workspace?: WorkspaceWithSetActiveLeaf })
        .workspace;
      if (workspace) {
        acquireSetActiveLeafPatch(workspace, self);
        self.register?.(() => {
          releaseSetActiveLeafPatch(workspace, self);
        });
      }

      const contentDOM = self.editor?.cm?.contentDOM;
      if (contentDOM) {
        contentDOM.addEventListener("focusin", () => {
          this.pushKeymapScope();
          if (workspace) {
            workspace.activeEditor = self.owner;
          }
        });
        contentDOM.addEventListener("blur", (event) => {
          // Live preview renders focusable controls (task checkboxes,
          // embeds) inside the editor; focus moving onto one is not the
          // user leaving the editor.
          const related = (event as FocusEvent).relatedTarget;
          if (
            related instanceof Node &&
            (self.editorEl?.contains(related) === true ||
              self.containerEl?.contains(related) === true)
          ) {
            return;
          }
          this.popKeymapScope();
          // Chrome fires blur when an element is removed from the DOM;
          // only a still-loaded editor reports a real blur.
          if (self._loaded !== false) {
            this.embeddableOptions.onBlur?.();
          }
        });
      }

      if (options.cls) {
        self.editorEl?.classList.add(options.cls);
      }
    }

    private pushKeymapScope(): void {
      if (!this.embeddableScope || this.embeddableScopePushed) {
        return;
      }
      this.embeddableScopePushed = true;
      const app = (this as unknown as { app?: App }).app;
      (app as unknown as {
        keymap?: { pushScope?: (scope: unknown) => void };
      })?.keymap?.pushScope?.(this.embeddableScope);
    }

    /**
     * Pops only what was pushed: destroy-without-focus would otherwise pop a
     * scope that is not on the stack, and Chrome's DOM-removal blur during
     * destroy would pop a second time — both scramble the hotkey stack.
     */
    private popKeymapScope(): void {
      if (!this.embeddableScope || !this.embeddableScopePushed) {
        return;
      }
      this.embeddableScopePushed = false;
      const app = (this as unknown as { app?: App }).app;
      (app as unknown as {
        keymap?: { popScope?: (scope: unknown) => void };
      })?.keymap?.popScope?.(this.embeddableScope);
    }

    getEmbeddableOptions(): EmbeddableMarkdownEditorOptions {
      return this.embeddableOptions ?? constructingOptions ?? {};
    }

    handleEmbeddableEscape(): boolean {
      this.getEmbeddableOptions().onEscape?.();
      return true;
    }

    handleEmbeddablePaste(event: ClipboardEvent): void {
      this.getEmbeddableOptions().onPaste?.(event);
    }

    onUpdate(update: ViewUpdate, changed: boolean): void {
      const superOnUpdate = (Base.prototype as {
        onUpdate?: (update: ViewUpdate, changed: boolean) => void;
      }).onUpdate;
      superOnUpdate?.call(this, update, changed);
      if (changed) {
        const value =
          update?.state?.doc?.toString() ??
          (this as unknown as InternalMarkdownEditorInstance).editor?.cm?.state?.doc?.toString() ??
          "";
        this.getEmbeddableOptions().onChange?.(value);
      }
    }

    buildLocalExtensions(): Extension[] {
      const superBuild = (Base.prototype as {
        buildLocalExtensions?: () => Extension[];
      }).buildLocalExtensions;
      const extensions: Extension[] = superBuild ? superBuild.call(this) : [];
      const options = this.getEmbeddableOptions();

      if (options.placeholder) {
        extensions.push(cmPlaceholder(options.placeholder));
      }
      extensions.push(
        EditorView.domEventHandlers({
          paste: (event) => {
            this.handleEmbeddablePaste(event);
          },
        })
      );
      extensions.push(
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: () => this.handleEmbeddableEscape(),
              preventDefault: true,
            },
          ])
        )
      );
      return extensions;
    }

    destroyEmbeddable(): void {
      if (this.embeddableDestroyed) {
        return;
      }
      this.embeddableDestroyed = true;
      const self = this as unknown as InternalMarkdownEditorInstance & {
        app?: App;
      };
      if (self._loaded !== false) {
        self.unload?.();
      }
      this.popKeymapScope();
      const workspace = (self.app as unknown as {
        workspace?: { activeEditor?: unknown };
      })?.workspace;
      if (workspace && workspace.activeEditor === self.owner) {
        workspace.activeEditor = null;
      }
      self.containerEl?.empty?.();
      const superDestroy = (Base.prototype as { destroy?: () => void }).destroy;
      superDestroy?.call(this);
    }

    onunload(): void {
      const superOnunload = (Base.prototype as { onunload?: () => void })
        .onunload;
      superOnunload?.call(this);
      this.destroyEmbeddable();
    }
  }

  const built = EmbeddableMarkdownEditor as unknown as InternalMarkdownEditorConstructor;
  embeddableClassByBase.set(Base, built);
  return built;
}

export function isEmbeddableMarkdownEditorSupported(app: App): boolean {
  return resolveInternalMarkdownEditorClass(app) !== null;
}

export function createEmbeddableMarkdownEditor(
  app: App,
  containerEl: HTMLElement,
  options: EmbeddableMarkdownEditorOptions
): EmbeddableMarkdownEditorHandle | null {
  const Base = resolveInternalMarkdownEditorClass(app);
  if (!Base) {
    return null;
  }

  const EmbeddableClass = getEmbeddableEditorClass(Base);
  let instance: InternalMarkdownEditorInstance & {
    destroyEmbeddable?: () => void;
  };
  constructingOptions = options;
  try {
    instance = new (EmbeddableClass as unknown as new (
      app: App,
      container: HTMLElement,
      options: EmbeddableMarkdownEditorOptions
    ) => InternalMarkdownEditorInstance & { destroyEmbeddable?: () => void })(
      app,
      containerEl,
      options
    );
  } catch (error) {
    console.warn(
      "[SystemSculpt] Embedded markdown editor construction failed; falling back to plain editing",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  } finally {
    constructingOptions = null;
  }

  const readValue = (): string =>
    instance.editor?.cm?.state?.doc?.toString() ?? "";

  return {
    get value(): string {
      return readValue();
    },
    set(value: string): void {
      instance.set?.(value, true);
    },
    focus(): void {
      instance.editor?.cm?.focus?.();
    },
    selectAll(): void {
      const length =
        instance.editor?.cm?.state?.doc?.length ?? readValue().length;
      instance.editor?.cm?.dispatch?.({
        selection: { anchor: 0, head: length },
      });
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
