import type { ChatMessage } from "../../types";
import type { AgentConversationSnapshot } from "../../chat/ChatConversation";
import { readManagedToolCallFunction } from "../../chat/managed/ManagedToolExecution";
import { isMutatingTool } from "../../utils/toolPolicy";

function historicalReplayToolOccurrences(
  message: Readonly<ChatMessage>,
): readonly NonNullable<ChatMessage["tool_calls"]>[number][] {
  const tools = [...(message.tool_calls ?? [])];
  for (const part of message.messageParts ?? []) {
    if (part.type === "tool_call") tools.push(part.data);
  }
  return tools;
}

export function cachedTranscriptRecoverySnapshot(
  messages: readonly Readonly<ChatMessage>[],
): AgentConversationSnapshot | null {
  const hasCachedExecutingTool = messages.some((message) =>
    historicalReplayToolOccurrences(message).some((tool) => tool.state === "executing"));
  if (!hasCachedExecutingTool) return null;
  return Object.freeze({
    runId: null,
    turnId: null,
    status: "running",
    phase: "retrying",
    statusLabel: "Recovering",
    messages: Object.freeze([]),
    parts: Object.freeze([]),
  });
}

function historicalReplayToolSignature(
  tool: NonNullable<ChatMessage["tool_calls"]>[number],
): string | null {
  const fn = readManagedToolCallFunction(tool);
  try {
    return JSON.stringify({
      functionName: fn?.name ?? null,
      functionArguments: fn?.arguments ?? null,
      state: typeof tool.state === "string" ? tool.state : null,
      result: tool.result ?? null,
      executedOn: "executedOn" in tool ? tool.executedOn ?? null : null,
    });
  } catch {
    return null;
  }
}

export function historicalResubmitConsequences(
  messages: readonly Readonly<ChatMessage>[],
  targetIndex: number,
): Readonly<{ laterMessageCount: number; requiresReplayConfirmation: boolean }> {
  const laterMessages = messages.slice(targetIndex + 1)
    .filter((message) => message.role === "user" || message.role === "assistant");
  const tools: NonNullable<ChatMessage["tool_calls"]>[number][] = [];
  const seenToolIds = new Set<string>();
  let hasAmbiguousReplayHistory = false;
  for (const message of laterMessages) {
    const messageTools = new Map<string, {
      tool: NonNullable<ChatMessage["tool_calls"]>[number];
      signature: string;
    }>();
    for (const tool of historicalReplayToolOccurrences(message)) {
      const toolId = typeof tool.id === "string" ? tool.id.trim() : "";
      if (!toolId || seenToolIds.has(toolId)) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      const signature = historicalReplayToolSignature(tool);
      if (signature === null) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      const existing = messageTools.get(toolId);
      if (existing) {
        if (existing.signature !== signature) hasAmbiguousReplayHistory = true;
        continue;
      }
      messageTools.set(toolId, { tool, signature });
    }
    for (const [toolId, entry] of messageTools) {
      if (!toolId || seenToolIds.has(toolId)) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      seenToolIds.add(toolId);
      tools.push(entry.tool);
    }
  }
  const explicitlyDidNotStart = new Set([
    "USER_DENIED",
    "TOOL_CANCELLED_BEFORE_START",
  ]);
  const requiresReplayConfirmation = hasAmbiguousReplayHistory || tools.some((tool) => {
    const name = readManagedToolCallFunction(tool)?.name;
    if (!name) return true;
    if (!isMutatingTool(name)) return false;
    const code = tool.result?.error?.code;
    return !code || !explicitlyDidNotStart.has(String(code));
  });
  let laterMessageCount = 0;
  for (let index = 0; index < laterMessages.length;) {
    laterMessageCount += 1;
    if (laterMessages[index].role !== "assistant") {
      index += 1;
      continue;
    }
    // The renderer presents consecutive assistant protocol records as one
    // response. Keep edit/resubmit consequences in those same user-visible
    // units instead of counting reasoning, tool, and answer records
    // separately.
    do { index += 1; }
    while (index < laterMessages.length && laterMessages[index].role === "assistant");
  }
  return {
    laterMessageCount,
    requiresReplayConfirmation,
  };
}

export function terminalLiveResubmitConsequences(
  snapshot: AgentConversationSnapshot | null,
  targetTurnId: string,
  laterMessages: readonly Readonly<ChatMessage>[],
): Readonly<{ laterMessageCount: number; requiresReplayConfirmation: boolean }> {
  if (
    !snapshot
    || snapshot.turnId !== targetTurnId
    || (
      snapshot.status !== "completed"
      && snapshot.status !== "cancelled"
      && snapshot.status !== "failed"
    )
  ) {
    return { laterMessageCount: 0, requiresReplayConfirmation: false };
  }
  const durableMessageIds = new Set(
    laterMessages.map((message) => message.message_id),
  );
  const hasUnpersistedProjection = snapshot.messages.some((message) =>
    !durableMessageIds.has(message.id));
  if (!hasUnpersistedProjection && snapshot.messages.length > 0) {
    return { laterMessageCount: 0, requiresReplayConfirmation: false };
  }
  const explicitlyDidNotStart = new Set([
    "USER_DENIED",
    "TOOL_CANCELLED_BEFORE_START",
  ]);
  const relevantParts = snapshot.parts.filter((part) =>
    part.kind !== "error" && (
      snapshot.messages.length === 0
      || snapshot.messages.some((message) => message.partIds.includes(part.id))
    ));
  const requiresReplayConfirmation = relevantParts.some((part) => {
    if (
      part.kind !== "tool"
      || part.location !== "vault"
      || !isMutatingTool(part.name)
    ) return false;
    const code = part.error?.code;
    if (part.state === "denied") return false;
    if (code && explicitlyDidNotStart.has(code)) return false;
    return true;
  });
  return {
    laterMessageCount: relevantParts.length > 0 ? 1 : 0,
    requiresReplayConfirmation,
  };
}
