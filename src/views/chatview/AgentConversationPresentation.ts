import type {
  AgentConversationSnapshot,
  ManagedAgentError,
  AgentPart,
  AgentToolPart,
} from "../../chat/ChatConversation";
import { isPlanAccessError } from "../../utils/errors";

const INTERRUPTED_ERROR_CODE =
  /(?:connection|socket|stream|resume|recover|interrupt|transport)/i;
const INTERRUPTED_UI_WORDING =
  /\b(?:agent connection|connection (?:closed|lost)|websocket|web socket|socket|transport)\b/i;
const NOT_STARTED_ERROR =
  /(?:bootstrap|context|admission|license|rate_limit|response_start)|\bbootstrap\b/i;

export type PresentedAgentError = Readonly<{
  heading: string;
  message: string;
  action?: "see-plans" | "add-credits" | "detect" | "sign-in" | "use-hosted";
  details?: string;
  /** Local report id, or a legacy server incident id while capture settles. */
  reportId?: string;
}>;

const LOCAL_REPORT_ID = /^report_(?!0{32}$)[a-f0-9]{32}$/;
const SERVER_INCIDENT_ID = /^incident_(?!0{32}$)[a-f0-9]{32}$/;

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
  showPlanOffer = false,
): PresentedAgentError {
  const nativeAgent = /^local_(claude|codex)_/.exec(error.code)?.[1];
  if (nativeAgent) {
    const name = nativeAgent === "claude" ? "Claude Code" : "Codex";
    if (error.code === `local_${nativeAgent}_usage_limit`) {
      return { heading: `${name} usage limit reached`, message: error.message, action: "use-hosted" };
    }
    const login = nativeAgent === "claude"
      ? "Open a terminal, run `claude` and type /login. Then send your message again."
      : "Open a terminal and run `codex login`. Then send your message again.";
    if (/not installed|not on PATH|executable.*not found|ENOENT/i.test(error.message)) {
      return {
        heading: `${name} isn't installed on this computer`,
        message: nativeAgent === "claude"
          ? "Install Claude Code, then run `claude` in a terminal and type /login. Then choose Detect again."
          : "Install Codex, then run `codex login` in a terminal. Then choose Detect again.",
        action: "detect",
      };
    }
    if (/not (?:signed|logged) in|authentication[_ ]failed|requires? (?:authentication|login)|please (?:sign|log) in/i.test(error.message)) {
      return { heading: `${name} isn't signed in`, message: login, action: "sign-in" };
    }
    return {
      heading: `${name} stopped before finishing`,
      message: `Retry this message. If it keeps failing, run \`${nativeAgent}\` in a terminal to check it works.`,
      details: error.message,
    };
  }
  if (showPlanOffer && ["out_of_credits", "insufficient_credits", "payment_required"].includes(error.code)) {
    return {
      heading: "Out of credits",
      message: "Monthly is $9 and includes 10,000 credits every month. You can also add a credit pack.",
      action: "see-plans",
    };
  }
  if (error.code === "out_of_credits") {
    return {
      heading: "Out of credits",
      message: "You have no credits left. Add credits to continue using Chat.",
      action: "add-credits",
    };
  }
  if (error.code === "insufficient_credits" || error.code === "payment_required") {
    return {
      heading: "Not enough credits",
      message: "Not enough credits are available. Add credits to continue using Chat.",
      action: showPlanOffer ? "see-plans" : "add-credits",
    };
  }
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
  // A valid incident id lets the user copy the local content-free report.
  // Keep it available even when retrying may recover the interrupted turn.
  const reportId = error.reportId && LOCAL_REPORT_ID.test(error.reportId)
    ? error.reportId
    : error.incidentId && SERVER_INCIDENT_ID.test(error.incidentId)
      ? error.incidentId
      : undefined;
  return {
    heading: interrupted ? "Response interrupted" : "Could not finish",
    message: presentAgentErrorMessage(error.message, interrupted),
    ...(isPlanAccessError(error) ? { action: "see-plans" as const } : {}),
    ...(reportId ? { reportId } : {}),
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
  /** Whether parts can show live progress; approval waits suppress the tail separately. */
  progressActive: boolean;
  visibleParts: readonly AgentPart[];
  activityStatus: string;
}>;

const ACTIVE_TOOL_STATES = new Set<AgentToolPart["state"]>([
  "input-streaming",
  "input-ready",
  "approved",
  "running",
]);

export function isActiveAgentToolState(state: AgentToolPart["state"]): boolean {
  return ACTIVE_TOOL_STATES.has(state);
}

function phaseFor(snapshot: AgentConversationSnapshot | null, requestPending: boolean): AgentPresentationPhase {
  if (!snapshot) return requestPending ? "submitting" : "idle";
  if (snapshot.status === "idle") return "idle";
  if (snapshot.status === "completed") return "completed";
  if (snapshot.status === "cancelled") return "cancelled";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.parts.some((part) =>
    part.kind === "tool"
    && (part.location === "vault" || part.native)
    && part.state === "approval-required")) {
    return "awaiting-approval";
  }
  if (snapshot.phase === "retrying") return "recovering";
  if (snapshot.phase === "settling") return "settling";
  if (snapshot.parts.some((part) =>
    part.kind === "tool" && isActiveAgentToolState(part.state))) {
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
  if (phase === "idle") return "Idle";
  if (phase === "completed") return "Done";
  if (phase === "cancelled") return "Stopped";
  if (phase === "failed") return "Failed";
  if (phase === "awaiting-approval") {
    return snapshot?.parts.some((part) => part.kind === "tool"
      && part.state === "approval-required"
      && (part.name === "AskUserQuestion" || part.native?.requestMethod?.endsWith("/requestUserInput")))
      ? "Waiting for your answer"
      : "Waiting for your approval";
  }
  // Recovery outranks stale tool activity without inventing a tool outcome.
  if (snapshot?.statusLabel === "Connection interrupted") return "Reconnecting";
  if (phase === "recovering") return "Continuing";
  const activeTools = snapshot?.parts.filter((part): part is AgentToolPart =>
    part.kind === "tool" && isActiveAgentToolState(part.state)) ?? [];
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
      return "Thinking";
    case "responding":
      return "Writing";
    case "submitting":
      return "Connecting…";
    case "settling":
      return "Finishing";
    default:
      return "Thinking";
  }
}

/**
 * The only projection from transport lifecycle into chat presentation.
 * Idle and terminal snapshots override the outer pending promise. Recovery
 * keeps the run stoppable, but frozen parts must not imply live progress.
 */
export function presentAgentConversation(
  snapshot: AgentConversationSnapshot | null,
  requestPending: boolean,
): AgentConversationPresentation {
  const phase = phaseFor(snapshot, requestPending);
  const busy = snapshot
    ? snapshot.status === "running" || snapshot.status === "waiting"
    : requestPending;
  const meaningfulParts = snapshot?.parts ?? [];
  return Object.freeze({
    phase,
    busy,
    composerRunning: busy,
    progressActive: busy && snapshot?.phase !== "retrying",
    visibleParts: meaningfulParts,
    activityStatus: activityStatus(snapshot, phase),
  });
}
