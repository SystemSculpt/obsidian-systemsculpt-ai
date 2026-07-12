import type { ChatMessage, MultiPartContent } from "../../types";
import type { ChatTranscriptSnapshot } from "../../views/chatview/transcript/ChatTranscriptTypes";
import type { AcceptedChatOperation, JsonContractValue } from "../managed/ManagedTypes";
import type { OpenAITool } from "../../utils/tooling";

export type ManagedPreparedMessage = Readonly<{ readonly [key: string]: JsonContractValue }>;
export type AcceptedChatPolicyAudit = Readonly<{
  prompt: "none" | "selected";
  contextCount: number;
  imageContextIncluded: boolean;
  documentContextIncluded: boolean;
  tools: "omitted" | "normalized";
}>;

export type AcceptedChatRequestSnapshot = Readonly<{
  operation: AcceptedChatOperation;
  durableTurnId: string;
  durableSnapshot: ChatTranscriptSnapshot;
  model: "ai-agent";
  policy: AcceptedChatPolicyAudit;
  messages: readonly ManagedPreparedMessage[];
  tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
}>;

function cloneJson(value: JsonContractValue): JsonContractValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, JsonContractValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item);
    return result;
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const child of Object.values(object)) deepFreeze(child, seen);
    Object.freeze(object);
  }
  return value;
}

function contentToWire(content: string | readonly MultiPartContent[] | null): JsonContractValue {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map<JsonContractValue>((part) => {
    if (part.type === "text") return { type: "text", text: part.text } as JsonContractValue;
    return { type: "image_url", image_url: { url: part.image_url.url } } as JsonContractValue;
  });
}

export function prepareManagedMessage(message: Readonly<ChatMessage>): ManagedPreparedMessage {
  const wire: Record<string, JsonContractValue> = { role: message.role, content: contentToWire(message.content) };
  if (message.role === "tool" && message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  if (message.name) wire.name = message.name;
  if (message.reasoning) wire.reasoning_content = message.reasoning;
  if (message.tool_calls?.length) wire.tool_calls = message.tool_calls.map((call) => ({
    id: call.id, type: "function", function: { name: call.request.function.name, arguments: call.request.function.arguments },
  }));
  return deepFreeze(cloneJson(wire) as ManagedPreparedMessage);
}

function prepareTool(tool: OpenAITool): Readonly<{ [key: string]: JsonContractValue }> {
  return deepFreeze(cloneJson(tool as JsonContractValue) as Readonly<{ [key: string]: JsonContractValue }>);
}

export function createAcceptedChatRequestSnapshot(input: Readonly<{
  operation: AcceptedChatOperation;
  preparedMessages: readonly Readonly<ChatMessage>[];
  tools: readonly OpenAITool[];
  policy: AcceptedChatPolicyAudit;
}>): AcceptedChatRequestSnapshot {
  const snapshot = {
    durableTurnId: input.operation.durableTurnId,
    durableSnapshot: input.operation.initialDurableSnapshot,
    model: "ai-agent" as const,
    policy: { ...input.policy },
    messages: input.preparedMessages.map(prepareManagedMessage),
    ...(input.tools.length > 0 ? { tools: input.tools.map(prepareTool) } : {}),
  } as unknown as AcceptedChatRequestSnapshot;
  Object.defineProperty(snapshot, "operation", { value: input.operation, enumerable: false, writable: false, configurable: false });
  return deepFreeze(snapshot);
}

export function composeAcceptedChatContinuation(
  accepted: AcceptedChatRequestSnapshot,
  postCheckpointDurableSnapshot: ChatTranscriptSnapshot,
): readonly ManagedPreparedMessage[] {
  void accepted;
  return deepFreeze(postCheckpointDurableSnapshot.messages.map(prepareManagedMessage));
}
