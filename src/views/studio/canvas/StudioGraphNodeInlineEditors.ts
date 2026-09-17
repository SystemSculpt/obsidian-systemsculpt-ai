import type { StudioMediaNodeInputPlan } from "../../../studio/StudioMediaModelCapabilities";
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
import { renderInlineConfigPanel, type StudioMediaModelPickerOpener } from "./StudioGraphInlineConfigPanel";
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
  openMediaModelPicker?: StudioMediaModelPickerOpener;
  /** Per-model input plan for media nodes; hides fields the selected model cannot honour. */
  mediaInputPlan?: StudioMediaNodeInputPlan | null;
  nodeDetailMode?: StudioNodeDetailMode;
  showTextEditor?: boolean;
  showSystemPromptField?: boolean;
  showOutputPreview?: boolean;
  showFieldHelp?: boolean;
};

const OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS = new Set<string>([
  "studio.image_generation",
  "studio.video_generation",
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

// Only form surfaces reach this renderer; CODE and panel surfaces own their editors.
const FORM_PRESENTATION: Record<string, { fields: string[]; className?: string }> = {
  "studio.image_generation": { fields: ["prompt", "model", "count", "aspectRatio", "imageSize", "quality"], className: "image-generation" },
  "studio.video_generation": { fields: ["prompt", "model", "durationSeconds", "resolution", "aspectRatio", "generateAudio"], className: "video-generation" },
  "studio.media_ingest": { fields: ["sourcePath"] },
  "studio.audio_extract": { fields: ["ffmpegCommand", "outputFormat", "outputPath", "timeoutMs", "maxOutputBytes"] },
  "studio.note": { fields: ["preface", "notes"] },
  "studio.text_generation": { fields: ["systemPrompt"], className: "text-generation" },
  "studio.dataset": { fields: ["workingDirectory", "customQuery", "adapterCommand", "adapterArgs", "refreshHours", "timeoutMs", "maxOutputBytes"] },
  "studio.input": { fields: ["value"] },
};

function renderNodeSpecificInlineConfig(options: RenderStudioNodeInlineEditorOptions): boolean {
  const kind = normalizeNodeKind(options.node.kind);
  const presentation = FORM_PRESENTATION[kind];
  if (!presentation && isInlineTextNodeKind(kind)) return false;
  const isMediaGeneration = kind === "studio.image_generation" || kind === "studio.video_generation";
  const hiddenFieldKeys = new Set(isMediaGeneration ? options.mediaInputPlan?.hiddenFieldKeys : []);
  if (kind === "studio.text_generation" && options.showSystemPromptField === false) hiddenFieldKeys.add("systemPrompt");
  const rendered = renderInlineConfigPanel({
    ...options,
    orderedFieldKeys: presentation?.fields ?? options.definition.configSchema.fields.map(field => field.key),
    hiddenFieldKeys,
    panelClassName: presentation?.className ? `ss-studio-node-inline-config--${presentation.className}` : undefined,
    compactTextareaFieldKeys: kind === "studio.note" && options.nodeDetailMode === "collapsed" ? new Set(["preface"]) : undefined,
    pathBrowseOptions: kind === "studio.audio_extract" ? undefined : options.pathBrowseOptions,
  });
  if (kind === "studio.dataset" && rendered && options.showOutputPreview !== false) renderDatasetOutputPreview(options);
  return rendered || kind === "studio.media_ingest";
}

export function renderStudioNodeInlineEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const renderedConfig = renderNodeSpecificInlineConfig(options);
  const renderedTextEditor = renderTextNodeInlineEditor(options);
  return renderedConfig || renderedTextEditor;
}

export function shouldSuppressNodeOutputPreview(kind: string): boolean {
  return OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS.has(normalizeNodeKind(kind));
}
