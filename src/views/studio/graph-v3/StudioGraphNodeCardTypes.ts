import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";

export type RenderStudioGraphNodeCardOptions = {
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
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodePresentationMutated?: (node: StudioNodeInstance) => void;
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
  isLabelEditing: (nodeId: string) => boolean;
  consumeLabelAutoFocus: (nodeId: string) => boolean;
  onRequestLabelEdit: (nodeId: string) => void;
  onStopLabelEdit: (nodeId: string) => void;
  onRevealPathInFinder: (path: string) => void;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
  mountTerminalNode?: (options: {
    node: StudioNodeInstance;
    nodeEl: HTMLElement;
    terminalAnchorEl: HTMLElement;
    interactionLocked: boolean;
    graphInteraction: StudioGraphInteractionEngine;
    onNodeConfigMutated: (node: StudioNodeInstance) => void;
    onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  }) => void;
};
