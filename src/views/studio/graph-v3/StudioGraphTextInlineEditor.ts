import type { StudioNodeInstance } from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";

type StudioTextDisplayMode = "raw" | "rendered";

export type RenderStudioTextNodeInlineEditorOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: string,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  showTextEditor?: boolean;
};

const TEXT_DISPLAY_MODE_CONFIG_KEY = "textDisplayMode";
const FORCE_INLINE_TEXT_RENDERED_MODE = true;

function normalizeNodeKind(kind: string): string {
  return String(kind || "").trim();
}

function readConfigString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function readEditableNodeText(node: StudioNodeInstance, nodeRunState: StudioNodeRunDisplayState): string {
  if (node.kind === "studio.note") {
    const outputText = nodeRunState.outputs?.text;
    const outputPath = nodeRunState.outputs?.path;

    const readPathAtIndex = (index: number): string => {
      if (typeof outputPath === "string") {
        return outputPath.trim();
      }
      if (Array.isArray(outputPath)) {
        const value = outputPath[index];
        return typeof value === "string" ? value.trim() : "";
      }
      return "";
    };

    const formatNoteBlock = (text: string, index: number): string => {
      const path = readPathAtIndex(index);
      if (!path) {
        return text;
      }
      return `Path: ${path}\n${text}`;
    };

    if (typeof outputText === "string") {
      return formatNoteBlock(outputText, 0);
    }
    if (Array.isArray(outputText)) {
      const blocks: string[] = [];
      for (let i = 0; i < outputText.length; i += 1) {
        const entry = outputText[i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          continue;
        }
        blocks.push(formatNoteBlock(entry, i));
      }
      if (blocks.length > 0) {
        return blocks.join("\n\n---\n\n");
      }
    }
    return "";
  }
  const configuredValue = readConfigString(node.config.value);
  if (configuredValue.trim().length > 0) {
    return configuredValue;
  }
  const outputText = typeof nodeRunState.outputs?.text === "string" ? nodeRunState.outputs.text : "";
  return outputText;
}

function readTextDisplayMode(node: StudioNodeInstance): StudioTextDisplayMode {
  if (FORCE_INLINE_TEXT_RENDERED_MODE) {
    return "rendered";
  }
  const raw = readConfigString(node.config[TEXT_DISPLAY_MODE_CONFIG_KEY]).trim().toLowerCase();
  return raw === "raw" ? "raw" : "rendered";
}

export function isInlineTextNodeKind(kind: string): boolean {
  const normalizedKind = normalizeNodeKind(kind);
  return (
    normalizedKind === "studio.note" ||
    normalizedKind === "studio.text" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription"
  );
}

function resolveInlineTextEditorLabel(nodeKind: string): string {
  return nodeKind === "studio.transcription" ? "TRANSCRIPT" : "TEXT";
}

function resolveInlineTextEditorPlaceholder(nodeKind: string): string {
  if (nodeKind === "studio.transcription") {
    return "Transcribed text appears here...";
  }
  if (nodeKind === "studio.note") {
    return "Live note preview appears here...";
  }
  if (nodeKind === "studio.text_generation") {
    return "Generated text appears here...";
  }
  return "Write or paste text...";
}

function resolveInlineTextEditorAriaLabel(node: StudioNodeInstance): string {
  if (node.kind === "studio.transcription") {
    return `${node.title || "Transcription"} transcript`;
  }
  if (node.kind === "studio.note") {
    return `${node.title || "Note"} content`;
  }
  if (node.kind === "studio.text_generation") {
    return `${node.title || "Text Generation"} text`;
  }
  return `${node.title || "Text"} content`;
}

function resolveInlineRenderedEmptyState(nodeKind: string): string {
  if (nodeKind === "studio.note") {
    return "Run preview is empty. Select one or more markdown notes.";
  }
  if (nodeKind === "studio.text_generation") {
    return "Generated text appears here after a run.";
  }
  return "No markdown content yet.";
}

