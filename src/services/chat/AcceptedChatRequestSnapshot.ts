import type { ChatMessage, MultiPartContent } from "../../types";
import type { AgentTranscriptSnapshot as ChatTranscriptSnapshot } from "../../views/chatview/AgentTranscriptRepository";
import type { ManagedToolDefinition } from "../../utils/tooling";
import type {
  AcceptedChatOperation,
  AcceptedManagedChatOperation,
  JsonContractValue,
} from "../managed/ManagedTypes";
import { managedToolResultMessage } from "./ManagedToolResult";

export type ManagedPreparedMessage = Readonly<{
  readonly [key: string]: JsonContractValue;
}>;
export type AcceptedChatPolicyAudit = Readonly<{
  contextCount: number;
  imageContextIncluded: boolean;
  documentContextIncluded: boolean;
  tools: "omitted" | "normalized";
}>;
type AcceptedChatRequestBase<TOperation extends AcceptedChatOperation> = Readonly<{
  runtime: TOperation["runtime"];
  operation: TOperation;
  durableTurnId: string;
  durableSnapshot: ChatTranscriptSnapshot;
  /**
   * Stable boundary in the durable/continuation message space. Request
   * preparation may inject context and expand compact tool history, so a raw
   * array length is not a valid continuation cursor.
   */
  continuationBoundaryMessageId: string;
  policy: AcceptedChatPolicyAudit;
}>;

export type AcceptedManagedChatRequestSnapshot =
  AcceptedChatRequestBase<AcceptedManagedChatOperation> &
  Readonly<{
    runtime: "managed";
    model: "ai-agent";
    messages: readonly ManagedPreparedMessage[];
    /** Context injected for this turn followed by the accepted user message. */
    turnMessages: readonly ManagedPreparedMessage[];
    tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
    webSearch: boolean;
  }>;

export type AcceptedChatRequestSnapshot = AcceptedManagedChatRequestSnapshot;

