import {
  parseThinAgentDataPart,
  type ThinAgentRunTerminalData,
} from "../../services/managed/ThinAgentV1Contract";
import type { ChatMessage, MessagePart, MultiPartContent } from "../../types";
import type { ToolCall, ToolCallResult } from "../../types/toolCalls";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import {
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentServerRunId,
} from "../../utils/ThinAgentLifecycleSchema";
import { requiresUserApproval, type ToolApprovalPolicy } from "../../utils/toolPolicy";
import { replaceControlCharacters } from "../../utils/characterValidation";
import { deepFreeze, isDeeplyFrozen, sameJsonValue } from "../../utils/immutableJson";
import type {
  AgentConversationSnapshot,
  AgentPart,
  AgentRunPhase,
  AgentToolPart,
  ManagedAgentError,
  ToolResultSummary,
} from "../ChatConversation";
import {
  createTextAttachmentPart,
  createUnavailableAttachmentPart,
  parseAttachedTextContent,
} from "../ChatAttachmentContent";
import type { AgentConnectionState, AgentSessionSnapshot } from "./AuthoritativeSession";
import { canonicalAgentToolInput } from "./MutationJournal";
import type { VaultActionDecision } from "./VaultActionAuthorization";
import {
  currentTurnMessages,
  collectClientToolTargets,
  canonicalTools,
  toolCallId,
  toolApproval,
  toolOutput,
  toolName,
  toolInput,
  outputAsToolResult,
  isAuthoritativeTerminalToolPart,
  isRecord,
  safeOutboundVaultToolResult,
  toJsonValue,
  terminalError,
  terminalFromMessages,
  latestUserId,
  type WireMessage,
  type WirePart,
  type ProjectedTool,
  type LocalToolCall,
} from "./WireConversation";

const INTERNAL_SERVER_TOOL_NAMES = new Set(["set_context"]);
const MAX_SOURCE_URLS = 16;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_TITLE_LENGTH = 160;

function toolResultArtifacts(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "callId" | "name" | "location" | "input">,
): ToolResultSummary["artifacts"] {
  if (tool.location !== "vault") return undefined;
  const input = isRecord(tool.input) ? tool.input : {};
  const paths = result.success
    ? collectToolArtifactPaths(tool.name, input, result.data)
    : collectSuccessfulToolArtifactPaths(tool.name, result.data);
  return paths.length > 0
    ? paths.map((path) => ({
        id: `${tool.callId}:artifact:${path}`,
        kind: "vault_file" as const,
        title: path.split("/").pop() || path,
        path,
      }))
    : undefined;
}

function defaultToolFailureMessage(
  tool: Pick<ProjectedTool, "name" | "location">,
): string {
  if (tool.location === "vault") return "The vault action failed.";
  return tool.name === "web_search"
    ? "Web search failed."
    : "The server action failed.";
}

function safeToolResult(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "name" | "location">,
): ToolCallResult {
  if (tool.location !== "server" || result.success) return result;
  return {
    success: false,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: defaultToolFailureMessage(tool),
    },
  };
}

function toolResultSummary(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "callId" | "name" | "location" | "input">,
): ToolResultSummary {
  const artifacts = toolResultArtifacts(result, tool);
  return result.success
    ? {
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      }
    : {
        summary: result.error?.message ?? defaultToolFailureMessage(tool),
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      };
}

function projectedToolResult(
  tool: ProjectedTool,
  active: ProjectionRun,
): ToolCallResult | undefined {
  const authoritative = isAuthoritativeTerminalToolPart(tool.part);
  if (authoritative && tool.part.state === "output-available") {
    return safeToolResult(outputAsToolResult(toolOutput(tool.part)), tool);
  }
  if (
    tool.location === "vault"
    && !authoritative
  ) {
    if (!actionMatches(active, tool)) {
      return undefined;
    }
    return localResultMatches(active, tool)
      ? active.localResults.get(tool.callId)?.result : undefined;
  }
  return undefined;
}

function discardSupersededLocalToolResults(
  active: ProjectionRun,
  tools: ReadonlyMap<string, ProjectedTool>,
): void {
  for (const callId of active.localResults.keys()) {
    const tool = tools.get(callId);
    if (
      !tool
      || tool.location !== "vault"
      || !actionMatches(active, tool)
    ) continue;
    if (isAuthoritativeTerminalToolPart(tool.part)) {
      active.localResults.delete(callId);
    }
  }
}

function projectedToolState(
  tool: ProjectedTool,
  active: ProjectionRun,
  result = projectedToolResult(tool, active),
): AgentToolPart["state"] {
  if (tool.part.state === "output-error") return "failed";
  if (tool.part.state === "output-denied") return "denied";
  if (result) return result.success ? "succeeded" : "failed";
  if (active.executingToolIds.has(tool.callId)) return "running";
  const decision = actionFact(active, tool)?.decision;
  const locallyApproved = decision?.approved === true
    && actionMatches(active, tool);
  if (tool.location === "server") {
    switch (tool.part.state) {
      case "input-streaming": return "input-streaming";
      case "output-available":
        return tool.part.preliminary === true
          ? "running"
          : outputAsToolResult(toolOutput(tool.part)).success ? "succeeded" : "failed";
      case "output-error": return "failed";
      case "output-denied": return "denied";
      default: return "running";
    }
  }
  switch (tool.part.state) {
    case "input-streaming": return "input-streaming";
    case "input-available":
      return requiresUserApproval(tool.name, active.approvalPolicy)
        ? decision === undefined
          ? "approval-required"
          : locallyApproved
            ? "approved"
            : "denied"
        : "input-ready";
    case "approval-requested":
      return decision === undefined
        ? "approval-required"
        : locallyApproved
          ? "approved"
          : "denied";
    case "approval-responded":
      if (toolApproval(tool.part)?.approved === false) return "denied";
      return requiresUserApproval(tool.name, active.approvalPolicy)
        ? locallyApproved ? "approved" : "approval-required"
        : "approved";
    case "output-available":
      return tool.part.preliminary === true
        ? "running"
        : outputAsToolResult(toolOutput(tool.part)).success ? "succeeded" : "failed";
    case "output-error": return "failed";
    case "output-denied": return "denied";
    default: return "input-ready";
  }
}

