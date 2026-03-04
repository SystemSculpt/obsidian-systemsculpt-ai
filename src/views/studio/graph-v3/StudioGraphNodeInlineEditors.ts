import type {
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import { renderInlineConfigPanel } from "./StudioGraphInlineConfigPanel";
import { renderJsonNodeEditor, type StudioJsonEditorMode } from "./StudioGraphJsonInlineEditor";

type RenderStudioNodeInlineEditorOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  definition: StudioNodeDefinition;
  inboundEdges?: Array<{
    fromNodeId: string;
    fromPortId: string;
    toPortId: string;
  }>;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodePresentationMutated?: (node: StudioNodeInstance) => void;
  getJsonEditorPreferredMode?: () => StudioJsonEditorMode;
  onJsonEditorPreferredModeChange?: (mode: StudioJsonEditorMode) => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
  nodeDetailMode?: StudioNodeDetailMode;
  showTextEditor?: boolean;
  showSystemPromptField?: boolean;
  showOutputPreview?: boolean;
  showFieldHelp?: boolean;
};

type StudioTextDisplayMode = "raw" | "rendered";

const INLINE_EDITOR_NODE_KINDS = new Set<string>([
  "studio.input",
  "studio.json",
  "studio.value",
  "studio.label",
  "studio.cli_command",
  "studio.terminal",
  "studio.dataset",
  "studio.http_request",
  "studio.image_generation",
  "studio.media_ingest",
  "studio.audio_extract",
  "studio.note",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS = new Set<string>([
  "studio.image_generation",
  "studio.json",
  "studio.value",
  "studio.media_ingest",
  "studio.dataset",
  "studio.terminal",
  "studio.note",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const TEXT_DISPLAY_MODE_CONFIG_KEY = "textDisplayMode";
const FORCE_INLINE_TEXT_RENDERED_MODE = true;
const HTTP_INPUT_BINDING_LABELS: Record<string, string> = {
  url: "URL",
  headers: "Headers",
  query: "Query Params",
  path_params: "Path Params",
  bearer_token: "Bearer Token",
  body_json: "Body JSON",
  body_text: "Body Text",
};

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

function isInlineTextNodeKind(kind: string): boolean {
  const normalizedKind = normalizeNodeKind(kind);
  return (
    normalizedKind === "studio.note" ||
    normalizedKind === "studio.text" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription"
  );
}

function renderDatasetOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
}): void {
  const { nodeEl, node, nodeRunState } = options;
  const outputText = typeof nodeRunState.outputs?.text === "string" ? nodeRunState.outputs.text : "";
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-output-preview" });
  outputWrapEl.createDiv({
    cls: "ss-studio-node-inline-output-preview-label",
    text: "LATEST RESULT",
  });
  const outputEditorEl = outputWrapEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "Dataset"} latest result`,
      readonly: "readonly",
    },
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = outputText.trim()
    ? outputText
    : "Run this dataset node to preview the latest dataset result.";
}

function formatJsonPreview(value: unknown): string {
  if (typeof value === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderValueOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
}): void {
  const { nodeEl, node, nodeRunState } = options;
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  const seededValue = (node.config as Record<string, unknown>).__studio_seed_value;
  const outputValue = outputs && Object.prototype.hasOwnProperty.call(outputs, "value")
    ? outputs.value
    : seededValue;
  const previewText = formatJsonPreview(outputValue);
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-output-preview" });
  outputWrapEl.createDiv({
    cls: "ss-studio-node-inline-output-preview-label",
    text: "VALUE PREVIEW",
  });
  const outputEditorEl = outputWrapEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "Value"} preview`,
      readonly: "readonly",
    },
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = previewText.trim()
    ? previewText
    : "Connect an output and run this node to inspect the value.";
}