export function renderTextNodeInlineEditor(options: RenderStudioTextNodeInlineEditorOptions): boolean {
  const {
    nodeEl,
    node,
    nodeRunState,
    interactionLocked,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    renderMarkdownPreview,
    showTextEditor = true,
  } = options;
  if (!isInlineTextNodeKind(node.kind)) {
    return false;
  }
  if (!showTextEditor) {
    return false;
  }
  const isNoteNode = node.kind === "studio.note";
  const outputLocked = node.kind === "studio.text_generation" && node.config.lockOutput === true;
  const editorReadOnly = interactionLocked || outputLocked || isNoteNode;
  let textDisplayMode = readTextDisplayMode(node);
  let previewRenderRequest = 0;

  const editorWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-text-editor-wrap" });
  editorWrapEl.createDiv({
    cls: "ss-studio-node-text-editor-label",
    text: resolveInlineTextEditorLabel(node.kind),
  });

  const controlsEl = editorWrapEl.createDiv({ cls: "ss-studio-node-text-editor-controls" });
  const modeToggleEl = controlsEl.createDiv({ cls: "ss-studio-node-text-display-mode" });
  modeToggleEl.createEl("span", {
    cls: "ss-studio-node-text-display-mode-label",
    text: "Mode",
  });

  const rawModeButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Raw",
    attr: {
      "aria-label": "Show raw markdown source",
    },
  });
  rawModeButtonEl.type = "button";
  rawModeButtonEl.disabled = interactionLocked || isNoteNode;

  const renderedModeButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Rendered",
    attr: {
      "aria-label": "Show rendered markdown preview",
    },
  });
  renderedModeButtonEl.type = "button";
  renderedModeButtonEl.disabled = interactionLocked || isNoteNode;

  const rawSurfaceEl = editorWrapEl.createDiv({ cls: "ss-studio-node-text-editor-surface" });
  const textEditorEl = rawSurfaceEl.createEl("textarea", {
    cls: "ss-studio-node-text-editor",
    attr: {
      placeholder: resolveInlineTextEditorPlaceholder(node.kind),
      "aria-label": resolveInlineTextEditorAriaLabel(node),
    },
  });
  textEditorEl.value = readEditableNodeText(node, nodeRunState);
  textEditorEl.readOnly = editorReadOnly;
  textEditorEl.disabled = false;
  if (!isNoteNode) {
    textEditorEl.addEventListener("input", (event) => {
      const nextValue = (event.target as HTMLTextAreaElement).value;
      if (onNodeConfigValueChange) {
        onNodeConfigValueChange(node.id, "value", nextValue, { mode: "continuous" });
        return;
      }
      node.config.value = nextValue;
      onNodeConfigMutated(node);
    });
  }

  const renderedSurfaceEl = editorWrapEl.createDiv({
    cls: "ss-studio-node-text-rendered is-hidden",
    attr: {
      "aria-label": `${resolveInlineTextEditorAriaLabel(node)} rendered markdown`,
    },
  });
  renderedSurfaceEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  renderedSurfaceEl.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const commitPresentationMutation = (nextMode: StudioTextDisplayMode): void => {
    if (onNodeConfigValueChange) {
      onNodeConfigValueChange(node.id, TEXT_DISPLAY_MODE_CONFIG_KEY, nextMode, { mode: "discrete" });
      return;
    }
    node.config[TEXT_DISPLAY_MODE_CONFIG_KEY] = nextMode;
    onNodeConfigMutated(node);
  };

  const renderMarkdownSurface = (): void => {
    const content = textEditorEl.value;
    renderedSurfaceEl.empty();
    if (!content.trim()) {
      renderedSurfaceEl.createDiv({
        cls: "ss-studio-node-text-rendered-empty",
        text: resolveInlineRenderedEmptyState(node.kind),
      });
      return;
    }

    if (!renderMarkdownPreview) {
      renderedSurfaceEl.setText(content);
      return;
    }

    const currentRenderRequest = previewRenderRequest + 1;
    previewRenderRequest = currentRenderRequest;
    void Promise.resolve(renderMarkdownPreview(node, content, renderedSurfaceEl)).catch(() => {
      if (currentRenderRequest !== previewRenderRequest) {
        return;
      }
      renderedSurfaceEl.empty();
      renderedSurfaceEl.setText(content);
    });
  };

  const syncRenderedSurfaceHeightToRaw = (): void => {
    const rawHeight = Math.round(textEditorEl.getBoundingClientRect().height);
    if (rawHeight > 0) {
      renderedSurfaceEl.style.height = `${rawHeight}px`;
      return;
    }
    renderedSurfaceEl.style.removeProperty("height");
  };

  const applyDisplayMode = (): void => {
    if (isNoteNode) {
      textDisplayMode = "raw";
    }
    const showRaw = textDisplayMode === "raw";
    if (!showRaw) {
      syncRenderedSurfaceHeightToRaw();
      renderMarkdownSurface();
    }
    rawSurfaceEl.toggleClass("is-hidden", !showRaw);
    renderedSurfaceEl.toggleClass("is-hidden", showRaw);
    rawModeButtonEl.classList.toggle("is-active", showRaw);
    renderedModeButtonEl.classList.toggle("is-active", !showRaw);
    rawModeButtonEl.setAttr("aria-pressed", showRaw ? "true" : "false");
    renderedModeButtonEl.setAttr("aria-pressed", showRaw ? "false" : "true");
    textEditorEl.readOnly = editorReadOnly || !showRaw;
    textEditorEl.disabled = false;
  };

  rawModeButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked || isNoteNode || textDisplayMode === "raw") {
      return;
    }
    textDisplayMode = "raw";
    commitPresentationMutation("raw");
    applyDisplayMode();
  });

  renderedModeButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked || isNoteNode || textDisplayMode === "rendered") {
      return;
    }
    textDisplayMode = "rendered";
    commitPresentationMutation("rendered");
    applyDisplayMode();
  });

  if (isNoteNode) {
    modeToggleEl.addClass("is-hidden");
  }
  applyDisplayMode();
  return true;
}
