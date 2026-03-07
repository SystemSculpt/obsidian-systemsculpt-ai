export type SurfaceIconName =
  | "bot"
  | "paperclip"
  | "sparkles"
  | "git-fork"
  | "send"
  | "mic"
  | "video"
  | "square"
  | "search"
  | "file"
  | "file-text"
  | "headphones"
  | "image"
  | "check"
  | "clock"
  | "folder"
  | "filter"
  | "wand"
  | "brain"
  | "bolt"
  | "note"
  | "copy"
  | "book-open"
  | "library"
  | "folder-search"
  | "bug"
  | "coins"
  | "chevron-left"
  | "chevron-right"
  | "star"
  | "star-off"
  | "more-horizontal"
  | "loader-2"
  | "x"
  | "history"
  | "settings"
  | "network"
  | "trophy"
  | "refresh-ccw"
  | "clipboard"
  | "external-link"
  | "play"
  | "list";

export type SceneLayout = "center-lockup" | "split-left" | "split-right" | "stacked";

export interface ToolbarChipSpec {
  id: string;
  label: string;
  icon: SurfaceIconName;
  tone?: "neutral" | "accent" | "success";
}

export interface AttachmentPillSpec {
  id: string;
  label: string;
  icon: SurfaceIconName;
  state?: "ready" | "processing" | "new";
}

export interface CitationSpec {
  id: string;
  title: string;
  url: string;
  snippet?: string;
}

export interface StructuredLineSpec {
  id: string;
  prefix: string;
  label: string;
  detail?: string;
  active?: boolean;
}

export type TextRevealMode = "type" | "stream";

export interface TextRevealSpec {
  mode: TextRevealMode;
  startFrame?: number;
  durationInFrames?: number;
  unitsPerSecond?: number;
  lineDelayInFrames?: number;
  showCursor?: boolean;
}

export interface BaseInlineBlockSpec {
  id: string;
  title: string;
  status: string;
  statusTone?: "pending" | "success" | "error";
  collapsed?: boolean;
  streaming?: boolean;
  reveal?: TextRevealSpec;
}

export interface ReasoningBlockSpec extends BaseInlineBlockSpec {
  kind: "reasoning";
  textLines: readonly string[];
}

