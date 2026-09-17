import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "../StudioGraphInteractionTypes";
import {
  normalizeStudioNodeDetailMode,
  STUDIO_NODE_DETAIL_DEFAULT_MODE,
  type StudioNodeDetailMode,
} from "./StudioGraphNodeDetailMode";

/**
 * Where the viewport's top-left corner sits, in world px, plus the zoom.
 * World coordinates are origin-independent, so the elastic canvas can grow in
 * any direction without invalidating a saved view. Older saves stored the
 * scroll offsets of a fixed canvas whose origin was (0, 0); those convert as
 * `world = scroll / zoom`.
 */
export type StudioGraphViewState = {
  x: number;
  y: number;
  zoom: number;
};

export type StudioGraphViewportState = StudioGraphViewState & {
  projectPath: string | null;
};

export type StudioGraphViewStateByProject = Record<string, StudioGraphViewState>;
export type StudioNodeDetailModeByProject = Record<string, StudioNodeDetailMode>;

const GRAPH_SCROLL_EPSILON = 0.5;
const GRAPH_ZOOM_EPSILON = 0.0001;

export function normalizeGraphZoom(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return STUDIO_GRAPH_DEFAULT_ZOOM;
  }
  return Math.min(STUDIO_GRAPH_MAX_ZOOM, Math.max(STUDIO_GRAPH_MIN_ZOOM, numeric));
}

/** Scroll-box px: never negative. */
export function normalizeGraphCoordinate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, numeric);
}

/** World px: any finite number; the canvas has no corner. */
export function normalizeWorldCoordinate(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeGraphViewState(raw: unknown): StudioGraphViewState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<StudioGraphViewState> & { scrollLeft?: unknown; scrollTop?: unknown };
  const zoom = normalizeGraphZoom(candidate.zoom);
  const hasWorld = Number.isFinite(Number(candidate.x)) || Number.isFinite(Number(candidate.y));
  if (hasWorld) {
    return { x: normalizeWorldCoordinate(candidate.x), y: normalizeWorldCoordinate(candidate.y), zoom };
  }
  return {
    x: normalizeGraphCoordinate(candidate.scrollLeft) / zoom,
    y: normalizeGraphCoordinate(candidate.scrollTop) / zoom,
    zoom,
  };
}

export function parseGraphViewStateByProject(raw: unknown): StudioGraphViewStateByProject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const parsed: StudioGraphViewStateByProject = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) {
      continue;
    }
    const normalizedState = normalizeGraphViewState(value);
    if (!normalizedState) {
      continue;
    }
    parsed[normalizedPath] = normalizedState;
  }
  return parsed;
}

export function serializeGraphViewStateByProject(
  graphViewStateByProjectPath: StudioGraphViewStateByProject
): StudioGraphViewStateByProject {
  const serialized: StudioGraphViewStateByProject = {};
  for (const [path, viewState] of Object.entries(graphViewStateByProjectPath)) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) {
      continue;
    }
    const normalizedViewState = normalizeGraphViewState(viewState);
    if (!normalizedViewState) {
      continue;
    }
    serialized[normalizedPath] = normalizedViewState;
  }
  return serialized;
}

export function upsertGraphViewStateForProject(
  graphViewStateByProjectPath: StudioGraphViewStateByProject,
  projectPath: string,
  nextViewState: StudioGraphViewState
): {
  changed: boolean;
  nextStateByProjectPath: StudioGraphViewStateByProject;
} {
  const previous = graphViewStateByProjectPath[projectPath];
  const isUnchanged = Boolean(
    previous &&
    Math.abs(previous.x - nextViewState.x) < GRAPH_SCROLL_EPSILON &&
    Math.abs(previous.y - nextViewState.y) < GRAPH_SCROLL_EPSILON &&
    Math.abs(previous.zoom - nextViewState.zoom) < GRAPH_ZOOM_EPSILON
  );
  if (isUnchanged) {
    return {
      changed: false,
      nextStateByProjectPath: graphViewStateByProjectPath,
    };
  }
  return {
    changed: true,
    nextStateByProjectPath: {
      ...graphViewStateByProjectPath,
      [projectPath]: { ...nextViewState },
    },
  };
}

export function getSavedGraphViewState(
  graphViewStateByProjectPath: StudioGraphViewStateByProject,
  projectPath: string | null
): StudioGraphViewState | null {
  const normalizedPath = String(projectPath || "").trim();
  if (!normalizedPath) {
    return null;
  }
  const existing = graphViewStateByProjectPath[normalizedPath];
  return normalizeGraphViewState(existing);
}

export function parseNodeDetailModeByProject(raw: unknown): StudioNodeDetailModeByProject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const parsed: StudioNodeDetailModeByProject = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) {
      continue;
    }
    parsed[normalizedPath] = normalizeStudioNodeDetailMode(value);
  }
  return parsed;
}

export function serializeNodeDetailModeByProject(
  nodeDetailModeByProject: StudioNodeDetailModeByProject
): StudioNodeDetailModeByProject {
  const serialized: StudioNodeDetailModeByProject = {};
  for (const [path, mode] of Object.entries(nodeDetailModeByProject)) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) {
      continue;
    }
    serialized[normalizedPath] = normalizeStudioNodeDetailMode(mode);
  }
  return serialized;
}

export function getSavedNodeDetailMode(
  nodeDetailModeByProject: StudioNodeDetailModeByProject,
  projectPath: string | null
): StudioNodeDetailMode {
  const normalizedPath = String(projectPath || "").trim();
  if (!normalizedPath) {
    return STUDIO_NODE_DETAIL_DEFAULT_MODE;
  }
  return normalizeStudioNodeDetailMode(nodeDetailModeByProject[normalizedPath]);
}
