import type { StudioNodeInstance } from "../../../studio/types";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";
import { shouldSuppressNodeOutputPreview } from "./StudioGraphNodeInlineEditors";
import {
  formatNodeOutputPreview,
  type StudioNodeRunDisplayState,
} from "../StudioRunPresentationState";

export function resolveMediaIngestRevealPath(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null,
  fallbackPath: string
): string {
  if (node.kind !== "studio.media_ingest") {
    return "";
  }

  const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
  if (outputPath) {
    return outputPath;
  }
  const config = (node.config || {}) as Record<string, unknown>;
  const configuredPath = typeof config.sourcePath === "string" ? config.sourcePath.trim() : "";
  if (configuredPath) {
    return configuredPath;
  }
  return String(fallbackPath || "").trim();
}

export function renderNodeOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  showOutputPreview: boolean;
}): void {
  const { nodeEl, node, nodeRunState, showOutputPreview } = options;
  const outputPreview = shouldSuppressNodeOutputPreview(node.kind)
    ? ""
    : formatNodeOutputPreview(nodeRunState.outputs);
  if (!showOutputPreview || !outputPreview) {
    return;
  }

  const outputPreviewEl = nodeEl.createDiv({ cls: "ss-studio-node-output-preview" });
  const separatorIndex = outputPreview.indexOf(":");
  if (separatorIndex > 0 && separatorIndex < 48) {
    const outputLabel = outputPreview.slice(0, separatorIndex).trim();
    const outputValue = outputPreview.slice(separatorIndex + 1).trim();
    outputPreviewEl.createDiv({
      cls: "ss-studio-node-output-label",
      text: outputLabel || "output",
    });
    const valueEl = outputPreviewEl.createEl("code", {
      cls: "ss-studio-node-output-value",
      text: outputValue || "—",
    });
    valueEl.title = outputValue || outputPreview;
    return;
  }

  const fallbackValueEl = outputPreviewEl.createEl("code", {
    cls: "ss-studio-node-output-value",
    text: outputPreview,
  });
  fallbackValueEl.title = outputPreview;
}

export function renderNodeMediaPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onRevealPathInFinder: (path: string) => void;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
}): void {
  const {
    nodeEl,
    node,
    nodeRunState,
    resolveAssetPreviewSrc,
    onRevealPathInFinder,
    onOpenMediaPreview,
  } = options;

  const mediaPreview = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs as Record<string, unknown> | null
  );
  if (!mediaPreview || !resolveAssetPreviewSrc) {
    return;
  }

  const previewSrc = resolveAssetPreviewSrc(mediaPreview.path);
  if (!previewSrc) {
    return;
  }

  const previewEl = nodeEl.createDiv({ cls: "ss-studio-node-media-preview" });
  if (node.kind === "studio.media_ingest") {
    previewEl.setAttribute("title", "Double-click to reveal in Finder");
  }
  previewEl.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    const revealPath = resolveMediaIngestRevealPath(
      node,
      nodeRunState.outputs as Record<string, unknown> | null,
      mediaPreview.path
    );
    if (revealPath) {
      onRevealPathInFinder(revealPath);
      return;
    }
    onOpenMediaPreview?.({
      kind: mediaPreview.kind,
      path: mediaPreview.path,
      src: previewSrc,
      title: node.title || node.kind,
    });
  });

  if (mediaPreview.kind === "image") {
    const imageEl = previewEl.createEl("img", {
      cls: "ss-studio-node-media-preview-img",
    });
    imageEl.src = previewSrc;
    imageEl.alt = `${node.title || node.kind} output image`;
    imageEl.loading = "lazy";
    imageEl.decoding = "async";
    imageEl.draggable = false;
    return;
  }

  const videoEl = previewEl.createEl("video", {
    cls: "ss-studio-node-media-preview-video",
  });
  videoEl.src = previewSrc;
  videoEl.muted = true;
  videoEl.controls = true;
  videoEl.playsInline = true;
  videoEl.preload = "metadata";
  videoEl.setAttribute("aria-label", `${node.title || node.kind} output video`);
}