function stableContractJson(value: JsonContractValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableContractJson).join(",")}]`;
  const object = value as Readonly<Record<string, JsonContractValue>>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableContractJson(object[key])}`,
  ).join(",")}}`;
}

/** Identifies the exact vault-tool contract pinned by a managed server session. */
export function managedToolsetFingerprint(
  tools: AcceptedManagedChatRequestSnapshot["tools"] = [],
): string {
  const serialized = stableContractJson(tools as JsonContractValue);
  let fnv = 2166136261 >>> 0;
  let djb = 5381 >>> 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  return `${serialized.length}:${fnv.toString(16)}:${djb.toString(16)}`;
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepCopy) as T;
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = deepCopy(item);
    return result as T;
  }
  return value;
}

export function deepFreezeAccepted<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const child of Object.values(object)) deepFreezeAccepted(child, seen);
    Object.freeze(object);
  }
  return value;
}

function contentToWire(
  content: string | readonly MultiPartContent[] | null,
): JsonContractValue {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map<JsonContractValue>((part) =>
    part.type === "text"
      ? ({ type: "text", text: part.text } as JsonContractValue)
      : ({
          type: "image_url",
          image_url: { url: part.image_url.url },
        } as JsonContractValue),
  );
}

export function prepareManagedMessage(
  message: Readonly<ChatMessage>,
): ManagedPreparedMessage {
  if (message.role === "system") {
    throw new Error("Client-owned system messages are not part of managed chat requests.");
  }
  const wire: Record<string, JsonContractValue> = {
    role: message.role,
    content: contentToWire(message.content),
  };
  if (message.role === "tool") {
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
    if (message.name) wire.name = message.name;
  }
  if (message.tool_calls?.length) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.request.function.name,
        arguments: call.request.function.arguments,
      },
    }));
  }
  return deepFreezeAccepted(deepCopy(wire));
}

function settledToolResultMessages(
  assistant: Readonly<ChatMessage>,
): readonly ManagedPreparedMessage[] {
  if (assistant.role !== "assistant" || !assistant.tool_calls?.length) return [];
  if (assistant.tool_calls.some((call) => call.state !== "completed" && call.state !== "failed")) {
    throw new Error("Managed history contains an unsettled tool call.");
  }
  return assistant.tool_calls.map((call) =>
    prepareManagedMessage(managedToolResultMessage(call, assistant.message_id)),
  );
}

/** Projects the compact durable transcript into the canonical agent wire sequence. */
export function projectManagedMessages(
  messages: readonly Readonly<ChatMessage>[],
): readonly ManagedPreparedMessage[] {
  const projected: ManagedPreparedMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    projected.push(prepareManagedMessage(message));
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const expectedIds = new Set(message.tool_calls.map((call) => call.id));
    const explicitResults: Readonly<ChatMessage>[] = [];
    for (let cursor = index + 1; cursor < messages.length && messages[cursor].role === "tool"; cursor += 1) {
      explicitResults.push(messages[cursor]);
    }
    const explicitIds = new Set(explicitResults.map((result) => result.tool_call_id));
    const hasExactExplicitResults = explicitResults.length === expectedIds.size
      && explicitResults.every((result) => !!result.tool_call_id && expectedIds.has(result.tool_call_id))
      && explicitIds.size === expectedIds.size;
    if (explicitResults.length > 0 && !hasExactExplicitResults) {
      throw new Error("Managed history contains a partial or mismatched explicit tool-result batch.");
    }
    if (!hasExactExplicitResults) projected.push(...settledToolResultMessages(message));
  }
  return deepFreezeAccepted(projected);
}

function prepareTool(
  tool: ManagedToolDefinition,
): Readonly<{ [key: string]: JsonContractValue }> {
  return deepFreezeAccepted(
    deepCopy(tool) as Readonly<{ [key: string]: JsonContractValue }>,
  );
}

function commonSnapshot<TOperation extends AcceptedChatOperation>(
  operation: TOperation,
  policy: AcceptedChatPolicyAudit,
) {
  return {
    runtime: operation.runtime,
    durableTurnId: operation.durableTurnId,
    durableSnapshot: operation.initialDurableSnapshot,
    continuationBoundaryMessageId: operation.durableTurnId,
    policy: deepCopy(policy),
  };
}

function attachOperation<TOperation extends AcceptedChatOperation, TSnapshot extends object>(
  snapshot: TSnapshot,
  operation: TOperation,
): TSnapshot & { readonly operation: TOperation } {
  Object.defineProperty(snapshot, "operation", {
    value: operation,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return snapshot as TSnapshot & { readonly operation: TOperation };
}

export function createAcceptedManagedChatRequestSnapshot(input: Readonly<{
  operation: AcceptedManagedChatOperation;
  policy: AcceptedChatPolicyAudit;
  managedMessages: readonly Readonly<ChatMessage>[];
  managedTools: readonly ManagedToolDefinition[];
  webSearch: boolean;
}>): AcceptedManagedChatRequestSnapshot {
  const clientMessages = input.managedMessages.filter((message) => message.role !== "system");
  const boundaries = clientMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.message_id === input.operation.durableTurnId);
  if (boundaries.length !== 1 || boundaries[0].message.role !== "user") {
    throw new Error("Prepared Chat messages do not contain one accepted user-turn boundary.");
  }
  let turnStart = boundaries[0].index;
  while (turnStart > 0) {
    const previous = clientMessages[turnStart - 1];
    if (previous.role !== "user" || !String(previous.message_id ?? "").startsWith("ctx_")) break;
    turnStart -= 1;
  }
  const messages = projectManagedMessages(clientMessages);
  const turnMessages = projectManagedMessages(
    clientMessages.slice(turnStart, boundaries[0].index + 1),
  );
  const tools = input.managedTools.map(prepareTool);
  const snapshot = {
    ...commonSnapshot(input.operation, input.policy),
    runtime: "managed" as const,
    model: "ai-agent" as const,
    messages,
    turnMessages,
    webSearch: input.webSearch,
    ...(tools.length ? { tools } : {}),
  };
  return deepFreezeAccepted(
    attachOperation(snapshot, input.operation),
  ) as AcceptedManagedChatRequestSnapshot;
}

function continuationSuffix(
  accepted: AcceptedManagedChatRequestSnapshot,
  next: ChatTranscriptSnapshot,
): readonly Readonly<ChatMessage>[] {
  const matchingBoundaries = next.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.message_id === accepted.continuationBoundaryMessageId);
  if (matchingBoundaries.length !== 1 || matchingBoundaries[0].message.role !== "user") {
    throw new Error("Continuation snapshot does not contain one accepted user-turn boundary.");
  }
  return next.messages.slice(matchingBoundaries[0].index + 1);
}

export function composeAcceptedChatContinuation(
  accepted: AcceptedManagedChatRequestSnapshot,
  next: ChatTranscriptSnapshot,
): readonly ManagedPreparedMessage[] {
  return deepFreezeAccepted([
    ...accepted.messages,
    ...projectManagedMessages(continuationSuffix(accepted, next)),
  ]);
}

/** Only tool-result rows are new to a resumed server session. */
export function composeAcceptedChatContinuationDelta(
  accepted: AcceptedManagedChatRequestSnapshot,
  next: ChatTranscriptSnapshot,
): readonly ManagedPreparedMessage[] {
  const suffix = continuationSuffix(accepted, next);
  let latestAssistantIndex = -1;
  for (let index = suffix.length - 1; index >= 0; index -= 1) {
    if (suffix[index].role === "assistant") {
      latestAssistantIndex = index;
      break;
    }
  }
  const assistant = latestAssistantIndex >= 0 ? suffix[latestAssistantIndex] : undefined;
  const currentToolResults = suffix.slice(latestAssistantIndex + 1)
    .filter((message) => message.role !== "system");
  if (
    latestAssistantIndex < 0
    || assistant?.role !== "assistant"
    || !assistant.tool_calls?.length
    || currentToolResults.some((message) => message.role !== "tool")
  ) {
    throw new Error("Continuation snapshot does not end with one completed tool-result batch.");
  }
  if (currentToolResults.length > 0) {
    return deepFreezeAccepted(currentToolResults.map(prepareManagedMessage));
  }
  return deepFreezeAccepted(settledToolResultMessages(assistant));
}
