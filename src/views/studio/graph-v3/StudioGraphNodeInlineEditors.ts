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
import { isInlineTextNodeKind, renderTextNodeInlineEditor } from "./StudioGraphTextInlineEditor";

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
    renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["sourcePath"],
      interactionLocked,
      onNodeConfigMutated,
      showFieldHelp,
      resolveDynamicSelectOptions,
    });
    return true;
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
      orderedFieldKeys: ["modelId", "reasoningEffort", "systemPrompt"],
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
      orderedFieldKeys: ["shellProfile", "cwd"],
      interactionLocked,
      onNodeConfigMutated,
      panelClassName: "ss-studio-node-inline-config--terminal",
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
  const renderedTextEditor = renderTextNodeInlineEditor(options);
  return renderedConfig || renderedTextEditor;
}

export function hasStudioNodeInlineEditor(kind: string): boolean {
  return INLINE_EDITOR_NODE_KINDS.has(normalizeNodeKind(kind));
}

export function shouldSuppressNodeOutputPreview(kind: string): boolean {
  return OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS.has(normalizeNodeKind(kind));
}
