/**
 * @jest-environment jsdom
 */
import {
  createEmbeddableMarkdownEditor,
  isEmbeddableMarkdownEditorSupported,
} from "../embeddable-markdown-editor";

class FakeNativeMarkdownEditMode {
  editorEl: HTMLElement;
  currentValue = "";
  cm: {
    state: {
      doc: { toString: () => string; length: number };
      selection: { main: { anchor: number; head: number } };
    };
    dispatch: jest.Mock;
    contentDOM: HTMLElement;
    scrollDOM: HTMLElement;
    focus: jest.Mock;
    hasFocus: boolean;
  };
  editor: { cm: FakeNativeMarkdownEditMode["cm"] };

  constructor(containerEl: HTMLElement) {
    this.editorEl = containerEl.createDiv({ cls: "markdown-source-view" });
    const contentDOM = this.editorEl.createDiv({ cls: "cm-content" });
    const scrollDOM = this.editorEl.createDiv({ cls: "cm-scroller" });
    const selection = { main: { anchor: 0, head: 0 } };
    const doc = {
      toString: () => this.currentValue,
      get length() {
        return this.toString().length;
      },
    };
    const focus = jest.fn(() => {
      this.cm.hasFocus = true;
    });
    const dispatch = jest.fn((spec: { selection?: { anchor: number; head: number } }) => {
      if (spec.selection) {
        selection.main = { ...spec.selection };
      }
    });
    this.cm = {
      state: { doc, selection },
      dispatch,
      contentDOM,
      scrollDOM,
      focus,
      hasFocus: false,
    };
    this.editor = { cm: this.cm };
  }

  set(value: string): void {
    this.currentValue = value;
  }

  focus(): void {
    this.cm.focus();
  }
}

class FakeNativeMarkdownEmbedBase {
  app: any;
  containerEl: HTMLElement;
  editorEl: HTMLElement;
  previewEl: HTMLElement;
  editMode: FakeNativeMarkdownEditMode | null = null;
  editable = false;
  useIframe = true;
  text = "";
  _loaded = true;
  unloadCount = 0;
  lastShowEditorPoint: { x: number; y: number } | undefined;

  constructor(app: any, containerEl: HTMLElement) {
    this.app = app;
    this.containerEl = containerEl;
    this.previewEl = containerEl.createDiv({ cls: "markdown-embed-content" });
    this.editorEl = containerEl.createDiv({ cls: "markdown-embed-content" });
  }

  set(value: string): void {
    this.text = value;
    this.editMode?.set(value);
  }

  save(value: string): void {
    this.set(value);
  }

  showEditor(point?: { x: number; y: number }): void {
    if (!this.editable) {
      return;
    }
    this.lastShowEditorPoint = point;
    if (!this.editMode) {
      this.editMode = new FakeNativeMarkdownEditMode(this.editorEl);
    }
    this.editMode.set(this.text);
    if (point) {
      const offset = Math.max(0, Math.min(this.text.length, Math.round(point.x)));
      this.editMode.cm.dispatch({ selection: { anchor: offset, head: offset } });
    }
  }

  showPreview(): void {
    (this as unknown as { applyScope: (scope: unknown) => void }).applyScope(null);
    this.editMode = null;
    this.editorEl.empty();
  }

  load(): void {
    this._loaded = true;
  }

  unload(): void {
    if (!this._loaded) {
      return;
    }
    this._loaded = false;
    this.unloadCount += 1;
    this.containerEl.empty();
  }
}

class FakeNativeMarkdownFileEmbed extends FakeNativeMarkdownEmbedBase {}

type FakeAppHarness = {
  app: any;
  createdWidgets: FakeNativeMarkdownFileEmbed[];
};