function toolFailure(
  tool: ProjectedTool,
  result: ToolCallResult | undefined,
): ManagedAgentError | undefined {
  const part = tool.part;
  if (part.state === "output-error") {
    return {
      code: "TOOL_EXECUTION_FAILED",
      message: tool.location === "server"
        ? defaultToolFailureMessage(tool)
        : typeof part.errorText === "string"
          ? part.errorText
          : defaultToolFailureMessage(tool),
    };
  }
  if (result && !result.success) {
    return {
      code: result.error?.code ?? "TOOL_EXECUTION_FAILED",
      message: result.error?.message ?? defaultToolFailureMessage(tool),
    };
  }
  return undefined;
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_SOURCE_URL_LENGTH) return null;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function markdownSourceTitle(value: unknown, fallback: string): string {
  const title = typeof value === "string" ? value : "";
  return replaceControlCharacters(title.trim() || fallback, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SOURCE_TITLE_LENGTH)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1");
}

function nativeSourceMarkdown(messages: readonly WireMessage[]): string {
  const seen = new Set<string>();
  const sources: Array<Readonly<{ url: string; title: string }>> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "source-url") continue;
      const url = safeSourceUrl(part.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: markdownSourceTitle(part.title, url) });
      if (sources.length >= MAX_SOURCE_URLS) break;
    }
    if (sources.length >= MAX_SOURCE_URLS) break;
  }
  return sources.length > 0
    ? `### Sources\n\n${sources.map(({ title, url }) => `- [${title}](<${url}>)`).join("\n")}`
    : "";
}

export function freezeSnapshot(snapshot: AgentConversationSnapshot): AgentConversationSnapshot {
  return Object.freeze({
    ...snapshot,
    messages: Object.freeze(snapshot.messages.map((message) => Object.freeze({
      ...message,
      partIds: Object.freeze([...message.partIds]),
    }))),
    parts: Object.freeze(snapshot.parts.map((part) => Object.freeze(part))),
  });
}

