import type { ManagedPreparedMessage } from "../chat/AcceptedChatRequestSnapshot";
import { MAX_MANAGED_TOOL_RESULT_BYTES } from "../chat/ManagedToolResult";
import type {
  JsonContractValue,
  ManagedCapabilityDescriptor,
  ManagedChatSessionBudgetState,
} from "./ManagedTypes";

type JsonObject = Readonly<Record<string, JsonContractValue>>;

export type ManagedChatBudgetIssueCode =
  | "local_contract_invalid"
  | "local_transcript_invalid"
  | "local_attachment_unavailable"
  | "local_delta_message_limit"
  | "local_delta_attachment_limit"
  | "local_rebase_message_limit"
  | "local_rebase_attachment_limit"
  | "local_rebase_text_limit"
  | "local_tool_contract_limit"
  | "local_tool_batch_limit"
  | "local_session_message_limit"
  | "local_session_image_limit"
  | "local_session_attachment_limit"
  | "local_session_stored_json_limit";

export type ManagedChatBudgetIssue = Readonly<{
  code: ManagedChatBudgetIssueCode;
  message: string;
}>;

export type ManagedChatDispatchBudget = Readonly<{
  createIssue: ManagedChatBudgetIssue | null;
  resumeIssue: ManagedChatBudgetIssue | null;
}>;

export type ManagedToolContinuationBudget = Readonly<{
  issue: ManagedChatBudgetIssue | null;
  rotateSession: boolean;
}>;

type ManagedChatSessionLimits = Readonly<{
  maxMessagesOnCreate: number;
  maxMessagesPerDelta: number;
  maxSessionMessages: number;
  maxContentBlocksPerMessage: number;
  maxImagesPerTurn: number;
  maxImagesOnCreate: number;
  maxSessionImages: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxTotalImageBytesOnCreate: number;
  maxTextBytesPerBlock: number;
  maxTotalTextBytes: number;
  maxTotalTextBytesOnCreate: number;
  maxTools: number;
  maxToolsJsonBytes: number;
  maxSessionAttachmentBytes: number;
  maxSessionStoredJsonBytes: number;
}>;

type MessageStats = Readonly<{
  role: "user" | "assistant" | "tool";
  contentBlocks: number;
  imageCount: number;
  imageBytes: number;
  textBytes: number;
  maxImageBytes: number;
  maxTextBlockBytes: number;
}>;

type MutableTurnStats = {
  imageCount: number;
  imageBytes: number;
  textBytes: number;
};

type TranscriptStats = Readonly<{
  messages: readonly MessageStats[];
  messageCount: number;
  imageCount: number;
  imageBytes: number;
  textBytes: number;
  storedJsonBytes: number;
  turns: readonly Readonly<MutableTurnStats>[];
}>;

type ToolResultReservation = Readonly<{ id: string; name: string }>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const UTF8 = new TextEncoder();

function issue(code: ManagedChatBudgetIssueCode, message: string): ManagedChatBudgetIssue {
  return Object.freeze({ code, message });
}

