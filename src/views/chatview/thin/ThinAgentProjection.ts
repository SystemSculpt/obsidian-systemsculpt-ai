import {
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "agents/chat/react";
import { FIRST_PARTY_TOOL_NAMES } from "../../../tools/toolNames";
import type { ChatMessage, MessagePart, MultiPartContent } from "../../../types";
import type { ToolCall, ToolCallResult } from "../../../types/toolCalls";
import {
  createTextAttachmentPart,
  createUnavailableAttachmentPart,
  parseAttachedTextContent,
} from "../attachments/ChatAttachmentContent";
import {
  collectSuccessfulToolArtifactPaths,
  collectToolArtifactPaths,
} from "../../../utils/toolArtifacts";
import {
  type AgentConversationSnapshot,
  type AgentPart,
  type AgentRunPhase,
  type AgentRunStatus,
  type AgentToolPart,
  type ManagedAgentError,
  type ToolResultSummary,
} from "../AgentConversation";

const VAULT_TOOL_NAMES = new Set<string>(FIRST_PARTY_TOOL_NAMES);
const INTERNAL_SERVER_TOOL_NAMES = new Set(["set_context"]);
const MAX_NATIVE_SOURCE_URLS = 16;
const MAX_NATIVE_SOURCE_URL_LENGTH = 2_048;
const MAX_NATIVE_SOURCE_TITLE_LENGTH = 160;

function isInternalServerToolName(name: string): boolean {
  return INTERNAL_SERVER_TOOL_NAMES.has(name);
}

function toolLocation(
  part: Extract<UIMessage["parts"][number], { toolCallId: string }>,
  name: string,
): AgentToolPart["location"] {
  return part.providerExecuted === true || !VAULT_TOOL_NAMES.has(name)
    ? "server"
    : "vault";
}

export type ThinAgentTerminalOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "failed"; error: ManagedAgentError }>;

export type ThinAgentProjectionState = Readonly<{
  runId: string;
  turnId: string;
  statusPhase: AgentRunPhase;
  statusLabel: string;
  terminalOutcome: ThinAgentTerminalOutcome | null;
  chat: Readonly<{ messages: UIMessage[] }>;
  executingToolIds: ReadonlySet<string>;
}>;

export function currentTurnMessages(
  messages: readonly UIMessage[],
  turnId: string,
): readonly UIMessage[] {
  const userIndex = messages.findIndex((message) =>
    message.role === "user" && message.id === turnId);
  if (userIndex < 0) return [];
  const nextUserOffset = messages.slice(userIndex + 1)
    .findIndex((message) => message.role === "user");
  const end = nextUserOffset < 0
    ? messages.length
    : userIndex + 1 + nextUserOffset;
  return messages.slice(userIndex + 1, end);
}

function textFromDataUrl(url: string): string {
  const comma = url.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) {
    throw new Error("Unsupported text file URL.");
  }
  const binary = atob(url.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function outputAsToolResult(output: unknown): ToolCallResult {
  if (output && typeof output === "object" && !Array.isArray(output)
    && typeof (output as Record<string, unknown>).success === "boolean") {
    return output as ToolCallResult;
  }
  return { success: true, data: output };
}

function safeNativeSourceUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_NATIVE_SOURCE_URL_LENGTH) return null;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function markdownSourceTitle(value: string, fallback: string): string {
  const normalized = (value.trim() || fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_NATIVE_SOURCE_TITLE_LENGTH)
    .trim();
  return normalized
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]<>])/g, "\\$1");
}

function nativeSourceMarkdown(messages: readonly UIMessage[]): string {
  const seen = new Set<string>();
  const sources: Array<Readonly<{ url: string; title: string }>> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "source-url") continue;
      const url = safeNativeSourceUrl(part.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        title: markdownSourceTitle(part.title ?? "", url),
      });
      if (sources.length >= MAX_NATIVE_SOURCE_URLS) break;
    }
    if (sources.length >= MAX_NATIVE_SOURCE_URLS) break;
  }
  if (sources.length === 0) return "";
  return `### Sources\n\n${sources
    .map(({ title, url }) => `- [${title}](<${url}>)`)
    .join("\n")}`;
}

