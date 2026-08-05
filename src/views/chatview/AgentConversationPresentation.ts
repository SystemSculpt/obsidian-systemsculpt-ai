import type {
  AgentConversationSnapshot,
  ManagedAgentError,
  AgentPart,
  AgentRunStatus,
  AgentToolPart,
} from "./AgentConversation";

const INTERRUPTED_ERROR_CODE =
  /(?:connection|socket|stream|resume|recover|interrupt|transport)/i;
const INTERRUPTED_UI_WORDING =
  /\b(?:agent connection|connection (?:closed|lost)|websocket|web socket|socket|transport)\b/i;
const NOT_STARTED_ERROR =
  /(?:bootstrap|context|admission|license|rate_limit)|\bbootstrap\b/i;

export type PresentedAgentError = Readonly<{
  heading: "Response interrupted" | "Could not finish";
  message: string;
}>;

export function presentAgentErrorMessage(
  _message: string,
  interrupted: boolean,
): string {
  // Service messages are not a product copy contract. Keep implementation,
  // transport, and upstream identities behind the first-party boundary.
  return interrupted
    ? "Retry this message to continue."
    : "SystemSculpt could not complete the response.";
}

/** Final defense before service failures become visible product copy. */
export function presentAgentError(
  error: ManagedAgentError,
  retryable: boolean,
): PresentedAgentError {
  if (error.code === "content_filter") {
    return {
      heading: "Could not finish",
      message: "The safety filter stopped this response. Change the request and try again.",
    };
  }
  const interrupted = retryable
    && !NOT_STARTED_ERROR.test(`${error.code} ${error.message}`)
    && (
    INTERRUPTED_ERROR_CODE.test(error.code)
    || INTERRUPTED_UI_WORDING.test(error.message)
  );
  return {
    heading: interrupted ? "Response interrupted" : "Could not finish",
    message: presentAgentErrorMessage(error.message, interrupted),
  };
}

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
  if (snapshot.phase === "settling") return "settling";
  if (snapshot.parts.some((part) =>
    part.kind === "tool"
    && part.location === "vault"
    && part.state === "approval-required")) {
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
  if (snapshot.phase === "submitted" || snapshot.phase === "thinking") return "submitting";
  if (snapshot.phase === "working" || snapshot.phase === "waiting") return "acting";
  return requestPending ? "settling" : "responding";
}

function activityStatus(
  snapshot: AgentConversationSnapshot | null,
  phase: AgentPresentationPhase,
): string {
  // Terminal truth wins even when the final journal retains an in-flight tool
  // record. Otherwise a failed search can present a completed checkmark beside
  // "Searching", making two lifecycle presenters contradict each other.
  if (phase === "completed") return "Done";
  if (phase === "cancelled") return "Stopped";
  if (phase === "failed") return "Failed";
  // A sustained outage outranks stale tool activity: the frozen tool states
  // below describe the last frames before the connection dropped, not what is
  // happening now.
  if (snapshot?.statusLabel === "Connection interrupted") return "Reconnecting";
  const activeTools = snapshot?.parts.filter((part): part is AgentToolPart =>
    part.kind === "tool" && ACTIVE_TOOL_STATES.has(part.state)) ?? [];
  if (phase === "awaiting-approval") return "Needs approval";
  if (activeTools.some((part) =>
    part.location === "server" && part.name === "web_search")) {
    return "Searching";
  }
  if (activeTools.some((part) => part.location === "vault")) {
    return "Working in vault";
  }
  if (snapshot?.statusLabel === "Reconnecting") return "Continuing";
  if (snapshot?.statusLabel === "Continuing"
    || snapshot?.statusLabel === "Recovering") {
    return "Continuing";
  }
  switch (phase) {
    case "reasoning":
    case "acting":
    case "responding":
    case "submitting":
      return "Thinking";
    case "recovering":
      return "Continuing";
    case "settling":
      return "Finishing";
    default:
      return "Thinking";
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
  const meaningfulParts = snapshot?.parts ?? [];
  return Object.freeze({
    phase,
    busy,
    composerRunning: busy,
    visibleParts: meaningfulParts,
    activityStatus: activityStatus(snapshot, phase),
  });
}
