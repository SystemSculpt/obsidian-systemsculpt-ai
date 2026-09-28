import { parseThinAgentDataPart, type ThinAgentRunTerminalData } from "../../services/managed/ThinAgentV1Contract";
import type { ToolCallResult } from "../../types/toolCalls";
import type { ManagedAgentError } from "../ChatConversation";
import { isFirstPartyToolName } from "../../tools/toolNames";
import { canonicalAgentToolInput } from "./MutationJournal";
import type { AgentJsonValue } from "./Protocol";


export type WirePart = Readonly<Record<string, unknown> & { type: string }>;

export type WireMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly WirePart[];
}>;

export type LocalToolCall = Readonly<{
  callId: string;
  name: string;
  input: AgentJsonValue;
}>;

export type ToolTarget = Readonly<{
  name: string;
  input: AgentJsonValue;
}>;

export type ToolTargetMap = ReadonlyMap<string, ToolTarget>;

export type ProjectedTool = Readonly<{
  callId: string;
  name: string;
  input: AgentJsonValue;
  location: "server" | "vault";
  part: WirePart;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWirePart(value: unknown): value is WirePart {
  return isRecord(value)
    && typeof value.type === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.type);
}

export function isWireMessage(value: unknown): value is WireMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && SAFE_ID.test(value.id)
    && (value.role === "user" || value.role === "assistant")
    && Array.isArray(value.parts)
    && value.parts.length <= 2_048
    && value.parts.every(isWirePart);
}

export function terminalError(terminal: Extract<ThinAgentRunTerminalData, { outcome: "failed" }>): ManagedAgentError {
  const incidentId = /^incident_(?!0{32}$)[a-f0-9]{32}$/u.test(terminal.incident_id)
    ? terminal.incident_id
    : undefined;
  return {
    code: terminal.code,
    message: "SystemSculpt could not complete the response.",
    ...(incidentId ? { requestId: incidentId } : {}),
    retryable: terminal.retryable,
    ...(incidentId ? { incidentId } : {}),
  };
}

export function currentTurnMessages(
  messages: readonly WireMessage[],
  turnId: string,
): readonly WireMessage[] {
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

export function toolCallId(part: WirePart): string | null {
  return typeof part.toolCallId === "string" && part.toolCallId.length > 0
    ? part.toolCallId
    : null;
}

export function toolName(part: WirePart): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName.length > 0
      ? part.toolName
      : null;
  }
  return part.type.startsWith("tool-") && part.type.length > 5
    ? part.type.slice(5)
    : null;
}

export function toolInput(part: WirePart): AgentJsonValue {
  return toJsonValue(part.input ?? null);
}

export function toolOutput(part: WirePart): unknown {
  return part.output;
}

export function toolApproval(part: WirePart): Readonly<{ id: string; approved?: boolean }> | null {
  if (!isRecord(part.approval) || typeof part.approval.id !== "string") return null;
  return {
    id: part.approval.id,
    ...(typeof part.approval.approved === "boolean"
      ? { approved: part.approval.approved }
      : {}),
  };
}

export function collectClientToolTargets(messages: readonly WireMessage[]): ToolTargetMap {
  // The provider stream assembles a tool part when its input STARTS streaming,
  // while the explicit client-tool request part is appended once the input is
  // complete — so within one authoritative message the tool part usually
  // precedes its request part. Authorization therefore runs in two passes:
  // every request part is gathered first, then tool parts are matched against
  // them, so intra-message part order can never demote a requested vault tool
  // to server-owned.
  const requested = new Map<string, ToolTarget>();
  const authorized = new Map<string, ToolTarget>();
  const serverOwned = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const parsed = parseThinAgentDataPart(part);
      if (
        parsed?.kind !== "known"
        || parsed.type !== "data-systemsculpt-client-tool-request"
      ) continue;
      const callId = parsed.data.tool_call_id;
      const name = parsed.data.tool_name;
      const existing = requested.get(callId);
      if (
        serverOwned.has(callId)
        || !isFirstPartyToolName(name)
        || (existing && (
          existing.name !== name
          || canonicalAgentToolInput(existing.input)
            !== canonicalAgentToolInput(parsed.data.input)
        ))
      ) {
        requested.delete(callId);
        serverOwned.add(callId);
      } else {
        requested.set(callId, Object.freeze({ name, input: parsed.data.input }));
      }
    }
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (parseThinAgentDataPart(part)?.kind === "known") continue;
      const callId = toolCallId(part);
      const name = toolName(part);
      if (!callId || !name) continue;
      const target = requested.get(callId);
      if (
        serverOwned.has(callId)
        || !isFirstPartyToolName(name)
        || !target
        || target.name !== name
      ) {
        requested.delete(callId);
        authorized.delete(callId);
        serverOwned.add(callId);
      } else {
        authorized.set(callId, target);
      }
    }
  }
  return authorized;
}

