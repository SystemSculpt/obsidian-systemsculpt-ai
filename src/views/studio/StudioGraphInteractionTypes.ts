import type { StudioProjectV1 } from "../../studio/types";
import {
  STUDIO_GRAPH_CANVAS_BASE_HEIGHT,
  STUDIO_GRAPH_CANVAS_BASE_WIDTH,
} from "./graph-v3/StudioGraphCanvasBounds";

export const STUDIO_GRAPH_CANVAS_WIDTH = STUDIO_GRAPH_CANVAS_BASE_WIDTH;
export const STUDIO_GRAPH_CANVAS_HEIGHT = STUDIO_GRAPH_CANVAS_BASE_HEIGHT;
export const STUDIO_GRAPH_MIN_ZOOM = 0.25;
export const STUDIO_GRAPH_MAX_ZOOM = 2.4;
export const STUDIO_GRAPH_DEFAULT_ZOOM = 1;

export type PendingConnection = {
  fromNodeId: string;
  fromPortId: string;
};

export type ConnectionDragState = {
  pointerId: number;
  fromNodeId: string;
  fromPortId: string;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  active: boolean;
};

export type StudioGraphInteractionHost = {
  isBusy: () => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  setError: (error: unknown) => void;
  recomputeEntryNodes: (project: StudioProjectV1) => void;
  scheduleProjectSave: () => void;
  requestRender: () => void;
  onNodeDragStateChange?: (isDragging: boolean) => void;
  onGraphZoomChanged?: (zoom: number) => void;
  getPortType: (nodeId: string, direction: "in" | "out", portId: string) => string | null;
  portTypeCompatible: (sourceType: string, targetType: string) => boolean;
};
