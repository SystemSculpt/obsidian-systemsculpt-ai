import type { ChatMessage, MultiPartContent } from "../../types";
import type { ChatTranscriptSnapshot } from "../../views/chatview/transcript/ChatTranscriptTypes";
import type { ManagedToolDefinition } from "../../utils/tooling";
import type {
  AcceptedChatOperation,
  AcceptedManagedChatOperation,
  JsonContractValue,
} from "../managed/ManagedTypes";

export type ManagedPreparedMessage = Readonly<{
  readonly [key: string]: JsonContractValue;
}>;
export type AcceptedChatPolicyAudit = Readonly<{
  prompt: "none" | "selected";
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
  acceptedMessageCount: number;
  policy: AcceptedChatPolicyAudit;
}>;

export type AcceptedManagedChatRequestSnapshot =
  AcceptedChatRequestBase<AcceptedManagedChatOperation> &
  Readonly<{
    runtime: "managed";
    model: "ai-agent";
    messages: readonly ManagedPreparedMessage[];
    tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
    webSearch: boolean;
  }>;

export type AcceptedChatRequestSnapshot = AcceptedManagedChatRequestSnapshot;

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
  const wire: Record<string, JsonContractValue> = {
    role: message.role,
    content: contentToWire(message.content),
  };
  if (message.role === "tool" && message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  if (message.name) wire.name = message.name;
  if (message.reasoning) wire.reasoning_content = message.reasoning;
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
    acceptedMessageCount: operation.initialDurableSnapshot.messages.length,
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
  const messages = input.managedMessages.map(prepareManagedMessage);
  const tools = input.managedTools.map(prepareTool);
  const snapshot = {
    ...commonSnapshot(input.operation, input.policy),
    runtime: "managed" as const,
    model: "ai-agent" as const,
    messages,
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
  if (next.messages.length < accepted.acceptedMessageCount) {
    throw new Error("Continuation snapshot predates the accepted request.");
  }
  return next.messages.slice(accepted.acceptedMessageCount);
}

export function composeAcceptedChatContinuation(
  accepted: AcceptedManagedChatRequestSnapshot,
  next: ChatTranscriptSnapshot,
): readonly ManagedPreparedMessage[] {
  return deepFreezeAccepted([
    ...accepted.messages,
    ...continuationSuffix(accepted, next).map(prepareManagedMessage),
  ]);
}