function toolResultArtifacts(
  result: ToolCallResult,
  part: Pick<AgentToolPart, "callId" | "name" | "location" | "input">,
): ToolResultSummary["artifacts"] {
  if (part.location !== "vault") return undefined;
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  const paths = result.success
    ? collectToolArtifactPaths(part.name, input, result.data)
    : collectSuccessfulToolArtifactPaths(part.name, result.data);
  return paths.length > 0
    ? paths.map((path) => ({
        id: `${part.callId}:artifact:${path}`,
        kind: "vault_file" as const,
        title: path.split("/").pop() || path,
        path,
      }))
    : undefined;
}

function toolResultSummary(
  result: ToolCallResult,
  part: Pick<AgentToolPart, "callId" | "name" | "location" | "input">,
): ToolResultSummary {
  const artifacts = toolResultArtifacts(result, part);
  return result.success
    ? {
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      }
    : {
        summary: result.error?.message ?? "The vault action failed.",
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      };
}

function toolState(
  part: Extract<UIMessage["parts"][number], { toolCallId: string }>,
  executing: boolean,
  location: AgentToolPart["location"],
): AgentToolPart["state"] {
  if (executing) return "running";
  const state = getToolPartState(part);
  if (location === "server") {
    switch (state) {
      case "streaming":
        return "input-streaming";
      case "loading":
      case "waiting-approval":
      case "approved":
        return "running";
      case "complete":
        return outputAsToolResult(getToolOutput(part)).success ? "succeeded" : "failed";
      case "denied":
        return "denied";
      case "error":
        return "failed";
    }
  }
  const approval = getToolApproval(part);
  switch (state) {
    case "streaming":
      return "input-streaming";
    case "loading":
      return "input-ready";
    case "waiting-approval":
      return "approval-required";
    case "approved":
      return approval?.approved === false ? "denied" : "approved";
    case "complete":
      return outputAsToolResult(getToolOutput(part)).success ? "succeeded" : "failed";
    case "denied":
      return "denied";
    case "error":
      return "failed";
  }
}

function toolError(
  part: Extract<UIMessage["parts"][number], { toolCallId: string }>,
): ManagedAgentError | undefined {
  if (part.state === "output-error") {
    return {
      code: "TOOL_EXECUTION_FAILED",
      message: part.errorText || "The tool failed.",
    };
  }
  if (getToolPartState(part) === "complete") {
    const result = outputAsToolResult(getToolOutput(part));
    if (!result.success) {
      return {
        code: result.error?.code ?? "TOOL_EXECUTION_FAILED",
        message: result.error?.message ?? "The tool failed.",
      };
    }
  }
  return undefined;
}

function statusFromRun(active: ThinAgentProjectionState): Readonly<{
  status: AgentRunStatus;
  phase: AgentRunPhase;
  label?: string;
  waitingReason?: "approval" | "local_tool";
}> {
  const terminal = active.terminalOutcome;
  if (terminal?.kind === "completed") return { status: "completed", phase: "complete" };
  if (terminal?.kind === "cancelled") return { status: "cancelled", phase: "complete", label: "Stopped" };
  if (terminal?.kind === "failed") return { status: "failed", phase: active.statusPhase };

  const messages = currentTurnMessages(active.chat.messages, active.turnId);
  const parts = messages.flatMap((message) => message.parts);
  if (parts.some((part) => isToolUIPart(part)
    && !isInternalServerToolName(getToolName(part))
    && toolLocation(part, getToolName(part)) === "vault"
    && getToolPartState(part) === "waiting-approval")) {
    return {
      status: "waiting",
      phase: "waiting",
      label: active.statusLabel || "Waiting for approval",
      waitingReason: "approval",
    };
  }
  if (active.executingToolIds.size > 0) {
    return {
      status: "waiting",
      phase: "waiting",
      label: active.statusLabel || "Working in your vault",
      waitingReason: "local_tool",
    };
  }
  return {
    status: "running",
    phase: active.statusPhase,
    label: active.statusLabel,
  };
}

export function freezeAgentSnapshot(
  snapshot: AgentConversationSnapshot,
): AgentConversationSnapshot {
  return Object.freeze({
    ...snapshot,
    messages: Object.freeze(snapshot.messages.map((message) => Object.freeze({
      ...message,
      partIds: Object.freeze([...message.partIds]),
    }))),
    parts: Object.freeze(snapshot.parts.map((part) => Object.freeze(part))),
  });
}

/**
 * Pure projection from the official AI SDK Chat state into the existing
 * Obsidian renderer model. It does not parse chunks or own stream lifecycle.
 */
