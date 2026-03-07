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
  | "x";

export interface PanelMotion {
  fromScale: number;
  toScale: number;
  fromX: number;
  toX: number;
  fromY: number;
  toY: number;
}

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

export interface BaseInlineBlockSpec {
  id: string;
  title: string;
  status: string;
  statusTone?: "pending" | "success" | "error";
  collapsed?: boolean;
  streaming?: boolean;
}

export interface ReasoningBlockSpec extends BaseInlineBlockSpec {
  kind: "reasoning";
  textLines: readonly string[];
}

export interface ToolCallBlockSpec extends BaseInlineBlockSpec {
  kind: "tool_call";
  lines: readonly StructuredLineSpec[];
}

export type InlineBlockSpec = ReasoningBlockSpec | ToolCallBlockSpec;

export interface ChatMessageSpec {
  id: string;
  role: "assistant" | "user" | "system";
  label?: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  citations?: readonly CitationSpec[];
  inlineBlocks?: readonly InlineBlockSpec[];
}

export interface ComposerDraftSpec {
  text: string;
  placeholder?: string;
  reveal?: "static" | "type";
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
  filters: readonly FilterChipSpec[];
  rows: readonly ContextRowSpec[];
  primaryActionLabel: string;
  secondaryActionLabel: string;
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
  | ContextModalSurfaceSpec
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
  panelMotion: PanelMotion;
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