function positiveLimit(
  source: ManagedCapabilityDescriptor["limits"],
  key: string,
): number {
  const value = source[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Managed chat has an invalid ${key} limit.`);
  }
  return value as number;
}

function sessionLimits(source: ManagedCapabilityDescriptor["limits"]): ManagedChatSessionLimits {
  return Object.freeze({
    maxMessagesOnCreate: positiveLimit(source, "max_messages_on_create"),
    maxMessagesPerDelta: positiveLimit(source, "max_messages_per_delta"),
    maxSessionMessages: positiveLimit(source, "max_session_messages"),
    maxContentBlocksPerMessage: positiveLimit(source, "max_content_blocks_per_message"),
    maxImagesPerTurn: positiveLimit(source, "max_images_per_turn"),
    maxImagesOnCreate: positiveLimit(source, "max_images_on_create"),
    maxSessionImages: positiveLimit(source, "max_session_images"),
    maxImageBytes: positiveLimit(source, "max_image_bytes"),
    maxTotalImageBytes: positiveLimit(source, "max_total_image_bytes"),
    maxTotalImageBytesOnCreate: positiveLimit(source, "max_total_image_bytes_on_create"),
    maxTextBytesPerBlock: positiveLimit(source, "max_text_bytes_per_block"),
    maxTotalTextBytes: positiveLimit(source, "max_total_text_bytes"),
    maxTotalTextBytesOnCreate: positiveLimit(source, "max_total_text_bytes_on_create"),
    maxTools: positiveLimit(source, "max_tools"),
    maxToolsJsonBytes: positiveLimit(source, "max_tools_json_bytes"),
    maxSessionAttachmentBytes: positiveLimit(source, "max_session_attachment_bytes"),
    maxSessionStoredJsonBytes: positiveLimit(source, "max_session_stored_json_bytes"),
  });
}

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function safeTotal(...values: number[]): number | null {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function isBudgetState(value: ManagedChatSessionBudgetState): boolean {
  return [value.messageCount, value.imageCount, value.attachmentBytes, value.storedJsonBytes]
    .every((entry) => Number.isSafeInteger(entry) && entry >= 0);
}

export function hasUnavailableManagedAttachment(value: JsonContractValue): boolean {
  if (typeof value === "string") return value.includes("[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]");
  if (Array.isArray(value)) return value.some(hasUnavailableManagedAttachment);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasUnavailableManagedAttachment);
}

function asObject(value: JsonContractValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function imagePayload(value: string): Readonly<{ mimeType: string; byteLength: number }> | null {
  const comma = value.indexOf(",");
  if (comma <= 0) return null;
  const metadata = value.slice(0, comma).toLowerCase();
  if (!metadata.startsWith("data:") || !metadata.endsWith(";base64")) return null;
  const mimeType = metadata.slice("data:".length, -";base64".length);
  const base64 = value.slice(comma + 1);
  if (!IMAGE_MIME_TYPES.has(mimeType) || base64.length === 0 || !BASE64.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = (base64.length / 4) * 3 - padding;
  return Number.isSafeInteger(byteLength) && byteLength > 0
    ? Object.freeze({ mimeType, byteLength })
    : null;
}

function imageFromBlock(block: JsonObject): Readonly<{ mimeType: string; byteLength: number }> | null {
  if (block.type === "image_url") {
    const image = asObject(block.image_url);
    return image && typeof image.url === "string" ? imagePayload(image.url) : null;
  }
  return block.type === "input_image" && typeof block.image_url === "string"
    ? imagePayload(block.image_url)
    : null;
}

function inspectMessage(message: ManagedPreparedMessage): MessageStats | null {
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  const content = message.content;
  let contentBlocks = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let textBytes = 0;
  let maxImageBytes = 0;
  let maxTextBlockBytes = 0;

  if (typeof content === "string") {
    contentBlocks = 1;
    textBytes = utf8Bytes(content);
    maxTextBlockBytes = textBytes;
  } else if (role === "user" && Array.isArray(content) && content.length > 0) {
    contentBlocks = content.length;
    for (const rawBlock of content) {
      const block = asObject(rawBlock);
      if (!block) return null;
      if ((block.type === "text" || block.type === "input_text") && typeof block.text === "string") {
        const bytes = utf8Bytes(block.text);
        textBytes += bytes;
        maxTextBlockBytes = Math.max(maxTextBlockBytes, bytes);
        continue;
      }
      const image = imageFromBlock(block);
      if (!image) return null;
      imageCount += 1;
      imageBytes += image.byteLength;
      maxImageBytes = Math.max(maxImageBytes, image.byteLength);
    }
  } else {
    return null;
  }

  return Object.freeze({
    role,
    contentBlocks,
    imageCount,
    imageBytes,
    textBytes,
    maxImageBytes,
    maxTextBlockBytes,
  });
}

function storedImageBlock(
  image: Readonly<{ mimeType: string; byteLength: number }>,
): JsonObject {
  const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
  // Use maximum safe-integer ordinals so the local estimate cannot be smaller
  // than the server's managed-chat object-key representation.
  const ordinal = "9007199254740991";
  return Object.freeze({
    type: "_systemsculpt_managed_image",
    object_key: `managed-chat/mchat_${"0".repeat(32)}/r${ordinal}/m${ordinal}-b${ordinal}-${"0".repeat(64)}.${extension}`,
    mime_type: image.mimeType,
    size_bytes: image.byteLength,
    sha256: "0".repeat(64),
  });
}

function storedMessage(message: ManagedPreparedMessage): ManagedPreparedMessage | null {
  if (message.role !== "user" || !Array.isArray(message.content)) return message;
  const content: JsonContractValue[] = [];
  for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
    const rawBlock = message.content[blockIndex];
    const block = asObject(rawBlock);
    if (!block) return null;
    if (block.type === "text" || block.type === "input_text") {
      content.push(block);
      continue;
    }
    const image = imageFromBlock(block);
    if (!image) return null;
    content.push(storedImageBlock(image));
  }
  return Object.freeze({ ...message, content: Object.freeze(content) });
}

function storedAssistantResponse(message: ManagedPreparedMessage): ManagedPreparedMessage | null {
  if (message.role !== "assistant" || typeof message.content !== "string") return null;
  let toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    const normalized: JsonContractValue[] = [];
    for (const rawCall of toolCalls) {
      const call = asObject(rawCall);
      const fn = call ? asObject(call.function) : null;
      if (!call || !fn || typeof fn.arguments !== "string") return null;
      try {
        normalized.push({
          ...call,
          function: { ...fn, arguments: JSON.stringify(JSON.parse(fn.arguments)) },
        });
      } catch {
        return null;
      }
    }
    toolCalls = Object.freeze(normalized);
  }
  return Object.freeze({
    ...message,
    content: message.content.length > 0 ? message.content : null,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  });
}

function inspectTranscript(messages: readonly ManagedPreparedMessage[]): TranscriptStats | null {
  const stats: MessageStats[] = [];
  const stored: ManagedPreparedMessage[] = [];
  const turns: MutableTurnStats[] = [];
  let currentTurn: MutableTurnStats | null = null;
  let imageCount = 0;
  let imageBytes = 0;
  let textBytes = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const messageStats = inspectMessage(message);
    const persisted = storedMessage(message);
    if (!messageStats || !persisted) return null;
    stats.push(messageStats);
    stored.push(persisted);
    imageCount += messageStats.imageCount;
    imageBytes += messageStats.imageBytes;
    textBytes += messageStats.textBytes;
    if (messageStats.role === "user") {
      currentTurn = { imageCount: 0, imageBytes: 0, textBytes: 0 };
      turns.push(currentTurn);
    }
    if (currentTurn) {
      currentTurn.imageCount += messageStats.imageCount;
      currentTurn.imageBytes += messageStats.imageBytes;
      currentTurn.textBytes += messageStats.textBytes;
    }
  }

  return Object.freeze({
    messages: Object.freeze(stats),
    messageCount: messages.length,
    imageCount,
    imageBytes,
    textBytes,
    storedJsonBytes: jsonBytes(stored),
    turns: Object.freeze(turns.map((turn) => Object.freeze({ ...turn }))),
  });
}

function shapeIssue(stats: TranscriptStats, limits: ManagedChatSessionLimits): ManagedChatBudgetIssue | null {
  if (stats.messages.some((message) => message.contentBlocks > limits.maxContentBlocksPerMessage)) {
    return issue("local_transcript_invalid", "A chat message has too many content blocks for the managed contract.");
  }
  if (stats.messages.some((message) => message.maxImageBytes > limits.maxImageBytes)) {
    return issue("local_transcript_invalid", "A chat image exceeds the managed per-image limit.");
  }
  if (stats.messages.some((message) => message.maxTextBlockBytes > limits.maxTextBytesPerBlock)) {
    return issue("local_transcript_invalid", "A chat text block exceeds the managed per-block limit.");
  }
  return null;
}

function toolsIssue(
  tools: readonly Readonly<{ [key: string]: JsonContractValue }>[],
  limits: ManagedChatSessionLimits,
): ManagedChatBudgetIssue | null {
  if (tools.length > limits.maxTools || jsonBytes(tools) > limits.maxToolsJsonBytes) {
    return issue(
      "local_tool_contract_limit",
      "The first-party tool contract is larger than this SystemSculpt server accepts.",
    );
  }
  return null;
}

function perTurnIssue(stats: TranscriptStats, limits: ManagedChatSessionLimits): ManagedChatBudgetIssue | null {
  if (stats.turns.some((turn) =>
    turn.imageCount > limits.maxImagesPerTurn ||
    turn.imageBytes > limits.maxTotalImageBytes)) {
    return issue(
      "local_rebase_attachment_limit",
      "A retained chat turn is too large to rebuild under the managed per-turn limits.",
    );
  }
  if (stats.turns.some((turn) => turn.textBytes > limits.maxTotalTextBytes)) {
    return issue(
      "local_rebase_text_limit",
      "A retained chat turn has too much text to rebuild under the managed per-turn limits.",
    );
  }
  return null;
}

function sessionIssue(
  stats: TranscriptStats,
  tools: readonly Readonly<{ [key: string]: JsonContractValue }>[],
  limits: ManagedChatSessionLimits,
): ManagedChatBudgetIssue | null {
  if (stats.messageCount + 1 > limits.maxSessionMessages) {
    return issue(
      "local_session_message_limit",
      "This chat has reached the managed session message limit. Start a new chat to continue.",
    );
  }
  if (stats.imageCount > limits.maxSessionImages) {
    return issue(
      "local_session_image_limit",
      "This chat has reached the managed session image limit. Start a new chat to continue.",
    );
  }
  if (stats.imageBytes > limits.maxSessionAttachmentBytes) {
    return issue(
      "local_session_attachment_limit",
      "This chat has reached the managed session attachment limit. Start a new chat to continue.",
    );
  }
  const configBytes = jsonBytes({ tools, toolChoice: "auto" });
  // The server applies this bound to the entire staged response wrapper; the
  // assistant message persisted into session history is therefore no larger.
  const responseReserve = limits.maxTotalTextBytes;
  if (
    stats.storedJsonBytes + configBytes + responseReserve
    > limits.maxSessionStoredJsonBytes
  ) {
    return issue(
      "local_session_stored_json_limit",
      "This chat has reached the managed session storage limit. Start a new chat to continue.",
    );
  }
  return null;
}

function sessionStateIssue(
  state: ManagedChatSessionBudgetState,
  limits: ManagedChatSessionLimits,
  additions: Readonly<{
    messages: number;
    images?: number;
    attachmentBytes?: number;
    storedJsonBytes: number;
  }>,
): ManagedChatBudgetIssue | null {
  if (state.messageCount + additions.messages + 1 > limits.maxSessionMessages) {
    return issue(
      "local_session_message_limit",
      "This chat has reached the managed session message limit. Start a new chat to continue.",
    );
  }
  if (state.imageCount + (additions.images ?? 0) > limits.maxSessionImages) {
    return issue(
      "local_session_image_limit",
      "This chat has reached the managed session image limit. Start a new chat to continue.",
    );
  }
  if (state.attachmentBytes + (additions.attachmentBytes ?? 0) > limits.maxSessionAttachmentBytes) {
    return issue(
      "local_session_attachment_limit",
      "This chat has reached the managed session attachment limit. Start a new chat to continue.",
    );
  }
  if (
    // maxTotalTextBytes bounds the server's full staged response wrapper, not
    // merely its text, so it also covers tool-call and message JSON overhead.
    state.storedJsonBytes + additions.storedJsonBytes + limits.maxTotalTextBytes
    > limits.maxSessionStoredJsonBytes
  ) {
    return issue(
      "local_session_stored_json_limit",
      "This chat has reached the managed session storage limit. Start a new chat to continue.",
    );
  }
  return null;
}

function createIssue(
  stats: TranscriptStats,
  tools: readonly Readonly<{ [key: string]: JsonContractValue }>[],
  limits: ManagedChatSessionLimits,
): ManagedChatBudgetIssue | null {
  const invalidShape = shapeIssue(stats, limits);
  if (invalidShape) return invalidShape;
  const invalidTools = toolsIssue(tools, limits);
  if (invalidTools) return invalidTools;
  if (stats.messageCount > limits.maxMessagesOnCreate) {
    return issue(
      "local_rebase_message_limit",
      "This chat is too long to rebuild safely. Start a new chat to continue.",
    );
  }
  if (
    stats.imageCount > limits.maxImagesOnCreate ||
    stats.imageBytes > limits.maxTotalImageBytesOnCreate
  ) {
    return issue(
      "local_rebase_attachment_limit",
      "This chat has too many retained images to rebuild safely. Start a new chat to continue.",
    );
  }
  if (stats.textBytes > limits.maxTotalTextBytesOnCreate) {
    return issue(
      "local_rebase_text_limit",
      "This chat has too much retained text to rebuild safely. Start a new chat to continue.",
    );
  }
  return perTurnIssue(stats, limits) ?? sessionIssue(stats, tools, limits);
}

function resumeIssue(
  delta: TranscriptStats,
  sessionBudget: ManagedChatSessionBudgetState,
  limits: ManagedChatSessionLimits,
): ManagedChatBudgetIssue | null {
  const invalidShape = shapeIssue(delta, limits);
  if (invalidShape) return invalidShape;
  if (delta.messageCount > limits.maxMessagesPerDelta) {
    return issue(
      "local_delta_message_limit",
      "The next managed session delta has too many messages and must start a fresh session.",
    );
  }
  if (
    delta.imageCount > limits.maxImagesPerTurn ||
    delta.imageBytes > limits.maxTotalImageBytes ||
    delta.textBytes > limits.maxTotalTextBytes
  ) {
    return issue(
      "local_delta_attachment_limit",
      "The next managed session delta is too large and must start a fresh session.",
    );
  }
  return sessionStateIssue(sessionBudget, limits, {
    messages: delta.messageCount,
    images: delta.imageCount,
    attachmentBytes: delta.imageBytes,
    storedJsonBytes: delta.storedJsonBytes,
  });
}

export function inspectManagedChatDispatchBudget(params: Readonly<{
  limits: ManagedCapabilityDescriptor["limits"];
  fullMessages: readonly ManagedPreparedMessage[];
  deltaMessages: readonly ManagedPreparedMessage[];
  tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
  sessionBudget?: ManagedChatSessionBudgetState;
}>): ManagedChatDispatchBudget {
  let limits: ManagedChatSessionLimits;
  try {
    limits = sessionLimits(params.limits);
  } catch {
    const invalid = issue(
      "local_contract_invalid",
      "The SystemSculpt chat limits are missing or invalid. Refresh the plugin contract and try again.",
    );
    return Object.freeze({ createIssue: invalid, resumeIssue: invalid });
  }
  const full = inspectTranscript(params.fullMessages);
  const delta = inspectTranscript(params.deltaMessages);
  if (!full || !delta) {
    const invalid = issue(
      "local_transcript_invalid",
      "This chat history could not be prepared safely. Start a new chat and try again.",
    );
    return Object.freeze({ createIssue: invalid, resumeIssue: invalid });
  }
  const tools = params.tools ?? [];
  const invalidSessionBudget = params.sessionBudget && !isBudgetState(params.sessionBudget)
    ? issue(
        "local_contract_invalid",
        "The saved SystemSculpt session counters are invalid. Start a fresh managed session.",
      )
    : null;
  return Object.freeze({
    createIssue: createIssue(full, tools, limits),
    resumeIssue: params.sessionBudget
      ? invalidSessionBudget ?? resumeIssue(delta, params.sessionBudget, limits)
      : null,
  });
}

/**
 * Advances the locally persisted mirror of the server's committed counters.
 * Image references use a conservative maximum-length object key, so this
 * state can overestimate stored JSON slightly but must never undercount it.
 */
export function advanceManagedChatSessionBudget(params: Readonly<{
  previous?: ManagedChatSessionBudgetState;
  requestMessages: readonly ManagedPreparedMessage[];
  responseMessage: ManagedPreparedMessage;
  tools?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
}>): ManagedChatSessionBudgetState | null {
  const request = inspectTranscript(params.requestMessages);
  const response = storedAssistantResponse(params.responseMessage);
  if (!request || !response || (params.previous && !isBudgetState(params.previous))) return null;
  const base = params.previous ?? {
    messageCount: 0,
    imageCount: 0,
    attachmentBytes: 0,
    storedJsonBytes: jsonBytes({ tools: params.tools ?? [], toolChoice: "auto" }),
  };
  const messageCount = safeTotal(base.messageCount, request.messageCount, 1);
  const imageCount = safeTotal(base.imageCount, request.imageCount);
  const attachmentBytes = safeTotal(base.attachmentBytes, request.imageBytes);
  const storedJsonBytes = safeTotal(
    base.storedJsonBytes,
    request.storedJsonBytes,
    jsonBytes(response),
  );
  if (
    messageCount === null
    || imageCount === null
    || attachmentBytes === null
    || storedJsonBytes === null
  ) return null;
  return Object.freeze({ messageCount, imageCount, attachmentBytes, storedJsonBytes });
}

function reservedToolStoredJsonBytes(tools: readonly ToolResultReservation[]): number {
  const messages = tools.reduce((total, tool) => total + jsonBytes({
    role: "tool",
    content: "",
    tool_call_id: tool.id,
    name: tool.name,
  }) + (MAX_MANAGED_TOOL_RESULT_BYTES * 2) + 1, 0);
  // One extra byte completes the JSON array envelope: the per-message reserve
  // above already accounts for every comma plus the opening bracket.
  return messages + 1;
}

function blockedToolContinuation(value: ManagedChatBudgetIssue): ManagedToolContinuationBudget {
  return Object.freeze({ issue: value, rotateSession: false });
}

export function inspectManagedToolContinuationBudget(params: Readonly<{
  limits: ManagedCapabilityDescriptor["limits"];
  fullMessagesThroughAssistant: readonly ManagedPreparedMessage[];
  sessionBudget: ManagedChatSessionBudgetState;
  tools: readonly ToolResultReservation[];
  toolDefinitions?: readonly Readonly<{ [key: string]: JsonContractValue }>[];
}>): ManagedToolContinuationBudget {
  let limits: ManagedChatSessionLimits;
  try {
    limits = sessionLimits(params.limits);
  } catch {
    return blockedToolContinuation(issue(
      "local_contract_invalid",
      "The SystemSculpt chat limits are missing or invalid. No vault actions were run.",
    ));
  }
  const toolDefinitions = params.toolDefinitions ?? [];
  if (!isBudgetState(params.sessionBudget)) {
    return blockedToolContinuation(issue(
      "local_contract_invalid",
      "The saved SystemSculpt session counters are invalid. No vault actions were run.",
    ));
  }
  if (hasUnavailableManagedAttachment(params.fullMessagesThroughAssistant)) {
    return blockedToolContinuation(issue(
      "local_attachment_unavailable",
      "An earlier attachment is unavailable, so this chat cannot preserve a safe action continuation. No vault actions were run.",
    ));
  }
  const invalidTools = toolsIssue(toolDefinitions, limits);
  if (invalidTools) return blockedToolContinuation(invalidTools);
  if (params.tools.length > limits.maxMessagesPerDelta) {
    return blockedToolContinuation(issue(
      "local_tool_batch_limit",
      `SystemSculpt requested ${params.tools.length} actions, but this server accepts at most ${limits.maxMessagesPerDelta} results in one continuation. No vault actions were run.`,
    ));
  }
  if (MAX_MANAGED_TOOL_RESULT_BYTES > limits.maxTextBytesPerBlock) {
    return blockedToolContinuation(issue(
      "local_contract_invalid",
      "The managed tool-result bound exceeds the negotiated text-block limit. No vault actions were run.",
    ));
  }
  const full = inspectTranscript(params.fullMessagesThroughAssistant);
  if (!full) {
    return blockedToolContinuation(issue(
      "local_transcript_invalid",
      "This chat history could not be prepared safely. No vault actions were run.",
    ));
  }
  const invalidShape = shapeIssue(full, limits);
  if (invalidShape) return blockedToolContinuation(invalidShape);
  const reservedTextBytes = params.tools.length * MAX_MANAGED_TOOL_RESULT_BYTES;
  if (reservedTextBytes > limits.maxTotalTextBytes) {
    return blockedToolContinuation(issue(
      "local_tool_batch_limit",
      "The requested action results cannot fit in one managed continuation. No vault actions were run.",
    ));
  }
  if (full.messageCount + params.tools.length > limits.maxMessagesOnCreate) {
    return blockedToolContinuation(issue(
      "local_rebase_message_limit",
      "This chat cannot retain another action batch and still be rebuilt safely. No vault actions were run.",
    ));
  }
  if (full.textBytes + reservedTextBytes > limits.maxTotalTextBytesOnCreate) {
    return blockedToolContinuation(issue(
      "local_rebase_text_limit",
      "This chat cannot retain another action batch and still be rebuilt safely. No vault actions were run.",
    ));
  }
  const lastTurn = full.turns[full.turns.length - 1];
  if (lastTurn && lastTurn.textBytes + reservedTextBytes > limits.maxTotalTextBytes) {
    return blockedToolContinuation(issue(
      "local_rebase_text_limit",
      "This chat turn cannot retain another action batch and still be rebuilt safely. No vault actions were run.",
    ));
  }
  const boundSessionIssue = sessionStateIssue(params.sessionBudget, limits, {
    messages: params.tools.length,
    storedJsonBytes: reservedToolStoredJsonBytes(params.tools),
  });
  return Object.freeze({ issue: null, rotateSession: boundSessionIssue !== null });
}
