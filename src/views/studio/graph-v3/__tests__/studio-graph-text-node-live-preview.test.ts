/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import {
  renderTextNodeCard,
  type StudioTextNodeMarkdownEditorFactory,
  type StudioTextNodeMarkdownEditorHandle,
} from "../StudioGraphTextNodeCard";

function createTextNode(value: string): StudioNodeInstance {
  return {
    id: "text_node",
    kind: "studio.text",
    version: "1.0.0",
    title: "Text",
    position: { x: 10, y: 20 },
    config: { value },
    continueOnError: false,
    disabled: false,
  };
}

function createGraphInteractionStub() {
  return {
    isNodeSelected: jest.fn(() => false),
    registerNodeElement: jest.fn(),
    startNodeDrag: jest.fn(),
    getGraphZoom: jest.fn(() => 1),
    toggleNodeSelection: jest.fn(),
    ensureSingleSelection: jest.fn(),
    resolveNodeResizeSnap: jest.fn(() => null),
    clearResizeSnapGuides: jest.fn(),
  };
}

type HarnessOptions = {
  value?: string;
  isEditing?: boolean;
  busy?: boolean;
  shouldAutoFocus?: boolean;
  renderMarkdownPreview?: jest.Mock;
  createMarkdownEditor?: StudioTextNodeMarkdownEditorFactory;
  registerEditorTeardown?: jest.Mock;
};

function renderHarness(options: HarnessOptions = {}) {
  const node = createTextNode(options.value ?? "");
  const nodeEl = document.body.createDiv({ cls: "ss-studio-node-card" });
  const graphInteraction = createGraphInteractionStub();
  const onNodeConfigMutated = jest.fn();
  const onNodeConfigValueChange = jest.fn();
  const onRequestTextNodeEdit = jest.fn();
  const onStopTextNodeEdit = jest.fn();

  renderTextNodeCard({
    nodeEl,
    node,
    busy: options.busy ?? false,
    graphInteraction: graphInteraction as never,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeGeometryMutated: jest.fn(),
    isEditing: options.isEditing ?? false,
    shouldAutoFocus: options.shouldAutoFocus ?? false,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    renderMarkdownPreview: options.renderMarkdownPreview,
    createMarkdownEditor: options.createMarkdownEditor,
    registerEditorTeardown: options.registerEditorTeardown,
  });

  return {
    node,
    nodeEl,
    graphInteraction,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
  };
}

type EditorFactoryCapture = {
  factory: StudioTextNodeMarkdownEditorFactory;
  calls: Array<{
    containerEl: HTMLElement;
    options: Parameters<StudioTextNodeMarkdownEditorFactory>[1];
  }>;
  handle: StudioTextNodeMarkdownEditorHandle & {
    destroy: jest.Mock;
    focus: jest.Mock;
    selectAll: jest.Mock;
  };
};

function createEditorFactory(result: "handle" | "null" = "handle"): EditorFactoryCapture {
  const handle = {
    value: "",
    set: jest.fn(),
    destroy: jest.fn(),
    focus: jest.fn(),
    selectAll: jest.fn(),
    editorEl: null,
    editor: null,
  };
  const calls: EditorFactoryCapture["calls"] = [];
  const factory: StudioTextNodeMarkdownEditorFactory = (containerEl, options) => {
    calls.push({ containerEl, options });
    if (result === "null") {
      return null;
    }
    return handle;
  };
  return { factory, calls, handle };
}

