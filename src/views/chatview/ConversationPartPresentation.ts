import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import type { AgentPart, AgentToolPart } from "../../chat/ChatConversation";
import { isServerExecutedManagedToolCall, readManagedToolCallFunction } from "../../chat/managed/ManagedToolExecution";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import { presentAgentError, isActiveAgentToolState, type AgentConversationPresentation } from "./AgentConversationPresentation";
import { normalizeFailedTerminalReceipt } from "./FailedTerminalReceipt";
import { presentMessageContent, type PresentedMessageContent } from "./ChatMessagePresentation";
import { presentAgentTool, presentAgentToolDetails, presentAgentToolFailure } from "./AgentToolPresentation";

export const ACTIONABLE_ARTIFACT_TOOLS = new Set(["write", "edit", "multi_edit", "move"]);

export function toolPartKey(callId: string): string {
  return `tool:${callId}`;
}

export function isNativeSourcesPart(part: MessagePart): boolean {
  if (part.type !== "content") return false;
  if (part.id.startsWith("sources:")) return true;
  const markdown = presentMessageContent(part.data).markdown.trim();
  const lines = markdown.split(/\r?\n/);
  return lines.length >= 3
    && lines[0] === "### Sources"
    && lines[1] === ""
    && lines.slice(2).every((line) =>
      /^- \[(?:\\.|[^\]])+\]\(<https?:\/\/[^<>\s]+>\)$/.test(line));
}

export function historicalPartKey(part: MessagePart): string {
  return part.type === "tool_call" ? toolPartKey(part.data.id) : part.id;
}

export type HistoricalTurnSemantics = Readonly<{
  hasVisibleContent: boolean;
  hasTools: boolean;
  isToolOnly: boolean;
  copyText: string;
}>;

export type DurableFailedReceipt = Readonly<{
  messageId: string;
  reportId?: string;
  incidentId?: string;
  failureCode: string;
  failureMessage?: string;
  retryable: boolean;
  serverRunId?: string;
}>;

export function durableFailedReceipt(message: ChatMessage): DurableFailedReceipt | null {
  if (message.role !== "assistant") return null;
  const receipt = normalizeFailedTerminalReceipt(message);
  if (!receipt) return null;
  return Object.freeze({
    messageId: message.message_id,
    reportId: receipt.terminalReportId ?? receipt.terminalIncidentId,
    ...(receipt.terminalIncidentId ? { incidentId: receipt.terminalIncidentId } : {}),
    failureCode: receipt.terminalFailureCode,
    failureMessage: receipt.terminalFailureMessage,
    retryable: receipt.terminalRetryable,
    ...(receipt.terminalServerRunId ? { serverRunId: receipt.terminalServerRunId } : {}),
  });
}

/** Plugin 6.18.0 could save a native failure for a message that never reached the agent, under the previous turn. */
export function isOrphanNativeFailure(message: ChatMessage, turnId: string | null): boolean {
  return durableFailedReceipt(message)?.failureMessage !== undefined && message.message_id !== `${turnId}_assistant`;
}

type HistoricalPartPartition = Readonly<{
  workParts: readonly MessagePart[];
  finalAnswers: readonly MessagePart[];
  hasActivity: boolean;
}>;

export function isVisibleHistoricalPart(part: MessagePart): boolean {
  if (part.type === "reasoning") return part.data.trim().length > 0;
  if (part.type === "tool_call") return true;
  const content = presentMessageContent(part.data);
  return content.markdown.trim().length > 0 || content.attachments.length > 0;
}

export function partitionHistoricalParts(
  parts: readonly MessagePart[],
  finalAnswerPartIds: ReadonlySet<string>,
): HistoricalPartPartition {
  const visibleParts = parts.filter(isVisibleHistoricalPart);
  const workParts = visibleParts.filter((part) => !finalAnswerPartIds.has(part.id));
  const finalAnswers = visibleParts.filter((part) =>
    part.type === "content" && finalAnswerPartIds.has(part.id));
  return {
    workParts,
    finalAnswers,
    hasActivity: workParts.some((part) =>
      part.type === "reasoning" || part.type === "tool_call"),
  };
}

export function classifyHistoricalTurn(
  message: ChatMessage,
  aggregateContent: PresentedMessageContent,
  orderedParts: readonly MessagePart[],
): HistoricalTurnSemantics {
  const usesOrderedParts = orderedParts.length > 0;
  const presentedContent = usesOrderedParts
    ? orderedParts
      .filter((part) => part.type === "content")
      .map((part) => presentMessageContent(part.data))
    : [aggregateContent];
  const copyText = presentedContent
    .map((content) => content.markdown)
    .filter((markdown) => markdown.trim().length > 0)
    .join("\n\n");
  const hasVisibleContent = copyText.length > 0
    || presentedContent.some((content) => content.attachments.length > 0)
    || orderedParts.some((part) => part.type === "reasoning" && part.data.trim().length > 0);
  const hasTools = message.role === "assistant"
    && orderedParts.some((part) => part.type === "tool_call");
  const isToolOnly = hasTools && !hasVisibleContent;
  return { hasVisibleContent, hasTools, isToolOnly, copyText };
}

export function toolCallForPart(part: AgentToolPart): ToolCall {
  return {
    id: part.callId,
    messageId: part.messageId,
    request: {
      id: part.callId,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      },
    },
    state: "executing",
    timestamp: Date.now(),
  };
}

