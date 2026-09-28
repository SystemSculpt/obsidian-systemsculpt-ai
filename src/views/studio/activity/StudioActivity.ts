import type {
  StudioNodeRunDisplayState,
  StudioRunLifecycleStatus,
} from "../StudioRunPresentationState";

/**
 * The one vocabulary for "something is happening" in Studio.
 *
 * Every surface that shows execution — node cards, cables, port pins, Codex
 * run cards, workflow steps — maps its own status into these phases and
 * stamps them as `data-activity`. `src/css/views/studio/activity.css` owns
 * every visual for a phase, so a new surface inherits the same colors,
 * motion, and reduced-motion behavior by adopting the attribute.
 */
export type StudioActivityPhase =
  | "idle"
  | "queued"
  | "active"
  | "waiting"
  | "done"
  | "cached"
  | "failed"
  | "stopped";

export const STUDIO_ACTIVITY_PHASES: readonly StudioActivityPhase[] = [
  "idle",
  "queued",
  "active",
  "waiting",
  "done",
  "cached",
  "failed",
  "stopped",
];

/** Cable state derived from the node that feeds it. */
export type StudioEdgeActivityPhase = "idle" | "surging" | "delivered" | "failed";

/** Port pin state derived from the cables touching it. */
export type StudioPortActivityPhase = "emitting" | "receiving";

export type StudioNodeActivity = Readonly<{
  phase: StudioActivityPhase;
  /** Short status word shown in the badge, e.g. "Running". */
  label: string;
  /** Producer-supplied detail, e.g. the current step or the error. */
  detail: string;
  /** 0..1 while a producer reports determinate progress; null otherwise. */
  progress: number | null;
}>;

export const IDLE_NODE_ACTIVITY: StudioNodeActivity = Object.freeze({
  phase: "idle",
  label: "Idle",
  detail: "",
  progress: null,
});

const PHASE_LABELS: Record<StudioActivityPhase, string> = {
  idle: "Idle",
  queued: "Queued",
  active: "Running",
  waiting: "Waiting",
  done: "Done",
  cached: "Cached",
  failed: "Failed",
  stopped: "Stopped",
};

export function activityLabel(phase: StudioActivityPhase): string {
  return PHASE_LABELS[phase];
}

/** Phases that mean work is in flight right now. */
export function isLiveActivityPhase(phase: StudioActivityPhase): boolean {
  return phase === "active" || phase === "waiting";
}

/** Phases that end a unit of work. */
export function isSettledActivityPhase(phase: StudioActivityPhase): boolean {
  return phase === "done" || phase === "cached" || phase === "failed" || phase === "stopped";
}

/** Phases that say nothing worth a badge: the card's content already shows the result. */
export function isQuietActivityPhase(phase: StudioActivityPhase): boolean {
  return phase === "idle" || phase === "done" || phase === "cached";
}

export function createNodeActivity(
  phase: StudioActivityPhase,
  options?: { label?: string; detail?: string; progress?: number | null }
): StudioNodeActivity {
  const progress = options?.progress;
  return {
    phase,
    label: options?.label ?? activityLabel(phase),
    detail: String(options?.detail ?? "").trim(),
    progress:
      typeof progress === "number" && Number.isFinite(progress)
        ? Math.min(1, Math.max(0, progress))
        : null,
  };
}

/**
 * Graph-run presentation → activity. The run lifecycle decides what an
 * unfinished node means: while the run is live it is queued or running;
 * once the run has ended it was skipped or interrupted.
 */
export function nodeActivityFromRunState(
  state: StudioNodeRunDisplayState,
  run: StudioRunLifecycleStatus
): StudioNodeActivity {
  const message = String(state.message || "").trim();
  switch (state.status) {
    case "pending":
      // A run that ended before this node started leaves it untouched.
      return run === "running" ? createNodeActivity("queued") : IDLE_NODE_ACTIVITY;
    case "running":
      return run === "running"
        ? createNodeActivity("active", { detail: message, progress: state.progress ?? null })
        : createNodeActivity("stopped", { label: "Interrupted", detail: message });
    case "cached":
      return createNodeActivity("cached", { detail: message === "Cache hit" || message === "Cache ready" ? "" : message });
    case "succeeded":
      return createNodeActivity("done", { detail: message === "Completed" ? "" : message });
    case "failed":
      return createNodeActivity("failed", { detail: message });
    case "idle":
    default:
      return IDLE_NODE_ACTIVITY;
  }
}

export type StudioAgentRunActivitySource = Readonly<{
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "stopped" | "interrupted";
  currentActivity: string;
  error?: string;
}>;

export function activityPhaseFromAgentRunStatus(
  status: StudioAgentRunActivitySource["status"]
): StudioActivityPhase {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "active";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
    case "interrupted":
    default:
      return "stopped";
  }
}

/** Native Codex run record → activity for the role card that started it. */
export function nodeActivityFromAgentRun(run: StudioAgentRunActivitySource): StudioNodeActivity {
  const phase = activityPhaseFromAgentRunStatus(run.status);
  const detail = String(run.error || run.currentActivity || "").trim();
  return createNodeActivity(phase, {
    label: run.status === "interrupted" ? "Interrupted" : undefined,
    detail: detail === activityLabel(phase) ? "" : detail,
  });
}

export function activityPhaseFromWorkflowStepStatus(
  status: "pending" | "running" | "completed" | "blocked" | "skipped"
): StudioActivityPhase {
  switch (status) {
    case "running":
      return "active";
    case "completed":
      return "done";
    case "blocked":
      return "waiting";
    case "skipped":
      return "stopped";
    case "pending":
    default:
      return "queued";
  }
}

export function activityPhaseFromWorkflowStatus(
  status: "active" | "waiting" | "needs_input" | "completed" | "stopped"
): StudioActivityPhase {
  switch (status) {
    case "active":
      return "active";
    case "waiting":
    case "needs_input":
      return "waiting";
    case "completed":
      return "done";
    case "stopped":
    default:
      return "stopped";
  }
}

/**
 * A cable shows what its source is doing: power surges while the source
 * works, the line settles once the source has delivered into this run, and
 * it turns to the failure color when the source failed. Cached outputs that
 * were merely hydrated at open (no run yet) leave the cable quiet.
 */
export function edgeActivityFromSource(
  source: StudioActivityPhase,
  run: StudioRunLifecycleStatus
): StudioEdgeActivityPhase {
  if (isLiveActivityPhase(source)) return "surging";
  if (source === "failed") return "failed";
  if ((source === "done" || source === "cached") && run !== "idle") return "delivered";
  return "idle";
}
