import type { AgentRunFailureCaptureEvent } from "../../core/diagnostics/AgentIncidentCapture";
import {
  normalizeAgentIncidentFailureCode,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
} from "../../core/diagnostics/AgentIncidentSchema";
import {
  isThinAgentConversationId, isThinAgentRequestId,
  isThinAgentServerRunId, isThinAgentIncidentId,
} from "../../utils/ThinAgentLifecycleSchema";
import type { AgentConversationSnapshot, AgentRunPhase } from "../ChatConversation";
import type { AgentConnectionState } from "./AuthoritativeSession";

const MAX_INCIDENT_CAPTURE_COUNT = 100_000_000;
const MAX_INCIDENT_CAPTURE_ELAPSED_MS = 7 * 24 * 60 * 60 * 1_000;

const MAX_TOOL_EXECUTIONS_PER_RUN = 512;

type IncidentSnapshotCounts = Readonly<{
  assistantTextPartCount: number;
  assistantTextStreamingPartCount: number;
  assistantTextCompletePartCount: number;
  assistantTextCharacterCount: number;
  reasoningPartCount: number;
  reasoningStreamingPartCount: number;
  reasoningCompletePartCount: number;
  reasoningCharacterCount: number;
  assistantOutputPresentBeforeFailure: boolean;
  assistantOutputRetainedInFailedProjection: boolean;
  snapshotPartCount: number;
  truncated: boolean;
}>;

export type IncidentFailureScalars = Readonly<{
  failureAuthority: "server" | "client";
  failureStage: AgentIncidentFailureStage;
  failureMechanism: AgentIncidentFailureMechanism;
  terminalValidation: "validated" | "unvalidated";
  terminalSource: AgentRunFailureCaptureEvent["terminalSource"];
  retryable: boolean;
  runPhase?: AgentRunPhase;
  serverRunId?: string;
  incidentId?: string;
  failureCode?: string;
}>;

function addIncidentCount(
  current: number,
  addition: number,
): Readonly<{ value: number; truncated: boolean }> {
  if (
    !Number.isSafeInteger(addition)
    || addition < 0
    || current > MAX_INCIDENT_CAPTURE_COUNT - addition
  ) {
    return { value: MAX_INCIDENT_CAPTURE_COUNT, truncated: true };
  }
  return { value: current + addition, truncated: false };
}

function incidentSnapshotCounts(
  snapshot: AgentConversationSnapshot,
): IncidentSnapshotCounts {
  let assistantTextPartCount = 0;
  let assistantTextStreamingPartCount = 0;
  let assistantTextCompletePartCount = 0;
  let assistantTextCharacterCount = 0;
  let reasoningPartCount = 0;
  let reasoningStreamingPartCount = 0;
  let reasoningCompletePartCount = 0;
  let reasoningCharacterCount = 0;
  let assistantOutputPresentBeforeFailure = false;
  let truncated = snapshot.parts.length > MAX_INCIDENT_CAPTURE_COUNT;
  for (const part of snapshot.parts) {
    if (part.kind === "text") {
      const parts = addIncidentCount(assistantTextPartCount, 1);
      const streamingParts = part.state === "streaming"
        ? addIncidentCount(assistantTextStreamingPartCount, 1)
        : { value: assistantTextStreamingPartCount, truncated: false };
      const completeParts = part.state === "complete"
        ? addIncidentCount(assistantTextCompletePartCount, 1)
        : { value: assistantTextCompletePartCount, truncated: false };
      const characters = addIncidentCount(
        assistantTextCharacterCount,
        part.markdown.length,
      );
      assistantTextPartCount = parts.value;
      assistantTextStreamingPartCount = streamingParts.value;
      assistantTextCompletePartCount = completeParts.value;
      assistantTextCharacterCount = characters.value;
      assistantOutputPresentBeforeFailure = assistantOutputPresentBeforeFailure
        || (Number.isSafeInteger(part.markdown.length) && part.markdown.length > 0);
      truncated = truncated
        || parts.truncated
        || streamingParts.truncated
        || completeParts.truncated
        || characters.truncated;
    } else if (part.kind === "reasoning") {
      const parts = addIncidentCount(reasoningPartCount, 1);
      const streamingParts = part.state === "streaming"
        ? addIncidentCount(reasoningStreamingPartCount, 1)
        : { value: reasoningStreamingPartCount, truncated: false };
      const completeParts = part.state === "complete"
        ? addIncidentCount(reasoningCompletePartCount, 1)
        : { value: reasoningCompletePartCount, truncated: false };
      const characters = addIncidentCount(
        reasoningCharacterCount,
        part.summary.length,
      );
      reasoningPartCount = parts.value;
      reasoningStreamingPartCount = streamingParts.value;
      reasoningCompletePartCount = completeParts.value;
      reasoningCharacterCount = characters.value;
      truncated = truncated
        || parts.truncated
        || streamingParts.truncated
        || completeParts.truncated
        || characters.truncated;
    }
  }
  return {
    assistantTextPartCount,
    assistantTextStreamingPartCount,
    assistantTextCompletePartCount,
    assistantTextCharacterCount,
    reasoningPartCount,
    reasoningStreamingPartCount,
    reasoningCompletePartCount,
    reasoningCharacterCount,
    assistantOutputPresentBeforeFailure,
    assistantOutputRetainedInFailedProjection:
      snapshot.status === "failed" && assistantOutputPresentBeforeFailure,
    snapshotPartCount: Math.min(
      snapshot.parts.length,
      MAX_INCIDENT_CAPTURE_COUNT,
    ),
    truncated,
  };
}