function createFakeApp(): FakeAppHarness {
  const createdWidgets: FakeNativeMarkdownFileEmbed[] = [];
  const app: any = {
    scope: {},
    keymap: {
      pushScope: jest.fn(),
      popScope: jest.fn(),
    },
    workspace: {
      activeEditor: null,
      setActiveLeaf: jest.fn(),
      unsetActiveEditor: jest.fn((editor: unknown) => {
        if (app.workspace.activeEditor === editor) {
          app.workspace.activeEditor = null;
        }
      }),
    },
    foldManager: {
      loadPath: jest.fn(() => null),
      savePath: jest.fn(),
    },
  };
  app.embedRegistry = {
    embedByExtension: {
      md: (context: { containerEl: HTMLElement }) => {
        const widget = new FakeNativeMarkdownFileEmbed(app, context.containerEl);
        createdWidgets.push(widget);
        return widget;
      },
    },
  };
  return { app, createdWidgets };
}

describe("createEmbeddableMarkdownEditor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  it("returns null when the app exposes no embed registry", () => {
    const handle = createEmbeddableMarkdownEditor(
      {} as never,
      document.body.createDiv(),
      {}
    );
    expect(handle).toBeNull();
  });

  it("returns null when native markdown surface resolution throws", () => {
    const app: any = {
      embedRegistry: {
        embedByExtension: {
          md: () => {
            throw new Error("internal shape changed");
          },
        },
      },
    };
    expect(
      createEmbeddableMarkdownEditor(app, document.body.createDiv(), {})
    ).toBeNull();
  });

  it("constructs the surface from Obsidian's native markdown embed component", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "# Native",
    });

    expect(handle).not.toBeNull();
    expect(handle?.editor).toBeInstanceOf(FakeNativeMarkdownEmbedBase);
    expect(handle?.value).toBe("# Native");
  });

  it("unloads the throwaway file-embed probe after resolving the native base", () => {
    const { app, createdWidgets } = createFakeApp();
    createEmbeddableMarkdownEditor(app, document.body.createDiv(), { value: "x" });

    expect(createdWidgets).toHaveLength(1);
    expect(createdWidgets[0].unloadCount).toBe(1);
  });

  it("applies the optional class to the native editor wrapper", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "",
      cls: "ss-test-editor",
    });

    expect(handle?.editorEl?.classList.contains("ss-test-editor")).toBe(true);
  });

  it("reports native markdown saves through onChange without duplicate values", () => {
    const { app } = createFakeApp();
    const onChange = jest.fn();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "before",
      onChange,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    surface.save("after");
    surface.save("after");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("after");
  });

  it("commit flushes the current CodeMirror document through onChange", () => {
    const { app } = createFakeApp();
    const onChange = jest.fn();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "before",
      onChange,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    surface.editMode!.set("final draft");

    expect(handle!.commit()).toBe("final draft");
    expect(onChange).toHaveBeenLastCalledWith("final draft");
  });

  it("claims the workspace active editor while focused and unsets it on destroy", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "x",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    surface.editMode!.cm.contentDOM.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true })
    );
    expect(app.keymap.pushScope).toHaveBeenCalledTimes(1);
    expect(app.workspace.activeEditor).toBe(surface);

    handle!.destroy();
    expect(app.keymap.popScope).toHaveBeenCalledTimes(1);
    expect(app.workspace.unsetActiveEditor).toHaveBeenCalledWith(surface);
    expect(app.workspace.activeEditor).toBeNull();
  });

  it("never monkey-patches workspace.setActiveLeaf", () => {
    const { app } = createFakeApp();
    const original = app.workspace.setActiveLeaf;
    const first = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "a",
    });
    const second = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "b",
    });

    expect(app.workspace.setActiveLeaf).toBe(original);
    first!.destroy();
    second!.destroy();
    expect(app.workspace.setActiveLeaf).toBe(original);
  });

  it("invokes onBlur only when focus leaves the entire native surface", () => {
    const { app } = createFakeApp();
    const onBlur = jest.fn();
    const container = document.body.createDiv();
    const outside = document.body.createDiv();
    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "- [ ] task",
      onBlur,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const checkbox = surface.editorEl.createEl("input");

    surface.editMode!.cm.contentDOM.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: checkbox })
    );
    expect(onBlur).not.toHaveBeenCalled();

    checkbox.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside })
    );
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("does not pop a scope that was never pushed and destroys idempotently", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "x",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    handle!.destroy();
    handle!.destroy();

    expect(app.keymap.popScope).not.toHaveBeenCalled();
    expect(surface.unloadCount).toBe(1);
  });

  it("suppresses blur callbacks caused by editor teardown", () => {
    const { app } = createFakeApp();
    const onBlur = jest.fn();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "x",
      onBlur,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;

    handle!.destroy();
    contentDOM.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    expect(onBlur).not.toHaveBeenCalled();
  });

  it("detaches lifecycle listeners before the container can be reused", () => {
    const { app } = createFakeApp();
    const onPaste = jest.fn();
    const container = document.body.createDiv();
    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "x",
      onPaste,
    });

    handle!.destroy();
    const replacementChild = container.createDiv();
    replacementChild.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    replacementChild.dispatchEvent(new Event("paste", { bubbles: true }));

    expect(app.keymap.pushScope).not.toHaveBeenCalled();
    expect(app.workspace.activeEditor).toBeNull();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("enters edit mode at the native Canvas pointer position", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abcdef",
      focusAt: { x: 4, y: 20 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    expect(surface.lastShowEditorPoint).toEqual({ x: 4, y: 20 });
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 4, head: 4 });
  });

  it("focus(), set(), and selectAll() delegate to the native editor", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abc",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    handle!.focus();
    expect(surface.editMode!.cm.focus).toHaveBeenCalled();

    handle!.set("after");
    expect(handle!.value).toBe("after");

    handle!.selectAll();
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 0, head: 5 });
  });

  it("captures and restores selection, scroll, and focus across remounts", () => {
    const firstHarness = createFakeApp();
    const first = createEmbeddableMarkdownEditor(
      firstHarness.app,
      document.body.createDiv(),
      { value: "abcdef" }
    )!;
    const firstSurface = first.editor as FakeNativeMarkdownEmbedBase;
    firstSurface.editMode!.cm.dispatch({ selection: { anchor: 2, head: 5 } });
    firstSurface.editMode!.cm.scrollDOM.scrollTop = 37;
    firstSurface.editMode!.cm.hasFocus = true;
    const snapshot = first.captureSnapshot();

    const secondHarness = createFakeApp();
    const second = createEmbeddableMarkdownEditor(
      secondHarness.app,
      document.body.createDiv(),
      { value: "abcdef" }
    )!;
    const secondSurface = second.editor as FakeNativeMarkdownEmbedBase;
    second.restoreSnapshot(snapshot);

    expect(secondSurface.editMode!.cm.state.selection.main).toEqual({ anchor: 2, head: 5 });
    expect(secondSurface.editMode!.cm.scrollDOM.scrollTop).toBe(37);
    expect(secondSurface.editMode!.cm.focus).toHaveBeenCalled();
  });

  it("routes native preview exit and paste events to the host", () => {
    const { app } = createFakeApp();
    const onEscape = jest.fn();
    const onPaste = jest.fn();
    const container = document.body.createDiv();
    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "x",
      onEscape,
      onPaste,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    container.dispatchEvent(new Event("paste", { bubbles: true }));
    surface.showPreview(true);

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("provides the project and node context through the native Canvas linktext", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "x",
      sourcePath: "Projects/Launch.systemsculpt",
      nodeId: "text_1",
    });

    expect((handle!.editor as { linktext?: string }).linktext).toBe(
      "Projects/Launch.systemsculpt#^text_1"
    );
  });

  it("reports support based on whether the native markdown embed resolves", () => {
    const { app } = createFakeApp();
    expect(isEmbeddableMarkdownEditorSupported(app)).toBe(true);
    expect(isEmbeddableMarkdownEditorSupported({} as never)).toBe(false);
  });
});