function projectRun(
  active: ProjectionRun,
  messages: readonly WireMessage[],
  connectionState: AgentConnectionState,
  runStalled = false,
  analysis?: TurnAnalysis,
): AgentConversationSnapshot {
  const turnMessages = analysis?.messages ?? currentTurnMessages(messages, active.turnId);
  const tools = analysis?.canonical ?? canonicalTools(turnMessages, collectClientToolTargets(turnMessages));
  const parts: AgentPart[] = [];
  const projectedMessages: AgentConversationSnapshot["messages"][number][] = [];
  let order = 0;
  const assistantMessages = turnMessages.filter((message) => message.role === "assistant");
  const sourceMarkdown = nativeSourceMarkdown(assistantMessages);
  const finalAssistantId = assistantMessages[assistantMessages.length - 1]?.id;

  for (const message of assistantMessages) {
    const partIds: string[] = [];
    message.parts.forEach((part, partIndex) => {
      if (part.type === "text" && typeof part.text === "string") {
        const id = `text:${message.id}:${partIndex}`;
        partIds.push(id);
        parts.push({
          id,
          kind: "text",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          markdown: part.text,
          order: order++,
        });
        return;
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        const id = `reasoning:${message.id}:${partIndex}`;
        partIds.push(id);
        parts.push({
          id,
          kind: "reasoning",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          summary: part.text,
          order: order++,
        });
        return;
      }
      const callId = toolCallId(part);
      if (!callId) return;
      const tool = tools.get(callId);
      if (!tool || tool.messageId !== message.id || tool.partIndex !== partIndex
        || INTERNAL_SERVER_TOOL_NAMES.has(tool.name)) return;
      const id = `tool:${callId}`;
      const result = projectedToolResult(tool, active);
      const state = projectedToolState(tool, active, result);
      const approval = toolApproval(tool.part);
      const syntheticApprovalId = actionFact(active, tool)?.approvalId;
      const failure = toolFailure(tool, result);
      partIds.push(id);
      parts.push({
        id,
        kind: "tool",
        messageId: message.id,
        callId,
        name: tool.name,
        location: tool.location,
        input: tool.input,
        state,
        ...(approval?.id || syntheticApprovalId
          ? { approvalId: approval?.id ?? syntheticApprovalId }
          : {}),
        ...(result ? { output: toolResultSummary(result, tool) } : {}),
        ...(failure ? { error: failure } : {}),
        order: order++,
      });
    });
    if (sourceMarkdown && message.id === finalAssistantId) {
      const id = `sources:${message.id}`;
      partIds.push(id);
      parts.push({
        id,
        kind: "text",
        messageId: message.id,
        state: "complete",
        markdown: sourceMarkdown,
        order: order++,
      });
    }
    projectedMessages.push(Object.freeze({
      id: message.id,
      role: "assistant" as const,
      partIds: Object.freeze(partIds),
    }));
  }

  let status: AgentConversationSnapshot["status"] = "running";
  let phase = active.phase;
  let label = active.label;
  let waitingReason: AgentConversationSnapshot["waitingReason"];
  let error: ManagedAgentError | undefined;
  if (active.terminal?.outcome === "succeeded") {
    status = "completed";
    phase = "complete";
    label = "";
  } else if (active.terminal?.outcome === "cancelled") {
    status = "cancelled";
    phase = "complete";
    label = "Stopped";
  } else if (active.terminal?.outcome === "failed") {
    status = "failed";
    error = terminalError(active.terminal);
  } else if (active.cancelRequested) {
    label = "Stopping";
  } else if (connectionState !== "open") {
    phase = "retrying";
    label = connectionState === "connecting" ? "Starting" : "Reconnecting";
  } else if (active.serverQueued) {
    phase = "submitted";
    label = "Queued";
  } else if (parts.some((part) =>
    part.kind === "tool" && part.state === "approval-required")) {
    status = "waiting";
    phase = "waiting";
    label = "Waiting for approval";
    waitingReason = "approval";
  } else if (runStalled) {
    // Synchronization is healthy, but the server has sent no run progress.
    // Keep the run open because only the server may end it.
    phase = "retrying";
    label = "Still waiting on the server";
  } else if (active.executingToolIds.size > 0) {
    status = "waiting";
    phase = "waiting";
    label = "Working in your vault";
    waitingReason = "local_tool";
  } else if (parts.some((part) => part.kind === "text" && part.state === "streaming")) {
    phase = "working";
    label = "Responding";
  } else if (parts.some((part) => part.kind === "tool")) {
    phase = "working";
    label = "Working";
  } else {
    phase = "thinking";
    label = "Thinking";
  }
  if (error) {
    parts.push({
      id: `error:${active.turnId}`,
      kind: "error",
      error,
      retryable: error.retryable === true,
      retryMessageId: active.turnId,
      order: order++,
    });
  }
  return freezeSnapshot({
    runId: active.serverRunId,
    turnId: active.turnId,
    status,
    ...(active.elapsedMs === null ? {} : { elapsedMs: active.elapsedMs }),
    phase,
    ...(label ? { statusLabel: label } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(error ? { terminalError: error } : {}),
    messages: Object.freeze(projectedMessages),
    parts: Object.freeze(parts),
  });
}

function textFromDataUrl(url: string): string {
  const comma = url.indexOf(",");
  if (comma < 0 || !/;base64$/iu.test(url.slice(0, comma))) {
    throw new Error("Unsupported text file URL.");
  }
  const binary = atob(url.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function durableUserMessage(message: WireMessage): ChatMessage {
  const parts: MultiPartContent[] = [];
  let hasFile = false;
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (
      part.type === "file"
      && typeof part.mediaType === "string"
      && typeof part.url === "string"
    ) {
      hasFile = true;
      if (part.mediaType.startsWith("image/")) {
        parts.push({ type: "image_url", image_url: { url: part.url } });
      } else {
        const name = typeof part.filename === "string" && part.filename.trim()
          ? part.filename.trim()
          : "attachment";
        try {
          const decoded = textFromDataUrl(part.url);
          parts.push(parseAttachedTextContent(decoded)
            ? { type: "text", text: decoded }
            : createTextAttachmentPart(
                name,
                part.mediaType,
                new TextEncoder().encode(decoded),
              ));
        } catch {
          parts.push(createUnavailableAttachmentPart(name, part.mediaType));
        }
      }
    }
  }
  return {
    role: "user",
    message_id: message.id,
    content: hasFile
      ? parts
      : parts
          .filter((part): part is Extract<MultiPartContent, { type: "text" }> =>
            part.type === "text")
          .map((part) => part.text)
          .join(""),
  };
}

function durableTool(
  tool: ProjectedTool,
  timestamp: number,
): ToolCall | null {
  const state = tool.part.state;
  if (!isAuthoritativeTerminalToolPart(tool.part)) return null;
  if (state === "output-available") {
    // Durable graphs are frozen in place; never freeze a caller's live output.
    const output = toolOutput(tool.part);
    const result = safeToolResult(
      outputAsToolResult(isDeeplyFrozen(output) ? output : structuredClone(output)),
      tool,
    );
    return {
      id: tool.callId,
      messageId: "",
      request: {
        id: tool.callId,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
      },
      state: result.success ? "completed" : "failed",
      timestamp,
      result,
      ...(tool.location === "server" ? { executedOn: "server" as const } : {}),
    };
  }
  return {
    id: tool.callId,
    messageId: "",
    request: {
      id: tool.callId,
      type: "function",
      function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
    },
    state: "failed",
    timestamp,
    result: {
      success: false,
      error: state === "output-denied"
        ? { code: "USER_DENIED", message: "The user denied this vault action." }
        : {
            code: "TOOL_EXECUTION_FAILED",
            message: tool.location === "server"
              ? defaultToolFailureMessage(tool)
              : typeof tool.part.errorText === "string"
                ? tool.part.errorText
                : "The vault action failed.",
          },
    },
    ...(tool.location === "server" ? { executedOn: "server" as const } : {}),
  };
}

function durableAssistantMessage(
  message: WireMessage,
  sequence: readonly WireMessage[],
  now: number,
  appendSources: boolean,
  responseDurationMs?: number,
): ChatMessage | null {
  const targets = collectClientToolTargets(sequence);
  const tools = canonicalTools(sequence, targets);
  const messageParts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  let order = 0;
  message.parts.forEach((part, partIndex) => {
    const timestamp = now + order;
    if (part.type === "text" && typeof part.text === "string") {
      content += part.text;
      messageParts.push({
        id: `text:${message.id}:${partIndex}`,
        type: "content",
        timestamp,
        data: part.text,
      });
      order += 1;
      return;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      messageParts.push({
        id: `reasoning:${message.id}:${partIndex}`,
        type: "reasoning",
        timestamp,
        data: part.text,
      });
      order += 1;
      return;
    }
    const callId = toolCallId(part);
    if (!callId) return;
    const tool = tools.get(callId);
    if (!tool || tool.messageId !== message.id || tool.partIndex !== partIndex
      || INTERNAL_SERVER_TOOL_NAMES.has(tool.name)) return;
    const durable = durableTool(tool, timestamp);
    if (!durable) return;
    durable.messageId = message.id;
    toolCalls.push(durable);
    messageParts.push({
      id: `tool:${callId}`,
      type: "tool_call",
      timestamp,
      data: durable,
    });
    order += 1;
  });
  if (appendSources) {
    const sources = nativeSourceMarkdown(sequence);
    if (sources) {
      content += content ? `\n\n${sources}` : sources;
      messageParts.push({
        id: `sources:${message.id}`,
        type: "content",
        timestamp: now + order,
        data: sources,
      });
    }
  }
  const hasTerminal = message.parts.some((part) => {
    const parsed = parseThinAgentDataPart(part);
    return parsed?.kind === "known"
      && parsed.type === "data-systemsculpt-run-terminal";
  });
  if (!content && messageParts.length === 0 && hasTerminal) return null;
  return {
    role: "assistant",
    message_id: message.id,
    content,
    ...(responseDurationMs === undefined ? {} : { responseDurationMs }),
    ...(messageParts.length > 0 ? { messageParts } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

type DurableTerminalMetadata =
  | Readonly<{ terminalOutcome: "cancelled" }>
  | Readonly<{
      terminalOutcome: "failed";
      terminalIncidentId: string;
      terminalFailureCode: string;
      terminalRetryable: boolean;
      terminalServerRunId: string;
    }>;

function durableTerminalMetadata(
  terminal: ThinAgentRunTerminalData,
): DurableTerminalMetadata | null {
  if (terminal.outcome === "cancelled") {
    return { terminalOutcome: "cancelled" };
  }
  if (
    terminal.outcome !== "failed"
    || !isThinAgentIncidentId(terminal.incident_id)
    || terminal.incident_id === `incident_${"0".repeat(32)}`
    || !isThinAgentFailureCode(terminal.code)
    || !isThinAgentServerRunId(terminal.run_id)
    || terminal.run_id === `run_${"0".repeat(32)}`
  ) return null;
  return {
    terminalOutcome: "failed",
    terminalIncidentId: terminal.incident_id,
    terminalFailureCode: terminal.code,
    terminalRetryable: terminal.retryable,
    terminalServerRunId: terminal.run_id,
  };
}

/**
 * Validated terminal presentation data carried by an assistant wire sequence,
 * whether folded into a streamed message or stored as a marker sibling.
 */
function sequenceTerminalMetadata(
  sequence: readonly WireMessage[],
  rootMessageId: string | null,
): Readonly<{ messageId: string; metadata: DurableTerminalMetadata }> | null {
  if (rootMessageId === null) return null;
  for (let messageIndex = sequence.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = sequence[messageIndex];
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const parsed = parseThinAgentDataPart(message.parts[partIndex]);
      if (
        parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal"
        && parsed.data.root_message_id === rootMessageId
      ) {
        const metadata = durableTerminalMetadata(parsed.data);
        return metadata ? { messageId: message.id, metadata } : null;
      }
    }
  }
  return null;
}

type DurableTurnPresentation = Readonly<{
  rootMessageId: string;
  responseDurationMs: number;
}>;

function durableServerHistory(
  messages: readonly WireMessage[],
  now: number,
  turnPresentation?: DurableTurnPresentation,
): ChatMessage[] {
  const output: ChatMessage[] = [];
  let rootMessageId: string | null = null;
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (message.role === "user") {
      output.push(durableUserMessage(message));
      rootMessageId = message.id;
      index += 1;
      continue;
    }
    const start = index;
    while (index < messages.length && messages[index].role === "assistant") index += 1;
    const sequence = messages.slice(start, index);
    const terminal = sequenceTerminalMetadata(sequence, rootMessageId);
    const sequenceStart = output.length;
    sequence.forEach((assistant, sequenceIndex) => {
      const durable = durableAssistantMessage(
        assistant,
        sequence,
        now + (start + sequenceIndex) * 1_000,
        sequenceIndex === sequence.length - 1,
      );
      if (durable) output.push(durable);
    });
    if (
      output.length === sequenceStart
      && terminal?.metadata.terminalOutcome === "failed"
    ) {
      output.push({
        role: "assistant",
        message_id: terminal.messageId,
        content: "",
        ...terminal.metadata,
      });
    } else if (terminal && output.length > sequenceStart) {
      const tail = output[output.length - 1];
      output[output.length - 1] = { ...tail, ...terminal.metadata };
    }
    if (
      turnPresentation
      && rootMessageId === turnPresentation.rootMessageId
      && output.length > sequenceStart
    ) {
      const tail = output[output.length - 1];
      output[output.length - 1] = {
        ...tail,
        responseDurationMs: turnPresentation.responseDurationMs,
      };
    }
  }
  return output;
}

function hasDurableAssistantContent(
  messages: readonly Immutable<ChatMessage>[],
  rootMessageId: string,
): boolean {
  // durableServerHistory emits only user and assistant messages. It mirrors
  // tool parts into tool_calls and text parts into the string content field.
  const rootIndex = messages.findIndex((message) =>
    message.role === "user" && message.message_id === rootMessageId);
  if (rootIndex < 0) return false;
  for (let index = rootIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if ((message.tool_calls?.length ?? 0) > 0) return true;
    if (message.messageParts?.some((part) =>
      part.type === "reasoning" && part.data.trim().length > 0)) return true;
    if (typeof message.content === "string" && message.content.trim().length > 0) return true;
  }
  return false;
}

/**
 * Build the terminal-only durability view of authoritative history.
 *
 * The server can legitimately finish after accepting a client tool result
 * while its last assistant snapshot still contains only the original
 * `input-available` part (or an SDK `preliminary` echo). Live projection keeps
 * the locally settled result visible from ProjectionRun, but persistence otherwise
 * consumes that stale wire part and drops the tool on save/reconcile.
 *
 * Only the exact vault call that executed locally may be upgraded. A final
 * wire outcome remains authoritative, server-owned tools are never touched,
 * and the stored execution identity must still match the current request.
 */
function overlayCompletedLocalToolResults(
  messages: readonly WireMessage[],
  active: Pick<
    ProjectionRun,
    "turnId" | "actionFacts" | "retainedActionFacts" | "localResults"
  >,
): readonly WireMessage[] {
  if (active.localResults.size === 0) return messages;
  const turn = currentTurnMessages(messages, active.turnId);
  const targets = collectClientToolTargets(turn);
  const tools = canonicalTools(turn, targets);
  const replacements = new Map<WirePart, WirePart>();

  for (const [callId, { result }] of active.localResults) {
    const tool = tools.get(callId);
    if (
      !tool
      || tool.location !== "vault"
      || !actionMatches(active, tool)
      || !localResultMatches(active, tool)
      || isAuthoritativeTerminalToolPart(tool.part)
    ) continue;

    const safeResult = safeOutboundVaultToolResult(result);
    replacements.set(tool.part, Object.freeze({
      ...tool.part,
      state: "output-available",
      output: toJsonValue(safeResult),
      preliminary: false,
    }));
  }

  if (replacements.size === 0) return messages;
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      const replacement = replacements.get(part);
      if (!replacement) return part;
      changed = true;
      return replacement;
    });
    return changed
      ? Object.freeze({ ...message, parts: Object.freeze(parts) })
      : message;
  });
}