export function projectThinAgentChat(
  active: ThinAgentProjectionState,
): AgentConversationSnapshot {
  const lifecycle = statusFromRun(active);
  const parts: AgentPart[] = [];
  const messages: AgentConversationSnapshot["messages"][number][] = [];
  const turnMessages = currentTurnMessages(active.chat.messages, active.turnId);
  const assistantMessages = turnMessages.filter((message) => message.role === "assistant");
  const finalAssistantId = assistantMessages[assistantMessages.length - 1]?.id;
  const sources = nativeSourceMarkdown(assistantMessages);
  let order = 0;

  for (const message of turnMessages) {
    if (message.role !== "assistant") continue;
    const partIds: string[] = [];
    message.parts.forEach((part, index) => {
      const id = isToolUIPart(part)
        ? `tool:${getToolCallId(part)}`
        : `${part.type}:${message.id}:${index}`;
      if (part.type === "text") {
        partIds.push(id);
        parts.push({
          id,
          kind: "text",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          markdown: part.text,
          order: order++,
        });
      } else if (part.type === "reasoning") {
        partIds.push(id);
        parts.push({
          id,
          kind: "reasoning",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          summary: part.text,
          order: order++,
        });
      } else if (isToolUIPart(part)) {
        const name = getToolName(part);
        if (isInternalServerToolName(name)) return;
        const callId = getToolCallId(part);
        const location = toolLocation(part, name);
        const approval = getToolApproval(part);
        const result = getToolPartState(part) === "complete"
          ? outputAsToolResult(getToolOutput(part))
          : undefined;
        const projectedTool = {
          callId,
          name,
          location,
          input: getToolInput(part),
        };
        partIds.push(id);
        parts.push({
          id,
          kind: "tool",
          messageId: message.id,
          ...projectedTool,
          state: toolState(part, active.executingToolIds.has(callId), location),
          ...(approval ? { approvalId: approval.id } : {}),
          ...(result ? { output: toolResultSummary(result, projectedTool) } : {}),
          ...(toolError(part) ? { error: toolError(part) } : {}),
          order: order++,
        });
      }
    });
    if (sources && message.id === finalAssistantId) {
      const id = `sources:${message.id}`;
      partIds.push(id);
      parts.push({
        id,
        kind: "text",
        messageId: message.id,
        state: "complete",
        markdown: sources,
        order: order++,
      });
    }
    messages.push(Object.freeze({
      id: message.id,
      role: "assistant",
      partIds: Object.freeze(partIds),
    }));
  }

  const terminalError = active.terminalOutcome?.kind === "failed"
    ? active.terminalOutcome.error
    : undefined;
  if (terminalError) {
    parts.push({
      id: `error:${active.turnId}`,
      kind: "error",
      error: terminalError,
      retryable: terminalError.retryable === true,
      retryMessageId: active.turnId,
      order: order++,
    });
  }
  return freezeAgentSnapshot({
    runId: active.runId,
    turnId: active.turnId,
    status: lifecycle.status,
    phase: lifecycle.phase,
    ...(lifecycle.label ? { statusLabel: lifecycle.label } : {}),
    ...(lifecycle.waitingReason ? { waitingReason: lifecycle.waitingReason } : {}),
    ...(terminalError ? { terminalError } : {}),
    messages: Object.freeze(messages),
    parts: Object.freeze(parts),
  });
}

function durableTool(part: AgentToolPart, timestamp: number): ToolCall {
  const result: ToolCallResult = part.state === "succeeded"
    ? { success: true, data: part.output?.data }
    : {
        success: false,
        ...(typeof part.output?.data === "undefined"
          ? {}
          : { data: part.output.data }),
        error: part.error ?? {
          code: part.state === "denied" ? "USER_DENIED" : "TOOL_EXECUTION_FAILED",
          message: part.state === "denied"
            ? "The user denied this vault action."
            : "The tool did not complete.",
        },
      };
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
    state: part.state === "succeeded" ? "completed" : "failed",
    timestamp,
    result,
    ...(part.location === "server" ? { executedOn: "server" as const } : {}),
  };
}

