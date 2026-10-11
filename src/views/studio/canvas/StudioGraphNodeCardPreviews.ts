import type { StudioNodeInstance } from "../../../studio/types";
import {
  readStudioImageBoard,
  resolveStudioImageBoardRenderedAsset,
  studioImageBoardHasEdits,
} from "../../../studio/StudioImageBoard";
import { mountStudioImageBoardPreview } from "./image-board/StudioImageBoardPreview";
import type { StudioGraphNodeImageBoardOptions } from "./StudioGraphNodeCardTypes";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";
import { shouldSuppressNodeOutputPreview } from "./StudioGraphNodeInlineEditors";
import {
  formatNodeOutputPreview,
  type StudioNodeRunDisplayState,
} from "../StudioRunPresentationState";
import { hasHostCapability } from "../../../platform/hostCapabilities";

export function resolveMediaIngestRevealPath(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null,
  fallbackPath: string
): string {
  if (node.kind !== "studio.media_ingest") {
    return "";
  }

  const config = (node.config || {}) as Record<string, unknown>;
  const sourcePreviewPath = typeof outputs?.source_preview_path === "string" ? outputs.source_preview_path.trim() : "";
  const configuredPath = typeof config.sourcePath === "string" ? config.sourcePath.trim() : "";
  const renderedAsset = resolveStudioImageBoardRenderedAsset(
    node.config,
    sourcePreviewPath || configuredPath
  );
  if (renderedAsset?.path) {
    return renderedAsset.path;
  }

  const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
  if (outputPath) {
    return outputPath;
  }
  if (configuredPath) {
    return configuredPath;
  }
  return String(fallbackPath || "").trim();
}

/** An edited board whose flattened image has not been produced, or is stale. */
function hasUnrenderedImageBoard(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null
): boolean {
  if (!studioImageBoardHasEdits(readStudioImageBoard(node.config))) {
    return false;
  }
  const sourcePreviewPath = typeof outputs?.source_preview_path === "string" ? outputs.source_preview_path.trim() : "";
  const configuredPath = typeof node.config.sourcePath === "string" ? node.config.sourcePath.trim() : "";
  return resolveStudioImageBoardRenderedAsset(node.config, sourcePreviewPath || configuredPath) === null;
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
  imageBoard?: StudioGraphNodeImageBoardOptions;
}): (() => void) | void {
  const {
    nodeEl,
    node,
    nodeRunState,
    resolveAssetPreviewSrc,
    onRevealPathInFinder,
    onOpenMediaPreview,
    imageBoard,
  } = options;

  const mediaPreview = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs
  );
  if (!mediaPreview || !resolveAssetPreviewSrc) {
    return;
  }

  const previewSrc = resolveAssetPreviewSrc(mediaPreview.path);
  if (!previewSrc) {
    nodeEl.createDiv({ cls: "ss-studio-source-empty", text: "Waiting for this media file to become available on this device…" });
    return;
  }

  const previewEl = nodeEl.createDiv({ cls: "ss-studio-node-media-preview" });
  const canRevealInFileManager = node.kind === "studio.media_ingest"
    && hasHostCapability("file-manager-reveal", nodeEl);
  if (node.kind === "studio.media_ingest") {
    previewEl.addClass("is-media-ingest");
    if (mediaPreview.kind === "image") {
      previewEl.addClass("is-contained-image");
    }
    if (canRevealInFileManager) {
      previewEl.setAttribute("title", "Double-click to reveal in file manager");
    }
  }
  previewEl.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    if (canRevealInFileManager) {
      const revealPath = resolveMediaIngestRevealPath(
        node,
        nodeRunState.outputs,
        mediaPreview.path
      );
      if (revealPath) {
        onRevealPathInFinder(revealPath);
        return;
      }
    }
    onOpenMediaPreview?.({
      kind: mediaPreview.kind,
      path: mediaPreview.path,
      src: previewSrc,
      title: node.title || node.kind,
    });
  });

  if (mediaPreview.kind === "image") {
    if (imageBoard && node.kind === "studio.media_ingest" && hasUnrenderedImageBoard(node, nodeRunState.outputs)) {
      return mountStudioImageBoardPreview(previewEl, {
        app: imageBoard.app,
        readAsset: imageBoard.readAsset,
        storeAsset: imageBoard.storeAsset,
        node,
        nodeRunState,
        label: `${node.title || node.kind} edited image`,
      });
    }
    const imageEl = previewEl.createEl("img", {
      cls: "ss-studio-node-media-preview-img",
    });
    imageEl.src = previewSrc;
    imageEl.setAttribute("data-studio-asset-path", mediaPreview.path);
    imageEl.alt = `${node.title || node.kind} output image`;
    imageEl.loading = "lazy";
    imageEl.decoding = "async";
    imageEl.draggable = false;
    imageEl.addEventListener("error", () => {
      imageEl.removeAttribute("src");
      imageEl.hidden = true;
      previewEl.createDiv({ cls: "ss-studio-source-empty", text: "This image is not available on this device yet." });
    }, { once: true });
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
