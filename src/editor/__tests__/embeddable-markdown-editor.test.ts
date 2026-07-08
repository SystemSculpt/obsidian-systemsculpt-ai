/**
 * @jest-environment jsdom
 */
import { createEmbeddableMarkdownEditor } from "../embeddable-markdown-editor";

/**
 * Fake of Obsidian's INTERNAL markdown editor class chain. The real chain is
 * resolved at runtime from `app.embedRegistry.embedByExtension.md` by walking
 * two prototype levels up from the widget's `editMode` instance — exactly the
 * shape mocked here:
 *
 *   editMode instance → FakeEmbedEditMode → FakeScrollableMarkdownEditor
 *                                            ↑ resolved base class
 */
class FakeScrollableMarkdownEditor {
  app: unknown;
  containerEl: HTMLElement;
  owner: Record<string, unknown>;
  editorEl: HTMLElement;
  editor: {
    cm: {
      state: { doc: { toString: () => string } };
      dispatch: jest.Mock;
      contentDOM: HTMLElement;
      focus: jest.Mock;
      hasFocus: boolean;
    };
  };
  _loaded = true;
  unloadCount = 0;
  private registeredDisposers: Array<() => void> = [];
  private currentValue = "";

  constructor(app: unknown, container: HTMLElement, owner: Record<string, unknown>) {
    this.app = app;
    this.containerEl = container;
    this.owner = owner;
    this.editorEl = container.createDiv({ cls: "markdown-source-view" });
    const contentDOM = this.editorEl.createDiv({ cls: "cm-content" });
    this.editor = {
      cm: {
        state: { doc: { toString: () => this.currentValue } },
        dispatch: jest.fn(),
        contentDOM,
        focus: jest.fn(),
        hasFocus: false,
      },
    };
  }

  set(value: string): void {
    this.currentValue = value;
  }

  register(disposer: () => void): void {
    this.registeredDisposers.push(disposer);
  }

  unload(): void {
    if (!this._loaded) {
      return;
    }
    this._loaded = false;
    this.unloadCount += 1;
    for (const disposer of this.registeredDisposers.splice(0)) {
      disposer();
    }
    (this as { onunload?: () => void }).onunload?.();
  }

  onUpdate(_update: unknown, _changed: boolean): void {}

  buildLocalExtensions(): unknown[] {
    return [];
  }

  destroy(): void {}
}

class FakeEmbedEditMode extends FakeScrollableMarkdownEditor {}

function createFakeApp(): {
  app: any;
  widgetUnload: jest.Mock;
} {
  const widgetUnload = jest.fn();
  const app: any = {
    scope: {},
    keymap: {
      pushScope: jest.fn(),
      popScope: jest.fn(),
    },
    workspace: {
      activeEditor: null,
      setActiveLeaf: jest.fn(),
    },
  };
  app.embedRegistry = {
    embedByExtension: {
      md: (_context: unknown, _file: unknown, _subpath: string) => {
        const widget = {
          editable: false,
          editMode: undefined as FakeEmbedEditMode | undefined,
          showEditor() {
            this.editMode = new FakeEmbedEditMode(
              app,
              document.body.createDiv(),
              {}
            );
          },
          unload: widgetUnload,
        };
        return widget;
      },
    },
  };
  return { app, widgetUnload };
}

describe("createEmbeddableMarkdownEditor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  it("returns null when the app exposes no embed registry", () => {
    const container = document.body.createDiv();
    const handle = createEmbeddableMarkdownEditor({} as never, container, {});
    expect(handle).toBeNull();
  });

  it("returns null when internal editor resolution throws", () => {
    const container = document.body.createDiv();
    const app: any = {
      embedRegistry: {
        embedByExtension: {
          md: () => {
            throw new Error("internal shape changed");
          },
        },
      },
    };
    expect(createEmbeddableMarkdownEditor(app, container, {})).toBeNull();
  });

  it("constructs an editor seeded with the initial value and unloads the probe widget", () => {
    const { app, widgetUnload } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "# Hello\n\nSome **bold** text",
    });

    expect(handle).not.toBeNull();
    expect(handle?.value).toBe("# Hello\n\nSome **bold** text");
    expect(widgetUnload).toHaveBeenCalled();
  });

  it("applies the optional cls to the editor element", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "",
      cls: "ss-test-editor",
    });

    expect(handle?.editorEl?.classList.contains("ss-test-editor")).toBe(true);
  });

  it("reports document changes through onChange", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();
    const onChange = jest.fn();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "before",
      onChange,
    });
    expect(handle).not.toBeNull();

    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;
    rawEditor.onUpdate(
      { state: { doc: { toString: () => "after" } } },
      true
    );

    expect(onChange).toHaveBeenCalledWith("after");
  });

  it("does not report unchanged updates", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();
    const onChange = jest.fn();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "before",
      onChange,
    });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;
    rawEditor.onUpdate(
      { state: { doc: { toString: () => "before" } } },
      false
    );

    expect(onChange).not.toHaveBeenCalled();
  });

  it("claims the workspace active editor while focused and releases it on destroy", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, { value: "x" });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    rawEditor.editor.cm.contentDOM.dispatchEvent(new FocusEvent("focusin"));
    expect(app.keymap.pushScope).toHaveBeenCalled();
    expect(app.workspace.activeEditor).toBe(rawEditor.owner);

    handle!.destroy();
    expect(app.keymap.popScope).toHaveBeenCalled();
    expect(app.workspace.activeEditor).toBeNull();
  });

  it("invokes onBlur when the editor content loses focus", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();
    const onBlur = jest.fn();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "x",
      onBlur,
    });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    rawEditor.editor.cm.contentDOM.dispatchEvent(new FocusEvent("blur"));
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("suppresses onBlur after the editor is unloaded (Chrome DOM-removal blur)", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();
    const onBlur = jest.fn();

    const handle = createEmbeddableMarkdownEditor(app, container, {
      value: "x",
      onBlur,
    });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    handle!.destroy();
    rawEditor.editor.cm.contentDOM.dispatchEvent(new FocusEvent("blur"));
    expect(onBlur).not.toHaveBeenCalled();
  });

  it("destroys idempotently with a single unload", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, { value: "x" });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    handle!.destroy();
    handle!.destroy();

    expect(rawEditor.unloadCount).toBe(1);
    expect(container.childElementCount).toBe(0);
  });

  it("focus() forwards to the CodeMirror view", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, { value: "abc" });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    handle!.focus();
    expect(rawEditor.editor.cm.focus).toHaveBeenCalled();
  });

  it("selectAll() dispatches a whole-document selection", () => {
    const { app } = createFakeApp();
    const container = document.body.createDiv();

    const handle = createEmbeddableMarkdownEditor(app, container, { value: "abc" });
    const rawEditor = handle!.editor as FakeScrollableMarkdownEditor;

    handle!.selectAll();
    expect(rawEditor.editor.cm.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ anchor: 0, head: 3 }),
      })
    );
  });
});