/**
 * Reinstate the streamed assistant tail of an interrupted run into the final
 * durable projection. A durable session snapshot built between cancellation
 * and the server's terminal fold can omit content that already streamed;
 * finalization is the last owner able to keep that content durable. When the
 * projection carries no run-terminal part, the terminal is folded into the
 * restored tail so restored history still knows the turn ended early.
 */
function restoreInterruptedTurnTail(
  messages: readonly WireMessage[],
  active: Pick<ProjectionRun, "turnId" | "streamedTurnMessages">,
  terminal: ThinAgentRunTerminalData,
): readonly WireMessage[] {
  const rootIndex = messages.findIndex((message) => message.id === active.turnId);
  if (rootIndex < 0) return messages;
  let end = rootIndex + 1;
  while (end < messages.length && messages[end].role !== "user") end += 1;
  const turn = messages.slice(rootIndex + 1, end);
  const present = new Set(turn.map((message) => message.id));
  const missing = active.streamedTurnMessages.filter((message) =>
    message.role === "assistant" && !present.has(message.id));
  const restored = [...turn, ...missing];
  if (restored.length === 0) {
    if (terminal.outcome !== "failed") return messages;
    restored.push({
      id: `terminal:${terminal.run_id}`,
      role: "assistant",
      parts: [],
    });
  }
  const hasTerminalPart = restored.some((message) =>
    message.parts.some((part) => {
      const parsed = parseThinAgentDataPart(part);
      return parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal";
    }));
  if (missing.length === 0 && hasTerminalPart) return messages;
  if (!hasTerminalPart) {
    const last = restored[restored.length - 1];
    restored[restored.length - 1] = {
      ...last,
      parts: [
        ...last.parts,
        {
          type: "data-systemsculpt-run-terminal",
          id: `terminal:${terminal.run_id}`,
          data: terminal,
        },
      ],
    };
  }
  return [
    ...messages.slice(0, rootIndex + 1),
    ...restored,
    ...messages.slice(end),
  ];
}

