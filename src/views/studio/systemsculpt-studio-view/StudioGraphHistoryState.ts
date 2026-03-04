import type { StudioProjectV1 } from "../../../studio/types";
import {
  cloneHistorySnapshot,
  cloneProjectSnapshot,
  normalizeNodeIdList,
  serializeProjectSnapshot,
  trimHistorySnapshots,
  type StudioGraphHistorySnapshot,
} from "./StudioGraphClipboardModel";

export type StudioGraphHistoryState = {
  currentSnapshot: StudioGraphHistorySnapshot | null;
  currentSerialized: string;
  undoSnapshots: StudioGraphHistorySnapshot[];
  redoSnapshots: StudioGraphHistorySnapshot[];
};

export function createStudioGraphHistoryState(): StudioGraphHistoryState {
  return {
    currentSnapshot: null,
    currentSerialized: "",
    undoSnapshots: [],
    redoSnapshots: [],
  };
}

export function setStudioGraphHistoryCurrentSnapshot(
  state: StudioGraphHistoryState,
  project: StudioProjectV1,
  selectedNodeIds: string[]
): void {
  state.currentSnapshot = {
    project: cloneProjectSnapshot(project),
    selectedNodeIds: normalizeNodeIdList(selectedNodeIds),
  };
  state.currentSerialized = serializeProjectSnapshot(project);
}

export function resetStudioGraphHistory(
  state: StudioGraphHistoryState,
  project: StudioProjectV1 | null,
  options?: { selectedNodeIds?: string[] }
): void {
  state.undoSnapshots = [];
  state.redoSnapshots = [];
  if (!project) {
    state.currentSnapshot = null;
    state.currentSerialized = "";
    return;
  }
  setStudioGraphHistoryCurrentSnapshot(state, project, options?.selectedNodeIds || []);
}

export function captureStudioGraphHistoryCheckpoint(
  state: StudioGraphHistoryState,
  project: StudioProjectV1,
  selectedNodeIds: string[],
  maxSnapshots: number
): void {
  const serialized = serializeProjectSnapshot(project);
  if (!state.currentSnapshot) {
    setStudioGraphHistoryCurrentSnapshot(state, project, selectedNodeIds);
    return;
  }
  if (serialized === state.currentSerialized) {
    return;
  }

  state.undoSnapshots.push(cloneHistorySnapshot(state.currentSnapshot));
  trimHistorySnapshots(state.undoSnapshots, maxSnapshots);
  setStudioGraphHistoryCurrentSnapshot(state, project, selectedNodeIds);
  state.redoSnapshots = [];
}

export function consumeStudioGraphUndoSnapshot(
  state: StudioGraphHistoryState,
  maxSnapshots: number
): StudioGraphHistorySnapshot | null {
  if (!state.currentSnapshot) {
    return null;
  }
  const targetSnapshot = state.undoSnapshots.pop();
  if (!targetSnapshot) {
    return null;
  }

  state.redoSnapshots.push(cloneHistorySnapshot(state.currentSnapshot));
  trimHistorySnapshots(state.redoSnapshots, maxSnapshots);
  return targetSnapshot;
}

export function consumeStudioGraphRedoSnapshot(
  state: StudioGraphHistoryState,
  maxSnapshots: number
): StudioGraphHistorySnapshot | null {
  if (!state.currentSnapshot) {
    return null;
  }
  const targetSnapshot = state.redoSnapshots.pop();
  if (!targetSnapshot) {
    return null;
  }

  state.undoSnapshots.push(cloneHistorySnapshot(state.currentSnapshot));
  trimHistorySnapshots(state.undoSnapshots, maxSnapshots);
  return targetSnapshot;
}
