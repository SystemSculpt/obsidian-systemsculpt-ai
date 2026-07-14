import type {
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import { renderInlineConfigPanel } from "./StudioGraphInlineConfigPanel";
import { renderJsonNodeEditor, type StudioJsonEditorMode } from "./StudioGraphJsonInlineEditor";
import { isInlineTextNodeKind, renderTextNodeInlineEditor } from "./StudioGraphTextInlineEditor";
import type { StudioNodeConfigPathBrowseOptions } from "../StudioPathFieldPicker";

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
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  getJsonEditorPreferredMode?: () => StudioJsonEditorMode;
  onJsonEditorPreferredModeChange?: (mode: StudioJsonEditorMode) => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  pathBrowseOptions?: StudioNodeConfigPathBrowseOptions;
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
  "studio.text",
  "studio.cli_command",
  "studio.terminal",
  "studio.dataset",
  "studio.image_generation",
  "studio.media_ingest",
  "studio.audio_extract",
  "studio.note",
  "studio.text_output",
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
  "studio.text_output",
  "studio.text_generation",
  "studio.transcription",
]);

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

function renderNodeSpecificInlineConfig(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    node,
    nodeEl,
    nodeRunState,
    definition,
    interactionLocked,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    nodeDetailMode,
    showSystemPromptField = true,
    showOutputPreview = true,
    showFieldHelp = true,
    pathBrowseOptions,
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
      orderedFieldKeys: ["prompt", "count", "aspectRatio", "seed"],
      interactionLocked,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      panelClassName: "ss-studio-node-inline-config--image-generation",
      showFieldHelp,
      pathBrowseOptions,
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
      onNodeConfigValueChange,
      showFieldHelp,
      pathBrowseOptions,
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
      onNodeConfigValueChange,
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
      onNodeConfigValueChange,
      compactTextareaFieldKeys,
      showFieldHelp,
      pathBrowseOptions,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.text_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["systemPrompt"],
      interactionLocked,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      panelClassName: "ss-studio-node-inline-config--text-generation",
      hiddenFieldKeys,
      showFieldHelp,
      pathBrowseOptions,
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
      onNodeConfigValueChange,
      showFieldHelp,
      pathBrowseOptions,
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

  if (kind === "studio.cli_command") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["command", "args", "cwd", "timeoutMs", "maxOutputBytes"],
      interactionLocked,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      showFieldHelp,
      pathBrowseOptions,
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
      onNodeConfigValueChange,
      panelClassName: "ss-studio-node-inline-config--terminal",
      showFieldHelp,
      pathBrowseOptions,
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
      onNodeConfigValueChange,
      showFieldHelp,
      pathBrowseOptions,
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
    onNodeConfigValueChange,
    showFieldHelp,
    pathBrowseOptions,
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