export function initialSnapshot(): AgentConversationSnapshot {
  return freezeSnapshot({
    runId: null,
    turnId: null,
    status: "idle",
    messages: [],
    parts: [],
  });
}

export type ProjectionTurn = Readonly<{
  requestId: string;
  turnId: string;
  origin: "submitted" | "recovered";
}>;

/** Immutable display evidence, never an executable approval capability. */
export type ToolPresentationFact = Readonly<{
  call: LocalToolCall;
  identityConfirmed: boolean;
  approvalId?: string;
  decision?: VaultActionDecision;
}>;

export type RunPresentation = Readonly<{
  serverRunId: string | null;
  phase: AgentRunPhase;
  label: string;
  terminal: ThinAgentRunTerminalData | null;
  cancelRequested: boolean;
  serverQueued: boolean;
  elapsedMs: number | null;
  connectionState: AgentConnectionState;
  runStalled?: boolean;
  tools: readonly ToolPresentationFact[];
  executingToolIds: readonly string[];
}>;

type Immutable<T> = T extends readonly (infer E)[]
  ? readonly Immutable<E>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export type HistoryProjection = Readonly<{
  key: string;
  messages: readonly Immutable<ChatMessage>[];
  assistant?: Immutable<ChatMessage>;
}>;

/**
 * Freeze a freshly built durable graph in place. The only objects it borrows
 * are tool outputs, which are either already deeply frozen wire data or
 * copied by durableTool, so no whole-graph copy is needed.
 */