export function durableAssistant(
  snapshot: AgentConversationSnapshot,
  _chatMessages: readonly UIMessage[],
  now: number,
): ChatMessage {
  const messages = snapshot.messages.filter((message) => message.role === "assistant");
  const message = messages[messages.length - 1];
  if (!message) throw new Error("The server completed without an assistant message.");
  const wanted = new Set(messages.flatMap((candidate) => candidate.partIds));
  const ordered = snapshot.parts
    .filter((part) => wanted.has(part.id))
    .sort((left, right) => left.order - right.order);
  const messageParts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  for (const part of ordered) {
    const timestamp = now + part.order;
    if (part.kind === "text") {
      content += part.id.startsWith("sources:") && content
        ? `\n\n${part.markdown}`
        : part.markdown;
      messageParts.push({ id: part.id, type: "content", timestamp, data: part.markdown });
    } else if (part.kind === "reasoning") {
      messageParts.push({ id: part.id, type: "reasoning", timestamp, data: part.summary });
    } else if (part.kind === "tool") {
      if (isInternalServerToolName(part.name)) continue;
      const tool = durableTool(part, timestamp);
      toolCalls.push(tool);
      messageParts.push({ id: part.id, type: "tool_call", timestamp, data: tool });
    }
  }
  return {
    role: "assistant",
    content,
    message_id: message.id,
    ...(messageParts.length ? { messageParts } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function durableUserMessage(message: UIMessage): ChatMessage {
  const parts: MultiPartContent[] = [];
  let hasFile = false;
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "file") {
      hasFile = true;
      if (part.mediaType.startsWith("image/")) {
        parts.push({ type: "image_url", image_url: { url: part.url } });
      } else {
        const name = part.filename?.trim() || "attachment";
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

function durableAssistantMessage(
  message: UIMessage,
  now: number,
  sources: string,
): ChatMessage {
  const messageParts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  let order = 0;
  for (const part of message.parts) {
    const timestamp = now + order;
    if (part.type === "text") {
      content += part.text;
      messageParts.push({
        id: `text:${message.id}:${order}`,
        type: "content",
        timestamp,
        data: part.text,
      });
      order += 1;
    } else if (part.type === "reasoning") {
      messageParts.push({
        id: `reasoning:${message.id}:${order}`,
        type: "reasoning",
        timestamp,
        data: part.text,
      });
      order += 1;
    } else if (isToolUIPart(part)) {
      const name = getToolName(part);
      if (isInternalServerToolName(name)) continue;
      const state = getToolPartState(part);
      if (!["complete", "error", "denied"].includes(state)) {
        continue;
      }
      const callId = getToolCallId(part);
      const location = toolLocation(part, name);
      const result = state === "complete"
        ? outputAsToolResult(getToolOutput(part))
        : undefined;
      const projected: AgentToolPart = {
        id: `tool:${callId}`,
        kind: "tool",
        messageId: message.id,
        callId,
        name,
        location,
        input: getToolInput(part),
        state: toolState(part, false, location),
        ...(result ? {
          output: toolResultSummary(result, {
            callId,
            name,
            location,
            input: getToolInput(part),
          }),
        } : {}),
        ...(toolError(part) ? { error: toolError(part) } : {}),
        order,
      };
      const tool = durableTool(projected, timestamp);
      toolCalls.push(tool);
      messageParts.push({
        id: projected.id,
        type: "tool_call",
        timestamp,
        data: tool,
      });
      order += 1;
    }
  }
  if (sources) {
    messageParts.push({
      id: `sources:${message.id}`,
      type: "content",
      timestamp: now + order,
      data: sources,
    });
    content += content ? `\n\n${sources}` : sources;
  }
  return {
    role: "assistant",
    message_id: message.id,
    content,
    ...(messageParts.length ? { messageParts } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function durableServerHistory(
  messages: readonly UIMessage[],
  now: number,
): ChatMessage[] {
  const sourceMarkdownByIndex = new Map<number, string>();
  for (let index = 0; index < messages.length;) {
    if (messages[index].role !== "assistant") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < messages.length && messages[index].role === "assistant") index += 1;
    const sources = nativeSourceMarkdown(messages.slice(start, index));
    if (sources) sourceMarkdownByIndex.set(index - 1, sources);
  }
  return messages.flatMap((message, index) => {
    if (message.role === "user") return [durableUserMessage(message)];
    if (message.role !== "assistant") return [];
    return [durableAssistantMessage(
      message,
      now + index * 1_000,
      sourceMarkdownByIndex.get(index) ?? "",
    )];
  });
}
