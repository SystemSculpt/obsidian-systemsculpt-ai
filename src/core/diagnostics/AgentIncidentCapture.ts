import type {
  AgentIncidentFailureMechanism,
  AgentIncidentFailureStage,
} from "./AgentIncidentSchema";
import type {
  AgentIncidentCorrelationInput,
  AgentIncidentRunStateInput,
  AgentIncidentTransportSegmentInput,
} from "./AgentIncidentRecorder";

/**
 * Content-free evidence captured while a failed run still owns its state.
 *
 * This boundary intentionally exposes only purpose-specific identifiers,
 * validated enums, booleans, and bounded counts. It must never grow raw
 * messages, errors, tool identities, paths, URLs, inputs, or outputs.
 */
export type AgentRunFailureCaptureEvent = Readonly<AgentIncidentRunStateInput & {
  kind: "agent_run_failed";
  conversationId: string;
  requestId: string;
  failureAuthority: "server" | "client";
  failureStage: AgentIncidentFailureStage;
  failureMechanism: AgentIncidentFailureMechanism;
  terminalValidation: "validated" | "unvalidated";
  hostProcessState: "responsive";
  chatViewState: "unknown";
  elapsedMs?: number;
  serverRunId?: string;
  incidentId?: string;
  failureCode?: string;
  retryable: boolean;
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
}>;

/**
 * Content-free transport evidence for local incident capture.
 *
 * The conversation and request IDs are internal correlation keys. Persisted
 * reports must replace or omit them. Tool-call IDs never cross this boundary;
 * a locally established execution can contribute only its derived ordinal.
 */
export type AgentChatTransportSegmentSummaryEvent = Readonly<
  AgentIncidentCorrelationInput & AgentIncidentTransportSegmentInput
>;
