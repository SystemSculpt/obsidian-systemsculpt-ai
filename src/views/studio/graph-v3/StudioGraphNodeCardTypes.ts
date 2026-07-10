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
import type {
  StudioTextNodeMarkdownEditorFactory,
  StudioTextNodeMarkdownEditorSnapshot,
} from "./StudioGraphTextNodeCard";

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
  isTextNodeEditing: (nodeId: string) => boolean;
  consumeTextNodeAutoFocus: (nodeId: string) => boolean;
  consumeTextNodeFocusPoint: (nodeId: string) => { x: number; y: number } | undefined;
  consumeTextNodeEditorSnapshot: (
    nodeId: string
  ) => StudioTextNodeMarkdownEditorSnapshot | undefined;
  onRequestTextNodeEdit: (nodeId: string, focusAt?: { x: number; y: number }) => void;
  onStopTextNodeEdit: (nodeId: string) => void;
  createTextNodeMarkdownEditor?: StudioTextNodeMarkdownEditorFactory;
  registerTextNodeEditorTeardown?: (
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ) => void;
  onRevealPathInFinder: (path: string) => void;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
};