function historicalToolState(tool: ToolCall, success: boolean): AgentToolPart["state"] {
  if (success) return "succeeded";

  switch (tool.result?.error?.code) {
    case "USER_DENIED":
    case "NATIVE_TOOL_DENIED":
      return "denied";
    case "TOOL_CANCELLED_BEFORE_START":
    case "NATIVE_TOOL_CANCELLED":
      return "cancelled";
    case "NATIVE_TOOL_OUTCOME_UNKNOWN":
    case "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART":
      return "outcome-unknown";
    default:
      return tool.state === "failed" || tool.result?.success === false ? "failed" : "running";
  }
}

export function visibleToolError(part: AgentToolPart): string | null {
  return part.error ? presentAgentToolFailure(part) : null;
}

export function toolDisplayFingerprint(part: AgentToolPart): string {
  const presentation = presentAgentTool(part);
  const approvalInput = (part.location === "vault" || part.native)
    && part.state === "approval-required"
    && part.approvalId
    ? part.input
    : undefined;
  const artifacts = ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)
    ? part.output?.artifacts
    : undefined;
  return JSON.stringify({
    location: part.location,
    state: part.state,
    presentation,
    details: presentAgentToolDetails(part),
    error: visibleToolError(part),
    approvalId: approvalInput === undefined ? undefined : part.approvalId,
    approvalInput,
    approvalDecision: part.approvalDecision,
    approvalScope: part.approvalScope,
    native: part.native,
    artifacts,
  });
}

export function agentPartsEqual(
  left: AgentPart | undefined,
  right: AgentPart,
  committedToolFingerprint?: string,
  incomingToolFingerprint?: string,
): boolean {
  if (left === right && right.kind !== "tool") return true;
  if (!left || left.kind !== right.kind || left.id !== right.id || left.order !== right.order) {
    return false;
  }
  switch (right.kind) {
    case "text":
      return left.kind === "text"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.markdown === right.markdown;
    case "reasoning":
      return left.kind === "reasoning"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.summary === right.summary;
    case "error":
      return left.kind === "error"
        && left.retryable === right.retryable
        && left.retryMessageId === right.retryMessageId
        && JSON.stringify(presentAgentError(left.error, left.retryable))
          === JSON.stringify(presentAgentError(right.error, right.retryable));
    case "tool":
      return left.kind === "tool"
        && left.messageId === right.messageId
        && left.callId === right.callId
        && committedToolFingerprint === incomingToolFingerprint;
  }
}

export function terminalToolPresentation(
  part: AgentPart,
  presentation: AgentConversationPresentation,
): AgentPart {
  if (
    part.kind !== "tool"
    || !["completed", "cancelled", "failed"].includes(presentation.phase)
    || (part.state !== "approval-required" && !isActiveAgentToolState(part.state))
  ) {
    return part;
  }
  const state: AgentToolPart["state"] = presentation.phase === "cancelled"
    ? "cancelled"
    : presentation.phase === "failed"
      ? "failed"
      : "outcome-unknown";
  return { ...part, state, ...(part.state === "approval-required" ? { approvalDecision: "withdrawn" as const } : {}) };
}

export function historicalToolPart(tool: ToolCall): AgentToolPart {
  const fn = readManagedToolCallFunction(tool);
  const success = tool.state === "completed" && tool.result?.success === true;
  let input: unknown = {};
  let paths: string[] = [];
  try {
    input = JSON.parse(fn?.arguments || "{}");
    if (fn) {
      paths = success
        ? collectToolArtifactPaths(fn.name, input as Record<string, unknown>, tool.result?.data)
        : collectSuccessfulToolArtifactPaths(fn.name, tool.result?.data);
    }
  } catch {
    // Malformed input is already represented by the durable failed tool state.
    input = fn?.arguments ?? {};
  }
  const state = historicalToolState(tool, success);
  const summary = tool.result?.data && typeof tool.result.data === "object"
    && typeof (tool.result.data as { summary?: unknown }).summary === "string"
    ? (tool.result.data as { summary: string }).summary
    : paths.join(", ");
  return {
    id: tool.id,
    order: tool.timestamp,
    kind: "tool",
    messageId: tool.messageId,
    callId: tool.id,
    name: fn?.name ?? "unknown_tool",
    location: isServerExecutedManagedToolCall(tool) ? "server" : "vault",
    input,
    state,
    ...(tool.native ? { native: tool.native } : {}),
    ...(tool.approvalDecision ? { approvalDecision: tool.approvalDecision } : {}),
    ...(tool.approvalScope ? { approvalScope: tool.approvalScope } : {}),
    ...(typeof tool.result?.data !== "undefined" || paths.length ? {
      output: {
        ...(summary ? { summary } : {}),
        data: tool.result?.data,
        ...(paths.length ? {
          artifacts: paths.map((path) => ({
            id: `${tool.id}:artifact:${path}`,
            kind: "vault_file" as const,
            title: path.split("/").pop() || path,
            path,
          })),
        } : {}),
      },
    } : {}),
    ...(!success && tool.result?.error ? {
      error: {
        code: String(tool.result.error.code || "TOOL_EXECUTION_FAILED"),
        message: tool.result.error.message || "The tool failed.",
      },
    } : {}),
  };
}

