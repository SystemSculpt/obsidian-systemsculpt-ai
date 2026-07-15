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
    posAtCoords: jest.Mock;
    hasFocus: boolean;
    cm?: { state?: { vim?: unknown } };
  };
  activeCM: FakeNativeMarkdownEditMode["cm"];
  editor: {
    cm: FakeNativeMarkdownEditMode["cm"];
    activeCM: FakeNativeMarkdownEditMode["cm"];
  };

  constructor(containerEl: HTMLElement) {
    this.editorEl = containerEl.createDiv({ cls: "markdown-source-view" });
    const contentDOM = this.editorEl.createDiv({ cls: "cm-content" });
    contentDOM.tabIndex = -1;
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
    const posAtCoords = jest.fn((point: { x: number; y: number }) =>
      Math.max(0, Math.min(this.currentValue.length, Math.round(point.x)))
    );
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
      posAtCoords,
      hasFocus: false,
    };
    this.activeCM = this.cm;
    const thisMode = this;
    this.editor = {
      cm: this.cm,
      get activeCM() {
        return thisMode.activeCM;
      },
    };
  }

  set(value: string): void {
    this.currentValue = value;
  }

  focus(): void {
    this.activeCM.focus();
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

  showPreview(saveCurrent = false): void {
    if (saveCurrent && this.editMode) {
      this.save(this.editMode.currentValue, true);
    }
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

  it("enters insert mode when the embedded editor receives focus in Vim normal mode", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "# Editable",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const insertedKeys: string[] = [];
    contentDOM.classList.add("cm-vimMode", "cm-fat-cursor");
    contentDOM.addEventListener("keydown", (event) => {
      insertedKeys.push(event.key);
      if (event.key === "i") {
        contentDOM.classList.remove("cm-vimMode", "cm-fat-cursor");
      }
    });

    contentDOM.focus();
    contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    contentDOM.focus();
    contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(insertedKeys).toEqual(["i"]);
    expect(contentDOM.classList.contains("cm-vimMode")).toBe(false);
    expect(handle!.value).toBe("# Editable");
  });

  it("does not synthesize an insert key when Vim normal mode is absent", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "plain",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const keydown = jest.fn();
    contentDOM.addEventListener("keydown", keydown);

    contentDOM.focus();
    contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(keydown).not.toHaveBeenCalled();
    expect(handle!.value).toBe("plain");
  });

  it("ignores a stale Vim marker after a native table-cell adapter is destroyed", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "| A | B |",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const keydown = jest.fn();
    contentDOM.classList.add("cm-vimMode", "cm-fat-cursor");
    surface.editMode!.cm.cm = { state: { vim: null } };
    contentDOM.addEventListener("keydown", keydown);

    contentDOM.focus();
    contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(keydown).not.toHaveBeenCalled();
    expect(handle!.value).toBe("| A | B |");
  });

  it("rechecks Vim mode after the native editor finishes mounting", () => {
    const { app } = createFakeApp();
    let pendingFrame: FrameRequestCallback | null = null;
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "late Vim",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const insertedKeys: string[] = [];
    contentDOM.addEventListener("keydown", (event) => {
      insertedKeys.push(event.key);
      contentDOM.classList.remove("cm-vimMode", "cm-fat-cursor");
    });

    contentDOM.focus();
    contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    contentDOM.classList.add("cm-vimMode", "cm-fat-cursor");
    expect(pendingFrame).not.toBeNull();
    (pendingFrame as unknown as FrameRequestCallback)(0);

    expect(insertedKeys).toEqual(["i"]);
    expect(contentDOM.classList.contains("cm-vimMode")).toBe(false);
    expect(handle!.value).toBe("late Vim");
  });

  it("sends Vim insert to the focused table-cell editor, not the parent editor", () => {
    const { app } = createFakeApp();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "| A | B |",
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const tableCellEditor = contentDOM.createDiv({ cls: "cm-editor" });
    const tableCellContent = tableCellEditor.createDiv({
      cls: "cm-content cm-vimMode cm-fat-cursor",
    });
    tableCellContent.tabIndex = -1;
    const parentKeydown = jest.fn();
    const cellKeys: string[] = [];
    contentDOM.addEventListener("keydown", parentKeydown);
    tableCellContent.addEventListener("keydown", (event) => {
      cellKeys.push(event.key);
      event.stopPropagation();
      tableCellContent.classList.remove("cm-vimMode", "cm-fat-cursor");
    });
    surface.editMode!.activeCM = {
      ...surface.editMode!.cm,
      contentDOM: tableCellContent,
    };

    tableCellContent.focus();
    tableCellContent.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(document.activeElement).toBe(tableCellContent);
    expect(cellKeys).toEqual(["i"]);
    expect(parentKeydown).not.toHaveBeenCalled();
    expect(handle!.value).toBe("| A | B |");
  });

  it("captures Escape before Vim and closes the Studio edit session", () => {
    const { app } = createFakeApp();
    const onChange = jest.fn();
    const onEscape = jest.fn();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "escape me",
      onChange,
      onEscape,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    surface.editMode!.set("escape me plus final keystroke");
    const contentDOM = surface.editMode!.cm.contentDOM;
    contentDOM.classList.add("cm-vimMode", "cm-fat-cursor");
    const vimHandler = jest.fn();
    contentDOM.addEventListener("keydown", vimHandler);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(vimHandler).not.toHaveBeenCalled();
    expect(surface.editMode).toBeNull();
    expect(surface.text).toBe("escape me plus final keystroke");
    expect(onChange).toHaveBeenLastCalledWith("escape me plus final keystroke");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["composition", { isComposing: true }],
    ["IME keyCode", { keyCode: 229 }],
  ])("leaves %s Escape to the native editor", (_label, marker) => {
    const { app } = createFakeApp();
    const onEscape = jest.fn();
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "composing",
      onEscape,
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const contentDOM = surface.editMode!.cm.contentDOM;
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: marker.isComposing ?? false,
    });
    if (marker.keyCode) {
      Object.defineProperty(event, "keyCode", { value: marker.keyCode });
    }

    contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(surface.editMode).not.toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
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

  it("resolves a pointer position against CodeMirror after its first layout", () => {
    const { app } = createFakeApp();
    let pendingFrame: FrameRequestCallback | null = null;
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abcdef",
      focusAt: { x: 4, y: 20 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    expect(surface.lastShowEditorPoint).toBeUndefined();
    expect(surface.editMode!.cm.posAtCoords).not.toHaveBeenCalled();
    expect(pendingFrame).not.toBeNull();
    (pendingFrame as unknown as FrameRequestCallback)(0);

    expect(surface.editMode!.cm.posAtCoords).toHaveBeenCalledWith(
      { x: 4, y: 20 },
      false
    );
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 4, head: 4 });
    expect(surface.editMode!.cm.focus).toHaveBeenCalled();
  });

  it("retries pointer placement once when CodeMirror has not laid out yet", () => {
    const { app } = createFakeApp();
    const pendingFrames: FrameRequestCallback[] = [];
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abcdef",
      focusAt: { x: 3, y: 20 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    surface.editMode!.cm.posAtCoords
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(3);

    pendingFrames.shift()!(0);
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 0, head: 0 });
    expect(pendingFrames).toHaveLength(1);

    pendingFrames.shift()!(16);
    expect(surface.editMode!.cm.posAtCoords).toHaveBeenCalledTimes(2);
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 3, head: 3 });
  });

  it("uses an exact semantic source offset without guessing from screen coordinates", () => {
    const { app } = createFakeApp();
    let pendingFrame: FrameRequestCallback | null = null;
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abcdef",
      focusAt: { x: 400, y: 500, sourceOffset: 2 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;

    (pendingFrame as unknown as FrameRequestCallback)(0);

    expect(surface.editMode!.cm.posAtCoords).not.toHaveBeenCalled();
    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 2, head: 2 });
  });

  it("preserves and focuses a native table-cell editor created by caret placement", () => {
    const { app } = createFakeApp();
    let pendingFrame: FrameRequestCallback | null = null;
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "| Alpha | Ready |",
      focusAt: { x: 400, y: 500, sourceOffset: 4 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const editMode = surface.editMode!;
    const mainCM = editMode.cm;
    const tableCellContent = editMode.editorEl.createDiv({ cls: "cm-content" });
    tableCellContent.tabIndex = -1;
    const tableCellCM = {
      ...mainCM,
      contentDOM: tableCellContent,
      hasFocus: false,
      focus: jest.fn(),
    };
    tableCellCM.focus.mockImplementation(() => {
      tableCellCM.hasFocus = true;
      tableCellContent.focus();
    });
    mainCM.focus.mockImplementation(() => {
      mainCM.hasFocus = true;
      if (editMode.activeCM !== mainCM) {
        editMode.activeCM = mainCM;
      }
    });
    mainCM.dispatch.mockImplementation(
      (spec: { selection?: { anchor: number; head: number } }) => {
        if (!spec.selection) {
          return;
        }
        mainCM.state.selection.main = { ...spec.selection };
        editMode.activeCM = tableCellCM;
      }
    );

    (pendingFrame as unknown as FrameRequestCallback)(0);

    expect(editMode.activeCM).toBe(tableCellCM);
    expect(tableCellCM.focus).toHaveBeenCalledTimes(1);
    expect(mainCM.focus).toHaveBeenCalledTimes(1);
    expect(mainCM.focus.mock.invocationCallOrder[0]).toBeLessThan(
      mainCM.dispatch.mock.invocationCallOrder[0]
    );
    expect(mainCM.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      tableCellCM.focus.mock.invocationCallOrder[0]
    );
    expect(document.activeElement).toBe(tableCellContent);
    expect(handle!.captureSnapshot().focused).toBe(true);
  });

  it("retries an exact semantic offset until CodeMirror is mounted", () => {
    const { app } = createFakeApp();
    const pendingFrames: FrameRequestCallback[] = [];
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      });
    const handle = createEmbeddableMarkdownEditor(app, document.body.createDiv(), {
      value: "abcdef",
      focusAt: { x: 400, y: 500, sourceOffset: 3 },
    });
    const surface = handle!.editor as FakeNativeMarkdownEmbedBase;
    const mountedEditMode = surface.editMode;
    surface.editMode = null;

    pendingFrames.shift()!(0);
    expect(pendingFrames).toHaveLength(1);

    surface.editMode = mountedEditMode;
    pendingFrames.shift()!(16);

    expect(surface.editMode!.cm.state.selection.main).toEqual({ anchor: 3, head: 3 });
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
