import type {
  AgentConversationSnapshot,
  AgentPart,
  AgentRunStatus,
  AgentToolPart,
} from "./AgentConversation";

export type AgentPresentationPhase =
  | "idle"
  | "submitting"
  | "reasoning"
  | "acting"
  | "awaiting-approval"
  | "responding"
  | "settling"
  | "recovering"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentConversationPresentation = Readonly<{
  phase: AgentPresentationPhase;
  busy: boolean;
  composerRunning: boolean;
  visibleParts: readonly AgentPart[];
  activityStatus: string;
}>;

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "cancelled", "failed"]);
const ACTIVE_TOOL_STATES = new Set<AgentToolPart["state"]>([
  "input-streaming",
  "input-ready",
  "approved",
  "running",
]);

function phaseFor(snapshot: AgentConversationSnapshot | null, requestPending: boolean): AgentPresentationPhase {
  if (!snapshot) return requestPending ? "submitting" : "idle";
  if (snapshot.status === "completed") return "completed";
  if (snapshot.status === "cancelled") return "cancelled";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.phase === "retrying") return "recovering";
  if (snapshot.parts.some((part) => part.kind === "tool" && part.state === "approval-required")) {
    return "awaiting-approval";
  }
  if (snapshot.parts.some((part) => part.kind === "tool" && ACTIVE_TOOL_STATES.has(part.state))) {
    return "acting";
  }
  if (snapshot.parts.some((part) => part.kind === "text" && part.state === "streaming")) {
    return "responding";
  }
  if (snapshot.parts.some((part) => part.kind === "reasoning" && part.state === "streaming")) {
    return "reasoning";
  }
  if (snapshot.phase === "settling") return "settling";
  if (snapshot.phase === "submitted" || snapshot.phase === "thinking") return "submitting";
  if (snapshot.phase === "working" || snapshot.phase === "waiting") return "acting";
  return requestPending ? "settling" : "responding";
}

function activityStatus(phase: AgentPresentationPhase): string {
  switch (phase) {
    case "reasoning":
      return "Thinking";
    case "acting":
    case "responding":
      return "Working";
    case "awaiting-approval":
      return "Needs approval";
    case "recovering":
      return "Recovering";
    case "settling":
      return "Finishing";
    case "completed":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return "Starting";
  }
}

/**
 * The only projection from transport lifecycle into chat presentation.
 * Terminal snapshots deliberately override the outer pending promise so the
 * composer and live indicators stop at the protocol boundary, not later.
 */
export function presentAgentConversation(
  snapshot: AgentConversationSnapshot | null,
  requestPending: boolean,
): AgentConversationPresentation {
  const phase = phaseFor(snapshot, requestPending);
  const busy = snapshot
    ? !TERMINAL_STATUSES.has(snapshot.status)
    : requestPending;
  const parts = snapshot?.parts ?? [];
  const meaningfulParts = parts.filter((part) => part.kind !== "status");
  const statusParts = parts.filter((part) => part.kind === "status");
  const visibleParts = snapshot?.status === "cancelled"
    ? [...meaningfulParts, ...statusParts]
    : meaningfulParts.length > 0
      ? meaningfulParts
      : statusParts;
  return Object.freeze({
    phase,
    busy,
    composerRunning: busy,
    visibleParts,
    activityStatus: activityStatus(phase),
  });
}