function renderHttpRequestBindingSummary(options: {
  nodeEl: HTMLElement;
  inboundEdges?: Array<{
    fromNodeId: string;
    fromPortId: string;
    toPortId: string;
  }>;
}): void {
  const { nodeEl } = options;
  const inboundEdges = options.inboundEdges || [];
  const normalized = inboundEdges
    .filter((edge) => Object.prototype.hasOwnProperty.call(HTTP_INPUT_BINDING_LABELS, edge.toPortId))
    .map((edge) => ({
      ...edge,
      label: HTTP_INPUT_BINDING_LABELS[edge.toPortId] || edge.toPortId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.fromNodeId.localeCompare(b.fromNodeId));

  const wrapEl = nodeEl.createDiv({ cls: "ss-studio-node-http-bindings" });
  wrapEl.createDiv({
    cls: "ss-studio-node-http-bindings-label",
    text: "CONNECTED INPUTS",
  });

  if (normalized.length === 0) {
    wrapEl.createDiv({
      cls: "ss-studio-node-http-bindings-empty",
      text: "None. Use input ports to bind URL/body/auth/query dynamically.",
    });
    return;
  }

  const listEl = wrapEl.createEl("ul", { cls: "ss-studio-node-http-bindings-list" });
  for (const edge of normalized) {
    const itemEl = listEl.createEl("li", { cls: "ss-studio-node-http-bindings-item" });
    itemEl.createEl("span", {
      cls: "ss-studio-node-http-bindings-target",
      text: edge.label,
    });
    itemEl.createEl("code", {
      cls: "ss-studio-node-http-bindings-source",
      text: `${edge.fromNodeId}.${edge.fromPortId}`,
    });
  }
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

function renderInlineTextNodeEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    nodeEl,
    node,
    nodeRunState,
    interactionLocked,
    onNodeConfigMutated,
    onNodePresentationMutated,
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
      node.config.value = (event.target as HTMLTextAreaElement).value;
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

  const commitPresentationMutation = (): void => {
    if (onNodePresentationMutated) {
      onNodePresentationMutated(node);
      return;
    }
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
    node.config[TEXT_DISPLAY_MODE_CONFIG_KEY] = "raw";
    commitPresentationMutation();
    applyDisplayMode();
  });

  renderedModeButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked || isNoteNode || textDisplayMode === "rendered") {
      return;
    }
    textDisplayMode = "rendered";
    node.config[TEXT_DISPLAY_MODE_CONFIG_KEY] = "rendered";
    commitPresentationMutation();
    applyDisplayMode();
  });

  if (isNoteNode) {
    modeToggleEl.addClass("is-hidden");
  }
  applyDisplayMode();
  return true;
}

function renderNodeSpecificInlineConfig(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    node,
    nodeEl,
    nodeRunState,
    definition,
    interactionLocked,
    onNodeConfigMutated,
    nodeDetailMode,
    showSystemPromptField = true,
    showOutputPreview = true,
    showFieldHelp = true,
    resolveDynamicSelectOptions,
  } = options;
  const hiddenFieldKeys = new Set<string>();
  if (!showSystemPromptField) {
    hiddenFieldKeys.add("systemPrompt");
  }
  const kind = normalizeNodeKind(node.kind);

  if (kind === "studio.image_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["modelId", "count", "aspectRatio"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.media_ingest") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["sourcePath"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.audio_extract") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["ffmpegCommand", "outputFormat", "outputPath", "timeoutMs", "maxOutputBytes"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.note") {
    const compactTextareaFieldKeys =
      nodeDetailMode === "collapsed" ? new Set<string>(["preface"]) : undefined;
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["preface", "notes"],
      interactionLocked,
      onNodeConfigMutated,
      compactTextareaFieldKeys,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.text_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["sourceMode", "modelId", "localModelId", "reasoningEffort", "systemPrompt"],
      interactionLocked,
      onNodeConfigMutated,
      panelClassName: "ss-studio-node-inline-config--text-generation",
      hiddenFieldKeys,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.dataset") {
    const rendered = renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: [
        "workingDirectory",
        "customQuery",
        "adapterCommand",
        "adapterArgs",
        "refreshHours",
        "timeoutMs",
        "maxOutputBytes",
      ],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
    if (rendered && showOutputPreview) {
      renderDatasetOutputPreview({
        nodeEl,
        node,
        nodeRunState,
      });
    }
    return rendered;
  }

  if (kind === "studio.json") {
    return renderJsonNodeEditor({
      ...options,
      showOutputPreview,
    });
  }

  if (kind === "studio.value") {
    if (showOutputPreview) {
      renderValueOutputPreview({
        nodeEl,
        node,
        nodeRunState,
      });
    }
    return true;
  }

  if (kind === "studio.http_request") {
    const rendered = renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: [
        "method",
        "url",
        "headers",
        "bearerToken",
        "body",
        "maxRetries",
      ],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
    renderHttpRequestBindingSummary({
      nodeEl,
      inboundEdges: options.inboundEdges,
    });
    return rendered || nodeEl.hasChildNodes();
  }

  if (kind === "studio.cli_command") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["command", "args", "cwd", "timeoutMs", "maxOutputBytes"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.terminal") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["cwd", "shellProfile", "scrollback", "width", "height"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.input") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["value"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
  }

  if (isInlineTextNodeKind(kind)) {
    return false;
  }

  return renderInlineConfigPanel({
    nodeEl,
    node,
    definition,
    orderedFieldKeys: definition.configSchema.fields.map((field) => field.key),
    interactionLocked,
    onNodeConfigMutated,
    showFieldHelp,
    resolveDynamicSelectOptions,
  });
}

export function renderStudioNodeInlineEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const renderedConfig = renderNodeSpecificInlineConfig(options);
  const renderedTextEditor = renderInlineTextNodeEditor(options);
  return renderedConfig || renderedTextEditor;
}

export function hasStudioNodeInlineEditor(kind: string): boolean {
  return INLINE_EDITOR_NODE_KINDS.has(normalizeNodeKind(kind));
}

export function shouldSuppressNodeOutputPreview(kind: string): boolean {
  return OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS.has(normalizeNodeKind(kind));
}