export function canonicalTools(
  messages: readonly WireMessage[],
  targets: ToolTargetMap,
): ReadonlyMap<string, ProjectedTool & { messageId: string; partIndex: number }> {
  const tools = new Map<string, ProjectedTool & { messageId: string; partIndex: number }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.parts.forEach((part, partIndex) => {
      const callId = toolCallId(part);
      const name = toolName(part);
      if (!callId || !name) return;
      const target = targets.get(callId);
      const projected = {
        callId,
        name,
        input: target?.input ?? toolInput(part),
        location: target?.name === name ? "vault" as const : "server" as const,
        part,
        messageId: message.id,
        partIndex,
      };
      const current = tools.get(callId);
      if (!current || toolStateRank(part) >= toolStateRank(current.part)) {
        tools.set(callId, current
          ? { ...projected, messageId: current.messageId, partIndex: current.partIndex }
          : projected);
      }
    });
  }
  return tools;
}

function toolStateRank(part: WirePart): number {
  switch (part.state) {
    case "input-streaming": return 0;
    case "input-available": return 1;
    case "approval-requested": return 2;
    case "approval-responded": return 3;
    case "output-available":
      return part.preliminary === true ? 4 : 5;
    case "output-denied":
    case "output-error":
      return 5;
    default:
      return 0;
  }
}

export function isAuthoritativeTerminalToolPart(part: WirePart): boolean {
  return part.state === "output-error"
    || part.state === "output-denied"
    || (part.state === "output-available" && part.preliminary !== true);
}

export function outputAsToolResult(output: unknown): ToolCallResult {
  return isRecord(output) && typeof output.success === "boolean"
    ? output as unknown as ToolCallResult
    : { success: true, data: output };
}

function sanitizeVaultResultData(
  value: AgentJsonValue,
  key = "",
): AgentJsonValue {
  if (
    typeof value === "string"
    && /^(?:cause|error(?:s|Text)?|message(?:s)?|reason(?:s)?|stack)$/i.test(key)
  ) return "The vault action failed.";
  if (Array.isArray(value)) {
    // Keep the owning field while walking an array. Otherwise a structured
    // payload such as `open.errors: ["/private/vault failure"]` loses the
    // `errors` key at the array boundary and leaks raw local failure text.
    // Entries remain in place so safe counts and sibling path metadata keep
    // their exact shape for Partial/Failed presentation.
    return value.map((entry) => sanitizeVaultResultData(entry, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeVaultResultData(entry, entryKey),
    ]));
  }
  return value;
}

export function safeOutboundVaultToolResult(result: ToolCallResult): ToolCallResult {
  const data = result.data === undefined
    ? undefined
    : sanitizeVaultResultData(toJsonValue(result.data));
  if (result.success) {
    return {
      success: true,
      ...(data !== undefined ? { data } : {}),
    };
  }
  return {
    success: false,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: "The vault action failed.",
    },
    ...(data !== undefined ? { data } : {}),
  };
}

// Must not exceed the protocol codec's MAX_JSON_DEPTH: content beyond the
// protocol bound drops here so a deep result degrades instead of failing the
// whole client_tool_result command at encode time.
const TOOL_JSON_MAX_DEPTH = 16;
const OMITTED_JSON_VALUE = Symbol("systemsculpt-omitted-json-value");

/**
 * Tool results are arbitrary JavaScript values produced by local tool
 * implementations, so this boundary must mirror JSON.stringify semantics
 * rather than throw: an undefined optional field, a NaN, a Date, a function,
 * or a cycle anywhere in a result must never fail the whole tool delivery.
 * Undefined, functions, symbols, bigints, and cyclic references drop from
 * records and become null in arrays; non-finite numbers become null; toJSON
 * is honored.
 */
export function toJsonValue(value: unknown): AgentJsonValue {
  const cloned = jsonSafeClone(value, new WeakSet(), 0, false);
  return cloned === OMITTED_JSON_VALUE ? null : cloned;
}

function jsonSafeClone(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  skipToJson: boolean,
): AgentJsonValue | typeof OMITTED_JSON_VALUE {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") return OMITTED_JSON_VALUE;
  if (ancestors.has(value) || depth >= TOOL_JSON_MAX_DEPTH) return OMITTED_JSON_VALUE;
  if (!skipToJson) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      try {
        return jsonSafeClone(toJson.call(value), ancestors, depth, true);
      } catch {
        return OMITTED_JSON_VALUE;
      }
    }
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => {
        const cloned = jsonSafeClone(entry, ancestors, depth + 1, false);
        return cloned === OMITTED_JSON_VALUE ? null : cloned;
      }));
    }
    const output: Record<string, AgentJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = jsonSafeClone(entry, ancestors, depth + 1, false);
      if (cloned !== OMITTED_JSON_VALUE) output[key] = cloned;
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

export function terminalFromMessages(
  messages: readonly WireMessage[],
  rootMessageId: string,
  runId?: string | null,
): ThinAgentRunTerminalData | null {
  const turn = currentTurnMessages(messages, rootMessageId);
  for (let messageIndex = turn.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = turn[messageIndex];
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const parsed = parseThinAgentDataPart(message.parts[partIndex]);
      if (
        parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal"
        && parsed.data.root_message_id === rootMessageId
        && (!runId || parsed.data.run_id === runId)
      ) return parsed.data;
    }
  }
  return null;
}

export function latestUserId(messages: readonly WireMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id;
  }
  return null;
}