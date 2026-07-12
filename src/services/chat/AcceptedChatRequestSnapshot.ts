import type { ChatMessage, MultiPartContent } from "../../types";
import type { ChatTranscriptSnapshot } from "../../views/chatview/transcript/ChatTranscriptTypes";
import type { PreparedChatRequest } from "../StreamExecutionTypes";
import type { AcceptedChatOperation, JsonContractValue } from "../managed/ManagedTypes";
import type { AuthoritativeChatPreparation, ChatPreparationDiagnostic, ChatPreparationNotice } from "./ChatRequestPreparationService";

export type ManagedPreparedMessage = Readonly<{ readonly [key: string]: JsonContractValue }>;
export type AcceptedChatPolicyAudit = Readonly<{
  prompt: "none" | "selected"; contextCount: number; imageContextIncluded: boolean;
  documentContextIncluded: boolean; tools: "omitted" | "normalized";
}>;
export type FrozenPreparedChatRequest = Readonly<Omit<PreparedChatRequest, "preparedMessages" | "tools"> & {
  preparedMessages: readonly Readonly<ChatMessage>[];
  tools: readonly PreparedChatRequest["tools"][number][];
}>;
export type AcceptedChatRequestSnapshot = Readonly<{
  operation: AcceptedChatOperation;
  durableTurnId: string;
  durableSnapshot: ChatTranscriptSnapshot;
  acceptedMessageCount: number;
  model: "ai-agent";
  policy: AcceptedChatPolicyAudit;
  legacyPreparation: FrozenPreparedChatRequest;
  notices: readonly ChatPreparationNotice[];
  diagnostics: readonly ChatPreparationDiagnostic[];
  messages: readonly ManagedPreparedMessage[];
  tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
}>;

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
function contentToWire(content: string | readonly MultiPartContent[] | null): JsonContractValue {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map<JsonContractValue>((part) => part.type === "text"
    ? { type: "text", text: part.text } as JsonContractValue
    : { type: "image_url", image_url: { url: part.image_url.url } } as JsonContractValue);
}
export function prepareManagedMessage(message: Readonly<ChatMessage>): ManagedPreparedMessage {
  const wire: Record<string, JsonContractValue> = { role: message.role, content: contentToWire(message.content) };
  if (message.role === "tool" && message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  if (message.name) wire.name = message.name;
  if (message.reasoning) wire.reasoning_content = message.reasoning;
  if (message.tool_calls?.length) wire.tool_calls = message.tool_calls.map((call) => ({
    id: call.id, type: "function", function: { name: call.request.function.name, arguments: call.request.function.arguments },
  }));
  return deepFreezeAccepted(deepCopy(wire));
}
function prepareTool(tool: PreparedChatRequest["tools"][number]): Readonly<{ [key: string]: JsonContractValue }> {
  return deepFreezeAccepted(deepCopy(tool) as Readonly<{ [key: string]: JsonContractValue }>);
}
export function createAcceptedChatRequestSnapshot(input: Readonly<{
  operation: AcceptedChatOperation; preparation: AuthoritativeChatPreparation; policy: AcceptedChatPolicyAudit;
  managedMessages?: readonly Readonly<ChatMessage>[];
  managedTools?: readonly PreparedChatRequest["tools"][number][];
}>): AcceptedChatRequestSnapshot {
  const legacyPreparation = deepFreezeAccepted(deepCopy(input.preparation.prepared) as FrozenPreparedChatRequest);
  const snapshot = {
    durableTurnId: input.operation.durableTurnId,
    durableSnapshot: input.operation.initialDurableSnapshot,
    acceptedMessageCount: input.operation.initialDurableSnapshot.messages.length,
    model: "ai-agent" as const,
    policy: deepCopy(input.policy), legacyPreparation,
    notices: deepCopy(input.preparation.notices), diagnostics: deepCopy(input.preparation.diagnostics),
    messages: (input.managedMessages ?? legacyPreparation.preparedMessages).map(prepareManagedMessage),
    ...((input.managedTools ?? legacyPreparation.tools).length ? { tools: (input.managedTools ?? legacyPreparation.tools).map(prepareTool) } : {}),
  } as unknown as AcceptedChatRequestSnapshot;
  Object.defineProperty(snapshot, "operation", { value: input.operation, enumerable: false, writable: false, configurable: false });
  return deepFreezeAccepted(snapshot);
}
function continuationSuffix(accepted: AcceptedChatRequestSnapshot, next: ChatTranscriptSnapshot): readonly Readonly<ChatMessage>[] {
  if (next.messages.length < accepted.acceptedMessageCount) throw new Error("Continuation snapshot predates the accepted request.");
  return next.messages.slice(accepted.acceptedMessageCount);
}
export function composeAcceptedChatContinuation(accepted: AcceptedChatRequestSnapshot, next: ChatTranscriptSnapshot): readonly ManagedPreparedMessage[] {
  return deepFreezeAccepted([...accepted.messages, ...continuationSuffix(accepted, next).map(prepareManagedMessage)]);
}
export function composeAcceptedLegacyContinuation(
  accepted: AcceptedChatRequestSnapshot,
  next: ChatTranscriptSnapshot,
): FrozenPreparedChatRequest {
  const preparedMessages = [
    ...deepCopy(accepted.legacyPreparation.preparedMessages), ...deepCopy(continuationSuffix(accepted, next)),
  ];
  return deepFreezeAccepted({ ...deepCopy(accepted.legacyPreparation), preparedMessages } as FrozenPreparedChatRequest);
}
