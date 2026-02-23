import type { StudioNodeOutputMap, StudioRunEvent } from "../../studio/types";

export type StudioNodeRunStatus = "idle" | "pending" | "running" | "cached" | "succeeded" | "failed";
export type StudioRunLifecycleStatus = "idle" | "running" | "success" | "failed";

type InternalNodeRunState = {
  status: StudioNodeRunStatus;
  message: string;
  updatedAt: string | null;
  outputs: StudioNodeOutputMap | null;
  completeCounted: boolean;
};

export type StudioNodeRunDisplayState = {
  status: StudioNodeRunStatus;
  message: string;
  updatedAt: string | null;
  outputs: StudioNodeOutputMap | null;
};

export type StudioRunProgressDisplayState = {
  status: StudioRunLifecycleStatus;
  runId: string | null;
  total: number;
  completed: number;
  percent: number;
  fromNodeId: string | null;
  message: string;
};

function createInternalNodeState(overrides?: Partial<InternalNodeRunState>): InternalNodeRunState {
  return {
    status: "idle",
    message: "",
    updatedAt: null,
    outputs: null,
    completeCounted: false,
    ...overrides,
  };
}

function toDisplayState(state: InternalNodeRunState): StudioNodeRunDisplayState {
  return {
    status: state.status,
    message: state.message,
    updatedAt: state.updatedAt,
    outputs: state.outputs,
  };
}

function isTerminalStatus(status: StudioNodeRunStatus): boolean {
  return status === "cached" || status === "succeeded" || status === "failed";
}

function valuePreview(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
  } catch {
    return "[complex]";
  }
}

export function formatNodeOutputPreview(outputs: StudioNodeOutputMap | null): string {
  if (!outputs) {
    return "";
  }
  const keys = Object.keys(outputs);
  if (keys.length === 0) {
    return "";
  }
  if (typeof outputs.path === "string" && outputs.path.trim().length > 0) {
    return `path: ${outputs.path}`;
  }
  if (typeof outputs.text === "string" && outputs.text.trim().length > 0) {
    const text = outputs.text.trim();
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }
  const firstKey = keys[0];
  return `${firstKey}: ${valuePreview(outputs[firstKey])}`;
}

