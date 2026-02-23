import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "../StudioGraphInteractionTypes";

export type StudioGraphViewState = {
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
};

export type StudioGraphViewportState = StudioGraphViewState & {
  projectPath: string | null;
};

export type StudioGraphViewStateByProject = Record<string, StudioGraphViewState>;

const GRAPH_SCROLL_EPSILON = 0.5;
const GRAPH_ZOOM_EPSILON = 0.0001;

export function normalizeGraphZoom(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return STUDIO_GRAPH_DEFAULT_ZOOM;
  }
  return Math.min(STUDIO_GRAPH_MAX_ZOOM, Math.max(STUDIO_GRAPH_MIN_ZOOM, numeric));
}

export function normalizeGraphCoordinate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, numeric);
}

function normalizeGraphViewState(raw: unknown): StudioGraphViewState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<StudioGraphViewState>;
  return {
    scrollLeft: normalizeGraphCoordinate(candidate.scrollLeft),
    scrollTop: normalizeGraphCoordinate(candidate.scrollTop),
    zoom: normalizeGraphZoom(candidate.zoom),
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
    Math.abs(previous.scrollLeft - nextViewState.scrollLeft) < GRAPH_SCROLL_EPSILON &&
    Math.abs(previous.scrollTop - nextViewState.scrollTop) < GRAPH_SCROLL_EPSILON &&
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
