import { isStudioVisualOnlyNodeKind } from "../../../studio/StudioNodeKinds";
import type { StudioNodeInstance } from "../../../studio/types";

export const STUDIO_GRAPH_DEFAULT_NODE_WIDTH = 280;
export const STUDIO_GRAPH_DEFAULT_NODE_HEIGHT = 164;
export const STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH = STUDIO_GRAPH_DEFAULT_NODE_WIDTH * 2;
export const STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT = STUDIO_GRAPH_DEFAULT_NODE_HEIGHT * 2;

export const STUDIO_GRAPH_LABEL_MIN_WIDTH = 140;
export const STUDIO_GRAPH_LABEL_MAX_WIDTH = 1000;
export const STUDIO_GRAPH_LABEL_MIN_HEIGHT = 90;
export const STUDIO_GRAPH_LABEL_MAX_HEIGHT = 800;
export const STUDIO_GRAPH_LABEL_MIN_FONT_SIZE = 10;
export const STUDIO_GRAPH_LABEL_MAX_FONT_SIZE = 48;
export const STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE = 14;

function readFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function isStudioLabelNode(node: Pick<StudioNodeInstance, "kind">): boolean {
  return isStudioVisualOnlyNodeKind(node.kind) && node.kind === "studio.label";
}

export function isStudioExpandedTextNodeKind(kind: string): boolean {
  const normalizedKind = String(kind || "").trim();
  return (
    normalizedKind === "studio.image_generation" ||
    normalizedKind === "studio.text" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription"
  );
}

export function resolveStudioLabelWidth(node: Pick<StudioNodeInstance, "kind" | "config">): number {
  if (!isStudioLabelNode(node)) {
    return STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
  }
  const configured = readFiniteNumber((node.config as Record<string, unknown>)?.width);
  if (configured === null) {
    return STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
  }
  return clamp(configured, STUDIO_GRAPH_LABEL_MIN_WIDTH, STUDIO_GRAPH_LABEL_MAX_WIDTH);
}

export function resolveStudioLabelHeight(node: Pick<StudioNodeInstance, "kind" | "config">): number {
  if (!isStudioLabelNode(node)) {
    return STUDIO_GRAPH_DEFAULT_NODE_HEIGHT;
  }
  const configured = readFiniteNumber((node.config as Record<string, unknown>)?.height);
  if (configured === null) {
    return STUDIO_GRAPH_LABEL_MIN_HEIGHT + 50;
  }
  return clamp(configured, STUDIO_GRAPH_LABEL_MIN_HEIGHT, STUDIO_GRAPH_LABEL_MAX_HEIGHT);
}

export function resolveStudioLabelFontSize(node: Pick<StudioNodeInstance, "kind" | "config">): number {
  if (!isStudioLabelNode(node)) {
    return STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE;
  }
  const configured = readFiniteNumber((node.config as Record<string, unknown>)?.fontSize);
  if (configured === null) {
    return STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE;
  }
  return clamp(configured, STUDIO_GRAPH_LABEL_MIN_FONT_SIZE, STUDIO_GRAPH_LABEL_MAX_FONT_SIZE);
}

export function resolveStudioGraphNodeWidth(node: Pick<StudioNodeInstance, "kind" | "config">): number {
  if (isStudioLabelNode(node)) {
    return resolveStudioLabelWidth(node);
  }
  if (isStudioExpandedTextNodeKind(node.kind)) {
    return STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH;
  }
  return STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
}

export function resolveStudioGraphNodeMinHeight(node: Pick<StudioNodeInstance, "kind">): number {
  if (isStudioExpandedTextNodeKind(node.kind)) {
    return STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT;
  }
  return 0;
}