function immutableHistory<T>(value: T): Immutable<T> {
  return deepFreeze(value) as Immutable<T>;
}

/** Wire messages are deeply frozen, so equal references need no walk. */
function sameWireMessages(
  left: readonly WireMessage[],
  right: readonly WireMessage[],
): boolean {
  return left.length === right.length && left.every((message, index) =>
    message === right[index] || sameJsonValue(message, right[index]));
}

type StoredActionFact = Omit<ToolPresentationFact, "call">;

type ToolBinding = Readonly<{
  callId: string; name: string; input: LocalToolCall["input"];
  state: unknown; approval: ReturnType<typeof toolApproval>;
}>;

type TurnAnalysis = Readonly<{
  messages: readonly WireMessage[];
  canonical: ReturnType<typeof canonicalTools>;
  tools: readonly ProjectedTool[];
  clientTools: readonly ProjectedTool[];
  requests: readonly LocalToolCall[];
  bindings: readonly ToolBinding[];
  hasAssistant: boolean;
}>;

type TurnState = {
  readonly turn: ProjectionTurn;
  readonly approvalPolicy: ToolApprovalPolicy;
  readonly baseMessageIds: ReadonlySet<string>;
  readonly localResults: Map<string, Readonly<{ call: LocalToolCall; result: ToolCallResult }>>;
  readonly actionFacts: Map<string, StoredActionFact>;
  readonly analyses: Map<readonly WireMessage[], TurnAnalysis>;
  streamedTurnMessages: readonly WireMessage[];
  terminal: ThinAgentRunTerminalData | null;
};

type ProjectionRun = Omit<RunPresentation, "executingToolIds"> & {
  readonly turnId: string;
  readonly approvalPolicy: ToolApprovalPolicy;
  readonly actionFacts: ReadonlyMap<string, StoredActionFact>;
  readonly retainedActionFacts: ReadonlyMap<string, StoredActionFact>;
  readonly executingToolIds: ReadonlySet<string>;
  readonly streamedTurnMessages: readonly WireMessage[];
  readonly localResults: TurnState["localResults"];
};

/*
 * Tool inputs arrive deeply frozen from the wire and keep their identity while
 * other parts stream, so a key is built once per input and call instead of
 * canonicalizing every input again on each presented frame.
 */
const actionKeys = new WeakMap<object, Map<string, string>>();

function actionKey(call: LocalToolCall): string {
  const input = call.input;
  const cacheable = input !== null && typeof input === "object" && Object.isFrozen(input);
  const identity = `${call.callId}\u0000${call.name}`;
  const cached = cacheable ? actionKeys.get(input)?.get(identity) : undefined;
  if (cached !== undefined) return cached;
  const key = JSON.stringify([call.callId, call.name, canonicalAgentToolInput(input)]);
  if (cacheable) {
    let keys = actionKeys.get(input);
    if (!keys) actionKeys.set(input, keys = new Map());
    keys.set(identity, key);
  }
  return key;
}

function actionFact(
  run: Pick<ProjectionRun, "actionFacts" | "retainedActionFacts">,
  tool: LocalToolCall,
): StoredActionFact | undefined {
  const key = actionKey(tool);
  return run.actionFacts.get(key) ?? run.retainedActionFacts.get(key);
}

function actionMatches(run: Pick<ProjectionRun, "actionFacts" | "retainedActionFacts">, tool: LocalToolCall): boolean {
  return actionFact(run, tool)?.identityConfirmed === true;
}

function localResultMatches(run: Pick<ProjectionRun, "localResults">, tool: LocalToolCall): boolean {
  const call = run.localResults.get(tool.callId)?.call;
  return call !== undefined && call.name === tool.name
    && canonicalAgentToolInput(call.input) === canonicalAgentToolInput(tool.input);
}

/**
 * The readable local copy of one managed conversation. Authority is never
 * augmented: optimistic roots, interrupted tails and settled vault results
 * belong only to presentation. Execution, delivery and persistence remain in
 * the session; callers cannot mutate this owner's retained turn state.
 */
export class ConversationProjection {
  private authority: readonly WireMessage[] = Object.freeze([]);
  private presentation: readonly WireMessage[] = Object.freeze([]);
  private readonly turns = new WeakMap<ProjectionTurn, TurnState>();
  private lastHistory: Readonly<{
    source: readonly WireMessage[];
    durationKey: string;
    value: HistoryProjection;
  }> | null = null;
  private historyRevision = 0;

  public beginTurn(turn: ProjectionTurn, approvalPolicy: ToolApprovalPolicy): ProjectionTurn {
    const handle = Object.freeze({ ...turn });
    this.turns.set(handle, {
      turn: handle,
      approvalPolicy: Object.freeze({
        ...approvalPolicy,
        ...(approvalPolicy.trustedToolNames ? { trustedToolNames: new Set(approvalPolicy.trustedToolNames) } : {}),
        ...(approvalPolicy.autoApproveAllowlist ? { autoApproveAllowlist: [...approvalPolicy.autoApproveAllowlist] } : {}),
      }),
      baseMessageIds: new Set(this.authority.map((message) => message.id)),
      localResults: new Map(),
      actionFacts: new Map(),
      analyses: new Map(),
      streamedTurnMessages: Object.freeze([]),
      terminal: null,
    });
    return handle;
  }