export interface ToolCallResultSpec {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ToolCallBlockSpec extends BaseInlineBlockSpec {
  kind: "tool_call";
  lines?: readonly StructuredLineSpec[];
  toolName?: string;
  arguments?: Record<string, unknown>;
  result?: ToolCallResultSpec;
  serverId?: string;
}

export type InlineBlockSpec = ReasoningBlockSpec | ToolCallBlockSpec;

export interface ChatMessageSpec {
  id: string;
  role: "assistant" | "user" | "system";
  markdown?: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  citations?: readonly CitationSpec[];
  inlineBlocks?: readonly InlineBlockSpec[];
  reveal?: TextRevealSpec;
}

export interface ComposerDraftSpec {
  text: string;
  placeholder?: string;
  reveal?: TextRevealSpec;
}

export interface FilterChipSpec {
  id: string;
  label: string;
  icon?: SurfaceIconName;
  active?: boolean;
}

export interface ContextRowSpec {
  id: string;
  name: string;
  path: string;
  badge?: string;
  icon: SurfaceIconName;
  state?: "default" | "selected" | "attached";
}

export type SearchModeSpec = "smart" | "lexical" | "semantic";
export type SearchSortSpec = "relevance" | "recency";
export type SearchOriginSpec = "lexical" | "semantic" | "blend" | "recent";

export interface SearchResultSpec {
  id: string;
  path: string;
  title: string;
  excerpt?: string;
  score: number;
  origin: SearchOriginSpec;
  updatedAt?: number;
  size?: number;
}

export interface SearchMetricsSpec {
  totalMs: number;
  lexMs?: number;
  semMs?: number;
  indexMs?: number;
  indexedCount: number;
  inspectedCount: number;
  mode: SearchModeSpec;
  usedEmbeddings: boolean;
}

export interface SearchEmbeddingsIndicatorSpec {
  enabled: boolean;
  ready: boolean;
  available: boolean;
  reason?: string;
  processed?: number;
  total?: number;
}

export interface HistoryEntrySpec {
  id: string;
  kind: "chat" | "studio";
  title: string;
  subtitle?: string;
  badge: string;
  timestampMs: number;
  searchText?: string;
  isFavorite?: boolean;
}

export interface CreditsBalanceSpec {
  includedRemaining: number;
  addOnRemaining: number;
  totalRemaining: number;
  includedPerMonth: number;
  cycleStartedAt: string;
  cycleEndsAt: string;
  cycleAnchorAt?: string | null;
  turnInFlightUntil?: string | null;
  purchaseUrl?: string | null;
}

export interface CreditsUsageEntrySpec {
  id: string;
  createdAt: string;
  transactionType: "agent_turn";
  endpoint: string | null;
  usageKind:
    | "audio_transcription"
    | "embeddings"
    | "document_processing"
    | "youtube_transcript"
    | "agent_turn"
    | "request";
  durationSeconds: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  pageCount: number;
  creditsCharged: number;
  includedDelta: number;
  addOnDelta: number;
  totalDelta: number;
  includedBefore: number;
  includedAfter: number;
  addOnBefore: number;
  addOnAfter: number;
  totalBefore: number;
  totalAfter: number;
  rawUsd?: number;
  fileSizeBytes: number | null;
  fileFormat: string | null;
  billingFormulaVersion?: string | null;
  billingCreditsPerUsd?: number | null;
  billingMarkupMultiplier?: number | null;
  billingCreditsExact?: number | null;
}

export interface CreditsUsagePageSpec {
  items: readonly CreditsUsageEntrySpec[];
  nextBefore: string | null;
}

export interface EmbeddingsStatsSpec {
  total: number;
  processed: number;
  present: number;
  needsProcessing: number;
  failed: number;
}

export interface BenchLeaderboardEntrySpec {
  id: string;
  modelId: string;
  modelDisplayName: string;
  scorePercent: number;
  totalPointsEarned: number;
  totalMaxPoints: number;
  runId: string;
  runDate: string;
  suiteId: string;
  suiteVersion: string;
}

export interface SettingsSidebarTabSpec {
  id: string;
  label: string;
  active?: boolean;
}

export type SettingsControlSpec =
  | {
      kind: "toggle";
      value: boolean;
      disabled?: boolean;
    }
  | {
      kind: "dropdown";
      value: string;
      options: readonly string[];
      disabled?: boolean;
    }
  | {
      kind: "text";
      value: string;
      placeholder?: string;
      secret?: boolean;
      disabled?: boolean;
    }
  | {
      kind: "button";
      label: string;
      tone?: "default" | "warning" | "accent";
      disabled?: boolean;
    };

export interface SettingsFieldSpec {
  id: string;
  label: string;
  description?: string;
  note?: string;
  control: SettingsControlSpec;
}

export interface SettingsSectionSpec {
  id: string;
  title: string;
  description?: string;
  fields: readonly SettingsFieldSpec[];
}

export interface StudioGraphNodeSpec {
  id: string;
  kind: string;
  version: string;
  title: string;
  position: {
    x: number;
    y: number;
  };
  config: Record<string, unknown>;
}

export interface StudioGraphEdgeSpec {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
}

export interface StudioGraphGroupSpec {
  id: string;
  name: string;
  color?: string;
  nodeIds: string[];
}

export interface StudioGraphViewportSpec {
  zoom: number;
  scrollLeft?: number;
  scrollTop?: number;
}

export interface StudioGraphNodeStateSpec {
  nodeId: string;
  status: "idle" | "pending" | "running" | "cached" | "succeeded" | "failed";
  message?: string;
  updatedAt?: string | null;
  outputs?: Record<string, unknown> | null;
}

export interface StatusChipSpec {
  id: string;
  label: string;
  value: string;
  icon: SurfaceIconName;
}

export interface StatusActionSpec {
  id: string;
  label: string;
  icon: SurfaceIconName;
  primary?: boolean;
}

export interface ContextModalSurfaceSpec {
  kind: "context-modal";
  title: string;
  searchValue: string;
  searchReveal?: TextRevealSpec;
  filters: readonly FilterChipSpec[];
  rows: readonly ContextRowSpec[];
  primaryActionLabel: string;
  secondaryActionLabel: string;
}

export interface SearchModalSurfaceSpec {
  kind: "search-modal";
  query: string;
  queryReveal?: TextRevealSpec;
  mode: SearchModeSpec;
  sort: SearchSortSpec;
  recents: readonly SearchResultSpec[];
  results: readonly SearchResultSpec[];
  metrics: SearchMetricsSpec;
  embeddings: SearchEmbeddingsIndicatorSpec;
  stateText?: string;
}

export interface HistoryModalSurfaceSpec {
  kind: "history-modal";
  searchValue: string;
  searchReveal?: TextRevealSpec;
  entries: readonly HistoryEntrySpec[];
}

export interface CreditsModalSurfaceSpec {
  kind: "credits-modal";
  balance: CreditsBalanceSpec;
  usage?: CreditsUsagePageSpec;
  activeTab?: "balance" | "usage";
}

export interface EmbeddingsStatusSurfaceSpec {
  kind: "embeddings-status-modal";
  embeddingsEnabled?: boolean;
  provider: string;
  model: string;
  schema: number;
  stats: EmbeddingsStatsSpec;
  isProcessing?: boolean;
  errorMessage?: string;
}

export interface BenchResultsSurfaceSpec {
  kind: "bench-results-view";
  status?: "success" | "empty" | "error";
  errorMessage?: string;
  entries: readonly BenchLeaderboardEntrySpec[];
}

export interface SettingsPanelSurfaceSpec {
  kind: "settings-panel";
  searchValue?: string;
  tabs: readonly SettingsSidebarTabSpec[];
  sections: readonly SettingsSectionSpec[];
}

export interface StudioGraphSurfaceSpec {
  kind: "studio-graph-view";
  projectName: string;
  projectPath: string;
  nodes: readonly StudioGraphNodeSpec[];
  edges: readonly StudioGraphEdgeSpec[];
  entryNodeIds: readonly string[];
  groups?: readonly StudioGraphGroupSpec[];
  viewport?: StudioGraphViewportSpec;
  nodeDetailMode?: "expanded" | "collapsed";
  nodeStates?: readonly StudioGraphNodeStateSpec[];
  modelOptions?: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    badge?: string;
  }>;
}