function boundedIncidentPendingCount(
  value: number,
): Readonly<{ value: number; truncated: boolean }> {
  return value > MAX_TOOL_EXECUTIONS_PER_RUN
    ? { value: MAX_TOOL_EXECUTIONS_PER_RUN, truncated: true }
    : { value, truncated: false };
}

export function boundedIncidentElapsedMs(
  value: number | null,
): Readonly<{ value?: number; truncated: boolean }> {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return { truncated: false };
  }
  if (value > MAX_INCIDENT_CAPTURE_ELAPSED_MS) {
    return { value: MAX_INCIDENT_CAPTURE_ELAPSED_MS, truncated: true };
  }
  return { value: Math.round(value), truncated: false };
}

type RunFailureEvidence = Readonly<{
  conversationId: string;
  requestId: string;
  origin: "submitted" | "recovered";
  phase: AgentRunPhase;
  elapsedMs: number | null;
  executingLocalToolCount: number;
  pendingToolTaskCount: number;
  serverQueued: boolean;
}>;

type SessionFailureEvidence = Readonly<{
  connectionState: AgentConnectionState;
  runStalled: boolean;
  awaitingClientWork: boolean;
  pendingCancel: boolean;
  pendingToolDeliveryCount: number;
  pendingApprovalDeliveryCount: number;
}>;

export function captureFailedRun(
  active: RunFailureEvidence,
  snapshot: AgentConversationSnapshot,
  failure: IncidentFailureScalars,
  state: SessionFailureEvidence,
  callback: ((event: AgentRunFailureCaptureEvent) => void) | undefined,
): void {
  try {
    if (
      !callback
      || !isThinAgentConversationId(active.conversationId)
      || !isThinAgentRequestId(active.requestId)
    ) return;
    const content = incidentSnapshotCounts(snapshot);
    const executingLocalTools = boundedIncidentPendingCount(
      active.executingLocalToolCount,
    );
    const pendingToolDeliveries = boundedIncidentPendingCount(
      state.pendingToolDeliveryCount,
    );
    const pendingApprovalDeliveries = boundedIncidentPendingCount(
      state.pendingApprovalDeliveryCount,
    );
    const pendingToolTasks = boundedIncidentPendingCount(
      active.pendingToolTaskCount,
    );
    const elapsed = boundedIncidentElapsedMs(active.elapsedMs);
    const serverRunId = isThinAgentServerRunId(failure.serverRunId)
      ? failure.serverRunId
      : undefined;
    const incidentId = isThinAgentIncidentId(failure.incidentId)
      ? failure.incidentId
      : undefined;
    const failureCode = normalizeAgentIncidentFailureCode(
      failure.failureCode,
      failure.failureAuthority,
    );
    const capture = Object.freeze({
      kind: "agent_run_failed",
      conversationId: active.conversationId,
      requestId: active.requestId,
      failureAuthority: failure.failureAuthority,
      failureStage: failure.failureStage,
      failureMechanism: failure.failureMechanism,
      terminalValidation: failure.terminalValidation,
      terminalSource: failure.terminalSource,
      hostProcessState: "responsive",
      chatViewState: "unknown",
      runOrigin: active.origin,
      runPhase: failure.runPhase ?? active.phase,
      connectionState: state.connectionState,
      ...(elapsed.value === undefined ? {} : { elapsedMs: elapsed.value }),
      elapsedMsTruncated: elapsed.truncated,
      ...(serverRunId ? { serverRunId } : {}),
      ...(incidentId ? { incidentId } : {}),
      ...(failureCode ? { failureCode } : {}),
      retryable: failure.retryable,
      assistantTextPartCount: content.assistantTextPartCount,
      assistantTextStreamingPartCount: content.assistantTextStreamingPartCount,
      assistantTextCompletePartCount: content.assistantTextCompletePartCount,
      assistantTextCharacterCount: content.assistantTextCharacterCount,
      reasoningPartCount: content.reasoningPartCount,
      reasoningStreamingPartCount: content.reasoningStreamingPartCount,
      reasoningCompletePartCount: content.reasoningCompletePartCount,
      reasoningCharacterCount: content.reasoningCharacterCount,
      assistantOutputPresentBeforeFailure:
        content.assistantOutputPresentBeforeFailure,
      assistantOutputRetainedInFailedProjection:
        content.assistantOutputRetainedInFailedProjection,
      snapshotPartCount: content.snapshotPartCount,
      executingLocalToolCount: executingLocalTools.value,
      pendingToolDeliveryCount: pendingToolDeliveries.value,
      pendingApprovalDeliveryCount: pendingApprovalDeliveries.value,
      pendingToolTaskCount: pendingToolTasks.value,
      serverQueued: active.serverQueued,
      runStalled: state.runStalled,
      awaitingClientWork: state.awaitingClientWork,
      pendingCancel: state.pendingCancel,
      pendingRegenerate: false,
      countsTruncated: content.truncated
        || executingLocalTools.truncated
        || pendingToolDeliveries.truncated
        || pendingApprovalDeliveries.truncated
        || pendingToolTasks.truncated,
    });
    try {
      callback(capture);
    } catch {
      // The failed lifecycle still records even if capture projection fails.
    }
  } catch {
    // Diagnostics are observational. Capture failure cannot affect a run.
  }
}