  public observe(snapshot: AgentSessionSnapshot<WireMessage>, turn: ProjectionTurn | null): void {
    const state = turn ? this.state(turn) : null;
    if (state && !state.terminal) {
      const streamed = currentTurnMessages(this.presentation, state.turn.turnId)
        .filter((message) => message.role === "assistant");
      if (streamed.length > 0) state.streamedTurnMessages = streamed;
    }
    this.authority = snapshot.messages;
    const optimistic = snapshot.optimisticUser;
    if (!state || !optimistic || state.turn.origin !== "submitted"
      || state.turn.requestId !== optimistic.request_id
      || state.turn.turnId !== optimistic.message.id
      || snapshot.messages.some((message) => message.id === optimistic.message.id)) {
      this.presentation = snapshot.messages;
      return;
    }
    const firstAssistant = snapshot.messages.findIndex((message) =>
      message.role === "assistant" && !state.baseMessageIds.has(message.id));
    const insertion = firstAssistant < 0 ? snapshot.messages.length : firstAssistant;
    this.presentation = Object.freeze([
      ...snapshot.messages.slice(0, insertion), optimistic.message,
      ...snapshot.messages.slice(insertion),
    ]);
  }

  public recordLocalResult(turn: ProjectionTurn, call: LocalToolCall, result: ToolCallResult): void {
    this.state(turn).localResults.set(call.callId, Object.freeze({
      call: Object.freeze({ ...call, input: toJsonValue(call.input) }),
      result: outputAsToolResult(toJsonValue(result)),
    }));
  }

  /**
   * Turn evidence for one message source. The tool analysis is computed only
   * when a caller reads a tool field, so per-frame terminal and assistant
   * checks never canonicalize the turn's tools.
   */
  public inspect(
    turn: ProjectionTurn,
    source: "presentation" | "authoritative" = "presentation",
    runId?: string | null,
  ) {
    const state = this.state(turn);
    const messages = source === "authoritative" ? this.authority : this.presentation;
    let analysis: TurnAnalysis | undefined;
    const analyzed = (): TurnAnalysis => analysis ??= this.analyze(state, messages);
    const terminal = runId === undefined ? null : terminalFromMessages(
      runId ? this.authority : this.authority.filter((message) =>
        !state.baseMessageIds.has(message.id)), turn.turnId, runId,
    );
    return Object.freeze({
      get tools() { return analyzed().tools; },
      get clientTools() { return analyzed().clientTools; },
      get requests() { return analyzed().requests; },
      get bindings() { return analyzed().bindings; },
      get hasAssistant() {
        return analysis?.hasAssistant
          ?? currentTurnMessages(messages, turn.turnId)
            .some((message) => message.role === "assistant");
      },
      terminal,
    });
  }

  public present(
    turn: ProjectionTurn,
    facts: RunPresentation,
    purpose: "live" | "local-cancellation" | "failure-evidence" = "live",
  ): AgentConversationSnapshot {
    const state = this.state(turn);
    const run = this.run(state, facts, purpose !== "failure-evidence");
    let messages = purpose === "local-cancellation" ? this.authority : this.presentation;
    if (purpose === "failure-evidence" && facts.terminal) {
      messages = restoreInterruptedTurnTail(messages, run, facts.terminal);
    } else {
      state.terminal = facts.terminal;
      discardSupersededLocalToolResults(run, this.analyze(state, messages).canonical);
    }
    return projectRun(run, messages, facts.connectionState, facts.runStalled, this.analyze(state, messages));
  }

  public history(input: Readonly<{
    kind: "prefix" | "presentation" | "terminal" | "local-interruption";
    turn?: ProjectionTurn;
    terminal?: ThinAgentRunTerminalData;
    elapsedMs?: number | null;
    restoreTail?: boolean;
    tools?: readonly ToolPresentationFact[];
    now: number;
  }>): HistoryProjection | null {
    const state = input.turn ? this.state(input.turn) : null;
    let messages = this.presentation;
    if (input.kind === "prefix") {
      if (state?.terminal) return null;
      const root = state ? this.authority.findIndex((message) =>
        message.role === "user" && message.id === state.turn.turnId) : -1;
      messages = root >= 0 ? this.authority.slice(0, root + 1)
        : state ? this.authority.filter((message) => state.baseMessageIds.has(message.id))
        : this.authority;
    }
    if (messages.length === 0) return null;
    const terminal = input.terminal;
    if (state && terminal && (input.kind === "terminal" || input.restoreTail)) {
      if (terminal.outcome !== "succeeded") {
        this.presentation = restoreInterruptedTurnTail(messages, {
          turnId: state.turn.turnId,
          streamedTurnMessages: state.streamedTurnMessages,
        }, terminal);
        messages = this.presentation;
      }
    }
    if (state && input.kind === "terminal") {
      const run = this.run(state, {
        serverRunId: terminal?.run_id ?? null, phase: "complete", label: "",
        terminal: terminal ?? null, cancelRequested: false, serverQueued: false,
        elapsedMs: input.elapsedMs ?? null, connectionState: "idle",
        tools: input.tools ?? [], executingToolIds: [],
      });
      messages = overlayCompletedLocalToolResults(messages, run);
    }
    const duration = state && input.elapsedMs !== null && input.elapsedMs !== undefined
      ? { rootMessageId: state.turn.turnId, responseDurationMs: input.elapsedMs }
      : undefined;
    const durationKey = duration
      ? `${duration.rootMessageId}\n${duration.responseDurationMs}`
      : "";
    const previous = this.lastHistory;
    let value: HistoryProjection;
    // The key is a revision, not a serialization: equal wire content reuses
    // the previous value and its key, so the session skips a redundant write
    // without holding a whole-transcript string.
    if (previous && previous.durationKey === durationKey
      && sameWireMessages(previous.source, messages)) {
      value = previous.value;
      if (previous.source !== messages) {
        this.lastHistory = { source: messages, durationKey, value };
      }
    } else {
      value = Object.freeze({
        key: `history:${++this.historyRevision}`,
        messages: immutableHistory(durableServerHistory(messages, input.now, duration)),
      });
      this.lastHistory = { source: messages, durationKey, value };
    }
    if (input.kind === "local-interruption" && (!state || !duration
      || !hasDurableAssistantContent(value.messages, state.turn.turnId))) return null;
    if (state && input.kind === "terminal" && terminal?.outcome === "succeeded") {
      const sequence = currentTurnMessages(messages, state.turn.turnId);
      const assistant = [...sequence].reverse().find((message) => message.role === "assistant");
      const durable = assistant ? durableAssistantMessage(
        assistant, sequence.filter((message) => message.role === "assistant"),
        input.now, true, input.elapsedMs ?? undefined,
      ) : null;
      if (durable) return Object.freeze({ ...value, assistant: immutableHistory(durable) });
    }
    return value;
  }