export function statusLabelForNode(status: StudioNodeRunStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "cached":
      return "Cached";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

export class StudioRunPresentationState {
  private nodeStates = new Map<string, InternalNodeRunState>();
  private progress: StudioRunProgressDisplayState = {
    status: "idle",
    runId: null,
    total: 0,
    completed: 0,
    percent: 0,
    fromNodeId: null,
    message: "",
  };

  reset(): void {
    this.nodeStates.clear();
    this.progress = {
      status: "idle",
      runId: null,
      total: 0,
      completed: 0,
      percent: 0,
      fromNodeId: null,
      message: "",
    };
  }

  removeNode(nodeId: string): void {
    this.nodeStates.delete(nodeId);
  }

  hydrateFromCache(
    entries: Record<string, { outputs: StudioNodeOutputMap; updatedAt?: string }> | null,
    options?: { allowedNodeIds?: string[] }
  ): void {
    if (!entries || typeof entries !== "object") {
      return;
    }

    const allowedNodeIds = Array.isArray(options?.allowedNodeIds)
      ? new Set(options!.allowedNodeIds.map((nodeId) => String(nodeId || "").trim()).filter(Boolean))
      : null;

    for (const [nodeIdRaw, entry] of Object.entries(entries)) {
      const nodeId = String(nodeIdRaw || "").trim();
      if (!nodeId) {
        continue;
      }
      if (allowedNodeIds && !allowedNodeIds.has(nodeId)) {
        continue;
      }
      if (!entry || typeof entry !== "object" || !entry.outputs || typeof entry.outputs !== "object") {
        continue;
      }
      const outputs = entry.outputs;
      if (Object.keys(outputs).length === 0) {
        continue;
      }
      this.setNodeState(nodeId, {
        status: "cached",
        message: "Cache ready",
        updatedAt: String(entry.updatedAt || "").trim() || null,
        outputs,
        completeCounted: true,
      });
    }
  }

  beginRun(nodeIds: string[], options?: { fromNodeId?: string | null }): void {
    const scopedIds = Array.from(new Set(nodeIds.map((nodeId) => String(nodeId || "").trim()).filter(Boolean)));
    for (const nodeId of scopedIds) {
      const existing = this.nodeStates.get(nodeId) || createInternalNodeState();
      this.nodeStates.set(
        nodeId,
        createInternalNodeState({
          ...existing,
          status: "pending",
          message: "",
          updatedAt: null,
          completeCounted: false,
        })
      );
    }
    this.progress = {
      status: "running",
      runId: null,
      total: scopedIds.length,
      completed: 0,
      percent: 0,
      fromNodeId: String(options?.fromNodeId || "").trim() || null,
      message: scopedIds.length > 0 ? "Preparing run..." : "",
    };
  }

  failBeforeRun(errorMessage: string): void {
    this.progress = {
      ...this.progress,
      status: "failed",
      message: String(errorMessage || "Run failed."),
      percent: this.progress.total > 0
        ? Math.min(100, Math.round((this.progress.completed / this.progress.total) * 100))
        : 0,
    };
  }

  applyEvent(event: StudioRunEvent): void {
    const at = event.at || null;
    if (event.type === "run.started") {
      this.progress = {
        ...this.progress,
        status: "running",
        runId: event.runId,
        message: "Running graph...",
      };
      return;
    }

    if (event.type === "run.failed") {
      this.progress = {
        ...this.progress,
        status: "failed",
        runId: event.runId,
        message: event.error || "Run failed.",
      };
      return;
    }

    if (event.type === "run.completed") {
      this.progress = {
        ...this.progress,
        runId: event.runId,
        status: event.status === "success" ? "success" : "failed",
        percent: this.progress.total > 0
          ? Math.min(100, Math.round((this.progress.completed / this.progress.total) * 100))
          : 0,
        message: event.status === "success" ? "Run completed." : "Run failed.",
      };
      return;
    }

    if (event.type === "node.started") {
      this.setNodeState(event.nodeId, {
        status: "running",
        message: "",
        updatedAt: at,
      });
      this.progress = {
        ...this.progress,
        runId: event.runId,
        status: "running",
        message: "Running graph...",
      };
      return;
    }

    if (event.type === "node.cache_hit") {
      this.setNodeState(event.nodeId, {
        status: "cached",
        message: "Cache hit",
        updatedAt: at,
      });
      this.markNodeCompleted(event.nodeId);
      this.progress = {
        ...this.progress,
        runId: event.runId,
      };
      return;
    }

    if (event.type === "node.output") {
      const current = this.nodeStates.get(event.nodeId) || createInternalNodeState();
      const nextStatus =
        current.status === "cached" || current.status === "failed" ? current.status : "succeeded";
      this.setNodeState(event.nodeId, {
        status: nextStatus,
        message:
          current.status === "cached"
            ? current.message || "Cache hit"
            : current.status === "failed"
              ? current.message || "Failed"
              : "Completed",
        updatedAt: at,
        outputs: event.outputs || current.outputs,
      });
      if (nextStatus !== "failed") {
        this.markNodeCompleted(event.nodeId);
      }
      this.progress = {
        ...this.progress,
        runId: event.runId,
      };
      return;
    }

    if (event.type === "node.failed") {
      this.setNodeState(event.nodeId, {
        status: "failed",
        message: event.error || "Node failed.",
        updatedAt: at,
      });
      this.markNodeCompleted(event.nodeId);
      this.progress = {
        ...this.progress,
        runId: event.runId,
        status: "running",
        message: event.error || "Node failed.",
      };
    }
  }

  getProgress(): StudioRunProgressDisplayState {
    return { ...this.progress };
  }

  getNodeState(nodeId: string): StudioNodeRunDisplayState {
    const state = this.nodeStates.get(nodeId) || createInternalNodeState();
    return toDisplayState(state);
  }

  getNodeOutput(nodeId: string): StudioNodeOutputMap | null {
    return this.nodeStates.get(nodeId)?.outputs || null;
  }

  primeNodeOutput(
    nodeId: string,
    outputs: StudioNodeOutputMap,
    options?: { message?: string; updatedAt?: string }
  ): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId || !outputs || typeof outputs !== "object") {
      return;
    }
    this.setNodeState(normalizedNodeId, {
      status: "succeeded",
      message: String(options?.message || "Preview ready"),
      updatedAt: String(options?.updatedAt || "").trim() || new Date().toISOString(),
      outputs: { ...outputs },
      completeCounted: true,
    });
  }

  private setNodeState(nodeId: string, next: Partial<InternalNodeRunState>): void {
    const current = this.nodeStates.get(nodeId) || createInternalNodeState();
    this.nodeStates.set(nodeId, {
      ...current,
      ...next,
    });
  }

  private markNodeCompleted(nodeId: string): void {
    const current = this.nodeStates.get(nodeId) || createInternalNodeState();
    if (!isTerminalStatus(current.status)) {
      return;
    }
    if (current.completeCounted) {
      return;
    }
    current.completeCounted = true;
    this.nodeStates.set(nodeId, current);
    const nextCompleted = this.progress.completed + 1;
    const nextPercent =
      this.progress.total > 0
        ? Math.min(100, Math.round((nextCompleted / this.progress.total) * 100))
        : 0;
    this.progress = {
      ...this.progress,
      completed: nextCompleted,
      percent: nextPercent,
    };
  }
}
