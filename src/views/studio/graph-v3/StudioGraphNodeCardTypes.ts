import type { StudioMediaModelPickerOpener } from "./StudioGraphInlineConfigPanel";
import type { StudioMediaNodeInputPlan } from "../../../studio/StudioMediaModelCapabilities";
import type { StudioAgentRuns } from '../../../services/codex/StudioAgentRuns';
import type { StudioProjectSessionAutosaveMode } from "../../../studio/StudioProjectSession";
import type {
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioNodeActivity } from "../activity/StudioActivity";
import type { StudioNodeConfigPathBrowseOptions } from "../StudioPathFieldPicker";
import type {
  StudioTextNodeMarkdownEditorFactory,
  StudioTextNodeMarkdownEditorSnapshot,
} from "./StudioGraphTextNodeCard";
import type { StudioTextNodeFocusTarget } from "./StudioGraphTextNodeFocus";

export type StudioGraphNodeMutationOptions = {
  mode?: StudioProjectSessionAutosaveMode;
  captureHistory?: boolean;
};

/**
 * One atomic geometry mutation from the resize frame: any combination of
 * size (either dimension alone is valid — text/image cards persist width
 * only), position (left/top drags keep the opposite edge anchored), and
 * fontSize (text cards scale type on vertical/corner drags). The host commits
 * the whole patch as a single `"node.geometry"` mutation → one history entry.
 */
export type StudioGraphNodeResizePatch = {
  size?: { width?: number; height?: number };
  position?: { x: number; y: number };
  fontSize?: number;
};

export type RenderStudioGraphNodeCardOptions = {
  projectId?: string;
  projectPath?: string;
  agentRuns?: StudioAgentRuns;
  projectNodes?: StudioNodeInstance[];
  getRelatedNodeRunState?: (nodeId: string) => StudioNodeRunDisplayState;
  layer: HTMLElement;
  busy: boolean;
  node: StudioNodeInstance;
  nodeDetailMode: StudioNodeDetailMode;
  inboundEdges?: Array<{
    fromNodeId: string;
    fromPortId: string;
    toPortId: string;
  }>;
  nodeRunState: StudioNodeRunDisplayState;
  /**
   * Activity for the first paint (see views/studio/activity). When absent the
   * card derives it from nodeRunState as if the run were live.
   */
  nodeActivity?: StudioNodeActivity;
  graphInteraction: StudioGraphInteractionEngine;
  findNodeDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onNodeSourceApply?: (nodeId: string, source: string, expectedSource: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onNodeResize?: (
    nodeId: string,
    patch: StudioGraphNodeResizePatch,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onEditImageWithAi?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
  getJsonEditorPreferredMode?: () => "composer" | "raw";
  onJsonEditorPreferredModeChange?: (mode: "composer" | "raw") => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
  openMediaModelPicker?: StudioMediaModelPickerOpener;
  resolveMediaNodeInputPlan?: (node: StudioNodeInstance) => StudioMediaNodeInputPlan | null;
  isTextNodeEditing: (nodeId: string) => boolean;
  consumeTextNodeAutoFocus: (nodeId: string) => boolean;
  consumeTextNodeFocusPoint: (nodeId: string) => StudioTextNodeFocusTarget | undefined;
  consumeTextNodeEditorSnapshot: (
    nodeId: string
  ) => StudioTextNodeMarkdownEditorSnapshot | undefined;
  onRequestTextNodeEdit: (nodeId: string, focusAt?: StudioTextNodeFocusTarget) => void;
  onStopTextNodeEdit: (nodeId: string) => void;
  createTextNodeMarkdownEditor?: StudioTextNodeMarkdownEditorFactory;
  registerTextNodeEditorTeardown?: (
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ) => void;
  registerNodeTeardown?: (nodeId: string, teardown: () => void) => void;
  onRevealPathInFinder: (path: string) => void;
  pathBrowseOptions?: StudioNodeConfigPathBrowseOptions;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
};