  public hydratedTail(connectionState: AgentConnectionState): AgentConversationSnapshot | null {
    const root = latestUserId(this.presentation);
    const terminal = root ? terminalFromMessages(this.presentation, root) : null;
    if (!root || !terminal || terminal.outcome === "succeeded") return null;
    const turn = this.beginTurn({ origin: "recovered", requestId: root, turnId: root }, {});
    return this.present(turn, {
      serverRunId: terminal.run_id, terminal, phase: "retrying", label: "Recovering",
      elapsedMs: null, cancelRequested: false, serverQueued: false,
      connectionState, tools: [], executingToolIds: [],
    });
  }

  private analyze(state: TurnState, messages: readonly WireMessage[]): TurnAnalysis {
    const cached = state.analyses.get(messages);
    if (cached) return cached;
    const sequence = currentTurnMessages(messages, state.turn.turnId);
    const targets = collectClientToolTargets(sequence);
    const tools = canonicalTools(sequence, targets);
    // Keep every identity occurrence. Display canonicalization may select a
    // later/stronger part, but must never hide conflicting execution evidence.
    const requests: LocalToolCall[] = [];
    const bindings: ToolBinding[] = [];
    for (const message of sequence) {
      for (const part of message.parts) {
        const parsed = parseThinAgentDataPart(part);
        if (parsed?.kind === "known") {
          if (parsed.type === "data-systemsculpt-client-tool-request") {
            requests.push(Object.freeze({
              callId: parsed.data.tool_call_id, name: parsed.data.tool_name,
              input: parsed.data.input,
            }));
          }
          continue;
        }
        const callId = toolCallId(part);
        const name = toolName(part);
        if (callId && name) bindings.push(Object.freeze({
          callId, name, input: toolInput(part), state: part.state,
          approval: toolApproval(part),
        }));
      }
    }
    const analysis: TurnAnalysis = Object.freeze({
      messages: sequence, canonical: tools,
      tools: Object.freeze([...tools.values()].map((tool) => Object.freeze(tool))),
      clientTools: Object.freeze([...targets.keys()].flatMap((callId) => {
        const tool = tools.get(callId);
        return tool && tool.location === "vault" ? [tool] : [];
      })),
      requests: Object.freeze(requests),
      bindings: Object.freeze(bindings),
      hasAssistant: sequence.some((message) => message.role === "assistant"),
    });
    state.analyses.set(messages, analysis);
    if (state.analyses.size > 2) state.analyses.delete(state.analyses.keys().next().value!);
    return analysis;
  }

  private state(turn: ProjectionTurn): TurnState {
    const state = this.turns.get(turn);
    if (!state) throw new Error("The projection turn belongs to another conversation.");
    return state;
  }

  private run(state: TurnState, facts: RunPresentation, retainFacts = false): ProjectionRun {
    const actionFacts = new Map<string, StoredActionFact>();
    for (const fact of facts.tools) {
      const key = actionKey(fact.call);
      const stored = Object.freeze({
        identityConfirmed: fact.identityConfirmed,
        ...(fact.approvalId ? { approvalId: fact.approvalId } : {}),
        ...(fact.decision ? { decision: Object.freeze({ ...fact.decision }) } : {}),
      });
      actionFacts.set(key, stored);
      // Retain confirmed display evidence for interrupted tails, never each
      // transient server-tool input fragment observed during streaming.
      if (retainFacts) {
        if (fact.identityConfirmed) state.actionFacts.set(key, stored);
        else state.actionFacts.delete(key);
      }
    }
    return {
      ...facts,
      turnId: state.turn.turnId,
      approvalPolicy: state.approvalPolicy,
      localResults: state.localResults,
      actionFacts,
      retainedActionFacts: state.actionFacts,
      executingToolIds: new Set(facts.executingToolIds),
      streamedTurnMessages: state.streamedTurnMessages,
    };
  }
}