describe("studio.text live-preview card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  describe("display mode", () => {
    it("renders the value as markdown through renderMarkdownPreview", () => {
      const renderMarkdownPreview = jest.fn();
      const { node, nodeEl } = renderHarness({
        value: "# Heading\n\n| a | b |\n| - | - |",
        renderMarkdownPreview,
      });

      const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      expect(displayEl).not.toBeNull();
      expect(displayEl?.classList.contains("is-markdown")).toBe(true);
      expect(renderMarkdownPreview).toHaveBeenCalledTimes(1);
      expect(renderMarkdownPreview).toHaveBeenCalledWith(
        node,
        "# Heading\n\n| a | b |\n| - | - |",
        displayEl
      );
    });

    it("keeps the faint placeholder for empty values without invoking markdown", () => {
      const renderMarkdownPreview = jest.fn();
      const { nodeEl } = renderHarness({ value: "   ", renderMarkdownPreview });

      const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      expect(displayEl?.textContent).toBe("Text");
      expect(displayEl?.classList.contains("is-placeholder")).toBe(true);
      expect(displayEl?.classList.contains("is-markdown")).toBe(false);
      expect(renderMarkdownPreview).not.toHaveBeenCalled();
    });

    it("falls back to plain text when markdown rendering rejects", async () => {
      const renderMarkdownPreview = jest.fn(() => Promise.reject(new Error("boom")));
      const { nodeEl } = renderHarness({
        value: "plain body",
        renderMarkdownPreview,
      });

      await Promise.resolve();
      await Promise.resolve();

      const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      expect(displayEl?.textContent).toBe("plain body");
      // The fallback shows raw text, so the markdown block-flow styling
      // must come off with it.
      expect(displayEl?.classList.contains("is-markdown")).toBe(false);
    });

    it("leaves rendered links and checkboxes to their own pointer handling instead of dragging", () => {
      const renderMarkdownPreview = jest.fn((_node, _markdown, containerEl: HTMLElement) => {
        containerEl.createEl("a", { text: "a link", attr: { href: "https://example.com" } });
        const checkboxEl = containerEl.createEl("input");
        checkboxEl.type = "checkbox";
      });
      const { nodeEl, graphInteraction } = renderHarness({
        value: "[a link](https://example.com)\n\n- [ ] task",
        renderMarkdownPreview,
      });

      const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      const linkEl = displayEl?.querySelector<HTMLElement>("a");
      const checkboxEl = displayEl?.querySelector<HTMLElement>("input");
      expect(linkEl).not.toBeNull();
      expect(checkboxEl).not.toBeNull();

      for (const targetEl of [linkEl, checkboxEl]) {
        const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "pointerId", { value: 41, configurable: true });
        targetEl?.dispatchEvent(event);
      }

      expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    });

    it("still opens edit mode on double click over rendered markdown", () => {
      const renderMarkdownPreview = jest.fn();
      const { node, nodeEl, onRequestTextNodeEdit, graphInteraction } = renderHarness({
        value: "**bold**",
        renderMarkdownPreview,
      });

      const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      displayEl?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

      expect(graphInteraction.ensureSingleSelection).toHaveBeenCalledWith(node.id);
      expect(onRequestTextNodeEdit).toHaveBeenCalledWith(node.id);
    });
  });

  describe("edit mode with the embedded markdown editor", () => {
    it("mounts the live editor host and hands it the current value and placeholder", () => {
      const capture = createEditorFactory();
      const { nodeEl } = renderHarness({
        value: "existing text",
        isEditing: true,
        createMarkdownEditor: capture.factory,
      });

      const hostEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-live-editor");
      expect(hostEl).not.toBeNull();
      expect(nodeEl.querySelector("textarea.ss-studio-text-node-editor")).toBeNull();
      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0].containerEl).toBe(hostEl);
      expect(capture.calls[0].options.value).toBe("existing text");
      expect(capture.calls[0].options.placeholder).toBe("Text");
    });

    it("marks the live editor host interactive so pointer gestures stay in the editor", () => {
      const capture = createEditorFactory();
      const { nodeEl, graphInteraction } = renderHarness({
        value: "text",
        isEditing: true,
        createMarkdownEditor: capture.factory,
      });

      const hostEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-live-editor");
      expect(hostEl?.hasAttribute("data-studio-interactive")).toBe(true);
      expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    });

    it("commits editor changes as continuous config mutations", () => {
      const capture = createEditorFactory();
      const { node, onNodeConfigValueChange } = renderHarness({
        value: "start",
        isEditing: true,
        createMarkdownEditor: capture.factory,
      });

      capture.calls[0].options.onChange?.("start plus more");

      expect(onNodeConfigValueChange).toHaveBeenCalledWith(
        node.id,
        "value",
        "start plus more",
        { mode: "continuous" }
      );
    });

    it("ends the edit session on escape and on blur", () => {
      const capture = createEditorFactory();
      const { node, onStopTextNodeEdit } = renderHarness({
        value: "x",
        isEditing: true,
        createMarkdownEditor: capture.factory,
      });

      capture.calls[0].options.onEscape?.();
      expect(onStopTextNodeEdit).toHaveBeenCalledWith(node.id);

      capture.calls[0].options.onBlur?.();
      expect(onStopTextNodeEdit).toHaveBeenCalledTimes(2);
    });

    it("registers a teardown that destroys the editor", () => {
      const capture = createEditorFactory();
      const registerEditorTeardown = jest.fn();
      const { node } = renderHarness({
        value: "x",
        isEditing: true,
        createMarkdownEditor: capture.factory,
        registerEditorTeardown,
      });

      expect(registerEditorTeardown).toHaveBeenCalledWith(node.id, expect.any(Function));
      const teardown = registerEditorTeardown.mock.calls[0][1] as () => void;
      teardown();
      expect(capture.handle.destroy).toHaveBeenCalled();
    });

    it("autofocuses and selects the editor content when requested", () => {
      jest
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
      const capture = createEditorFactory();
      renderHarness({
        value: "x",
        isEditing: true,
        shouldAutoFocus: true,
        createMarkdownEditor: capture.factory,
      });

      expect(capture.handle.focus).toHaveBeenCalled();
      expect(capture.handle.selectAll).toHaveBeenCalled();
    });

    it("skips the deferred autofocus when the editor is torn down before the frame fires", () => {
      const pendingFrames: FrameRequestCallback[] = [];
      jest
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback: FrameRequestCallback) => {
          pendingFrames.push(callback);
          return pendingFrames.length;
        });
      const capture = createEditorFactory();
      const registerEditorTeardown = jest.fn();
      renderHarness({
        value: "x",
        isEditing: true,
        shouldAutoFocus: true,
        createMarkdownEditor: capture.factory,
        registerEditorTeardown,
      });

      const teardown = registerEditorTeardown.mock.calls[0][1] as () => void;
      teardown();
      for (const frame of pendingFrames) {
        frame(0);
      }

      expect(capture.handle.focus).not.toHaveBeenCalled();
      expect(capture.handle.selectAll).not.toHaveBeenCalled();
    });

    it("falls back to the plain textarea when the factory yields no editor", () => {
      const capture = createEditorFactory("null");
      const { nodeEl } = renderHarness({
        value: "fallback text",
        isEditing: true,
        createMarkdownEditor: capture.factory,
      });

      const textareaEl = nodeEl.querySelector<HTMLTextAreaElement>(
        "textarea.ss-studio-text-node-editor"
      );
      expect(textareaEl).not.toBeNull();
      expect(textareaEl?.value).toBe("fallback text");
      expect(nodeEl.querySelector(".ss-studio-text-node-live-editor")).toBeNull();
    });

    it("does not mount the live editor while the view is busy", () => {
      const capture = createEditorFactory();
      const { nodeEl } = renderHarness({
        value: "busy text",
        isEditing: true,
        busy: true,
        createMarkdownEditor: capture.factory,
      });

      expect(capture.calls).toHaveLength(0);
      const textareaEl = nodeEl.querySelector<HTMLTextAreaElement>(
        "textarea.ss-studio-text-node-editor"
      );
      expect(textareaEl).not.toBeNull();
      expect(textareaEl?.disabled).toBe(true);
    });
  });
});