export interface ViewActionSpec {
  id: string;
  icon: SurfaceIconName;
  className?: string;
  ariaLabel?: string;
  title?: string;
}

export interface ViewChromeSpec {
  title?: string;
  navIcons?: readonly SurfaceIconName[];
  actions?: readonly ViewActionSpec[];
  showDragOverlay?: boolean;
  showScrollToBottom?: boolean;
  chatFontSize?: "small" | "medium" | "large";
}

export interface ChatStatusSurfaceSpec {
  kind: "chat-status";
  toolbarChips: readonly ToolbarChipSpec[];
  attachments: readonly AttachmentPillSpec[];
  eyebrow: string;
  title: string;
  description: string;
  chips: readonly StatusChipSpec[];
  actions: readonly StatusActionSpec[];
  note?: string;
  draft?: ComposerDraftSpec;
}

export interface ChatThreadSurfaceSpec {
  kind: "chat-thread";
  toolbarChips: readonly ToolbarChipSpec[];
  attachments: readonly AttachmentPillSpec[];
  messages: readonly ChatMessageSpec[];
  draft?: ComposerDraftSpec;
  recording?: "none" | "video" | "mic";
  stopVisible?: boolean;
}

export type SurfaceSpec =
  | SearchModalSurfaceSpec
  | ContextModalSurfaceSpec
  | HistoryModalSurfaceSpec
  | CreditsModalSurfaceSpec
  | EmbeddingsStatusSurfaceSpec
  | BenchResultsSurfaceSpec
  | SettingsPanelSurfaceSpec
  | StudioGraphSurfaceSpec
  | ChatStatusSurfaceSpec
  | ChatThreadSurfaceSpec;

export interface SceneSpec {
  id: string;
  label: string;
  durationInFrames: number;
  layout: SceneLayout;
  surface: SurfaceSpec;
  viewChrome?: ViewChromeSpec;
  kicker?: string;
  headlineLines: string[];
  supportingText?: string;
  accentLineIndex?: number;
  accentColor: string;
  background: readonly [string, string];
}

export interface AudioCue {
  id: string;
  frame: number;
  type: "downbeat" | "whoosh" | "impact";
}

export interface Storyboard {
  id: string;
  title: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  scenes: readonly SceneSpec[];
  audioCueMap: readonly AudioCue[];
}

export interface SceneOffset {
  scene: SceneSpec;
  from: number;
  to: number;
}

export const getStoryboardDuration = (scenes: readonly SceneSpec[]): number => {
  return scenes.reduce((total, scene) => total + scene.durationInFrames, 0);
};

export const getSceneOffsets = (scenes: readonly SceneSpec[]): SceneOffset[] => {
  let cursor = 0;
  return scenes.map((scene) => {
    const from = cursor;
    cursor += scene.durationInFrames;
    return {
      scene,
      from,
      to: cursor,
    };
  });
};
