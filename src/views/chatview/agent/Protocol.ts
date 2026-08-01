import type { ThinAgentRunTerminalData } from "../../../services/managed/ThinAgentV1Contract";
import { DEFAULT_THIN_AGENT_INPUT_LIMITS } from "../../../services/managed/ThinAgentInputLimits";
import { isFirstPartyToolName } from "../../../tools/toolNames";

export const FIRST_PARTY_THIN_AGENT_COMMAND_TYPE =
  "systemsculpt.agent.command.v1" as const;
export const FIRST_PARTY_THIN_AGENT_EVENT_TYPE =
  "systemsculpt.agent.event.v1" as const;
export const FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE =
  "systemsculpt.client_diagnostic.v1" as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CLIENT_INSTANCE_ID = /^client_[a-f0-9]{32}$/u;
const CONVERSATION_ID = /^conversation_[a-f0-9]{32}$/u;
const RUN_ID = /^run_[a-f0-9]{32}$/u;
const INCIDENT_ID = /^incident_[a-f0-9]{32}$/u;
const CONTEXT_REF = /^ctx1_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const DIAGNOSTIC_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;
const MESSAGE_PART_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TEXT_FILE_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "application/x-yaml",
]);
const ENCRYPTED_REASONING_KEYS = new Set(["encryptedContent", "encrypted_content"]);
const MAX_FILE_URL_CHARS = 24 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_CHARS = 255;
const MAX_ERROR_TEXT_CHARS = 4_096;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_COLLECTION_ENTRIES = 2_048;
const MAX_SERVER_MESSAGE_PARTS = 2_048;
const MAX_SESSION_MESSAGES = 256;
const INVALID_JSON_VALUE = Symbol("invalid-json-value");
const runStateCanonicals = new WeakMap<object, string>();

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentJsonValue[]
  | Readonly<{ [key: string]: AgentJsonValue }>;

export type AgentUserMessagePart =
  | Readonly<{
      type: "text";
      text: string;
    }>
  | Readonly<{
      type: "file";
      mediaType: string;
      url: string;
      filename?: string;
    }>;

export type AgentUserMessage = Readonly<{
  id: string;
  role: "user";
  parts: readonly AgentUserMessagePart[];
}>;

type CommandBase = Readonly<{
  type: typeof FIRST_PARTY_THIN_AGENT_COMMAND_TYPE;
  version: 1;
  request_id: string;
}>;

export type AgentSubmitCommand = CommandBase & Readonly<{
  kind: "submit";
  user_message: AgentUserMessage;
  context_ref?: string;
}>;

export type AgentRegenerateCommand = CommandBase & Readonly<{
  kind: "regenerate";
  root_message_id: string;
}>;

export type AgentToolResultCommand = CommandBase & (
  | Readonly<{
      kind: "client_tool_result";
      tool_call_id: string;
      tool_name: string;
      state: "output-available";
      output: AgentJsonValue;
    }>
  | Readonly<{
      kind: "client_tool_result";
      tool_call_id: string;
      tool_name: string;
      state: "output-error";
      error_text: string;
    }>
);

export type AgentApprovalCommand = CommandBase & Readonly<{
  kind: "client_tool_approval";
  tool_call_id: string;
  approved: boolean;
}>;

export type AgentCancelCommand = CommandBase & Readonly<{
  kind: "cancel";
}>;

export type AgentCommand =
  | AgentSubmitCommand
  | AgentRegenerateCommand
  | AgentToolResultCommand
  | AgentApprovalCommand
  | AgentCancelCommand;

export type AgentDiagnosticPayload = Readonly<{
  version: 1;
  severity: "info" | "warn" | "error";
  code: string;
  phase:
    | "start"
    | "session"
    | "response"
    | "approval"
    | "tool_execution"
    | "mutation_journal"
    | "persistence"
    | "render"
    | "unknown";
  sequence?: number;
  timestamp?: number;
  conversation_id?: string;
  request_id?: string;
  client_instance_id?: string;
  plugin_build_id?: string;
  server_run_id?: string;
  run_id?: string;
  incident_id?: string;
  tool_name?: string;
  tool_call_id?: string;
  status?: number;
  retryable?: boolean;
}>;

export type AgentDiagnosticFrame = Readonly<{
  type: typeof FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE;
  payload: AgentDiagnosticPayload;
}>;

export type AgentKnownRunState =
  | Readonly<{
      version: 1;
      cursor: number;
      state: "idle";
    }>
  | Readonly<{
      version: 1;
      cursor: number;
      state: "running" | "waiting_for_client";
      request_id: string;
      run_id: string;
      root_message_id: string;
    }>;

export type AgentUnknownRunState = Readonly<{
  version: 1 | null;
  cursor: number | null;
  state: "unknown";
}>;

export type AgentRunState =
  | AgentKnownRunState
  | AgentUnknownRunState;

type ServerEventBase = Readonly<{
  type: typeof FIRST_PARTY_THIN_AGENT_EVENT_TYPE;
  version: 1;
  conversation_id: string;
}>;

export type AgentSessionSnapshotEvent = ServerEventBase & Readonly<{
  kind: "session_snapshot";
  messages: readonly Readonly<Record<string, unknown>>[];
  run_state: AgentRunState;
}>;

export type AgentAssistantSnapshotEvent = ServerEventBase & Readonly<{
  kind: "assistant_snapshot";
  request_id: string;
  message: Readonly<Record<string, unknown>>;
}>;

export type AgentRunStateEvent = ServerEventBase & Readonly<{
  kind: "run_state";
  run_state: AgentRunState;
}>;

export type AgentTerminalEvent = ServerEventBase & Readonly<{
  kind: "terminal";
  request_id: string;
  terminal: ThinAgentRunTerminalData;
}>;

export type AgentCommandAckEvent = ServerEventBase & (
  | Readonly<{
      kind: "command_ack";
      request_id: string;
      command_kind: "submit" | "regenerate" | "cancel";
      status: "accepted";
    }>
  | Readonly<{
      kind: "command_ack";
      request_id: string;
      command_kind: "client_tool_result" | "client_tool_approval";
      tool_call_id: string;
      status: "accepted";
    }>
);

export type AgentUnknownEvent = ServerEventBase & Readonly<{
  kind: "unknown";
  raw_kind: string;
  raw: Readonly<Record<string, unknown>>;
}>;

export type AgentServerEvent =
  | AgentSessionSnapshotEvent
  | AgentAssistantSnapshotEvent
  | AgentRunStateEvent
  | AgentTerminalEvent
  | AgentCommandAckEvent
  | AgentUnknownEvent;

export class AgentProtocolError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

function fail(code: string, message: string): never {
  throw new AgentProtocolError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function boundedDiagnosticIdentifier(value: unknown): value is string {
  return safeId(value)
    && !/^(?:data|file|https?|obsidian|wss?):/iu.test(value)
    && !/^www\./iu.test(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodedBase64Bytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) {
    padding = value.charCodeAt(value.length - 2) === 0x3d ? 2 : 1;
  }
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
    )) return null;
  }
  try {
    const decoded = window.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseBase64DataUrl(
  value: unknown,
  mediaType: string,
): Uint8Array | null {
  if (typeof value !== "string" || value.length > MAX_FILE_URL_CHARS) return null;
  const comma = value.indexOf(",");
  if (
    comma <= 0
    || value.slice(0, comma).toLowerCase() !== `data:${mediaType};base64`
  ) return null;
  return decodedBase64Bytes(value.slice(comma + 1));
}

function supportedTextFileMimeType(value: string): boolean {
  return /^text\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(value)
    || TEXT_FILE_MIME_TYPES.has(value);
}

function validAttachmentName(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > MAX_ATTACHMENT_NAME_CHARS
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x2f
      || code === 0x5c
      || code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
    ) return false;
  }
  return true;
}

function sanitizeJsonValue(
  value: unknown,
  stripEncryptedReasoning: boolean,
): AgentJsonValue | typeof INVALID_JSON_VALUE {
  const seen = new WeakSet<object>();
  let collections = 0;
  const visit = (
    current: unknown,
    depth: number,
  ): AgentJsonValue | typeof INVALID_JSON_VALUE => {
    if (
      current === null
      || typeof current === "boolean"
      || typeof current === "string"
    ) return current;
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : INVALID_JSON_VALUE;
    }
    if (
      depth >= MAX_JSON_DEPTH
      || typeof current !== "object"
      || seen.has(current)
    ) return INVALID_JSON_VALUE;
    seen.add(current);
    collections += 1;
    if (collections > MAX_JSON_NODES) {
      seen.delete(current);
      return INVALID_JSON_VALUE;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_JSON_COLLECTION_ENTRIES) {
        seen.delete(current);
        return INVALID_JSON_VALUE;
      }
      const output: AgentJsonValue[] = [];
      for (const entry of current) {
        const parsed = visit(entry, depth + 1);
        if (parsed === INVALID_JSON_VALUE) {
          seen.delete(current);
          return INVALID_JSON_VALUE;
        }
        output.push(parsed);
      }
      seen.delete(current);
      return Object.freeze(output);
    }
    if (!isRecord(current)) {
      seen.delete(current);
      return INVALID_JSON_VALUE;
    }
    const keys = Object.keys(current).sort();
    if (keys.length > MAX_JSON_COLLECTION_ENTRIES) {
      seen.delete(current);
      return INVALID_JSON_VALUE;
    }
    const output: Record<string, AgentJsonValue> = {};
    for (const key of keys) {
      if (stripEncryptedReasoning && ENCRYPTED_REASONING_KEYS.has(key)) continue;
      const parsed = visit(current[key], depth + 1);
      if (parsed === INVALID_JSON_VALUE) {
        seen.delete(current);
        return INVALID_JSON_VALUE;
      }
      output[key] = parsed;
    }
    seen.delete(current);
    return Object.freeze(output);
  };
  try {
    return visit(value, 0);
  } catch {
    return INVALID_JSON_VALUE;
  }
}

function parseJsonValue(value: unknown): AgentJsonValue {
  const parsed = sanitizeJsonValue(value, false);
  if (parsed === INVALID_JSON_VALUE) {
    return fail("command_too_complex", "The client command contains invalid JSON data.");
  }
  return parsed;
}

function parseServerMessagePart(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const parsed = sanitizeJsonValue(value, true);
  if (
    parsed === INVALID_JSON_VALUE
    || !isRecord(parsed)
    || typeof parsed.type !== "string"
    || !MESSAGE_PART_TYPE.test(parsed.type)
  ) return fail("invalid_server_event", "The authoritative message part is invalid.");
  return parsed;
}

function parseServerMessage(
  value: unknown,
  requiredRole?: "assistant",
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value)
    || !safeId(value.id)
    || (value.role !== "user" && value.role !== "assistant")
    || (requiredRole !== undefined && value.role !== requiredRole)
    || !Array.isArray(value.parts)
    || value.parts.length > MAX_SERVER_MESSAGE_PARTS
  ) return fail("invalid_server_event", "The authoritative message is invalid.");
  return Object.freeze({
    id: value.id,
    role: value.role,
    parts: Object.freeze(value.parts.map(parseServerMessagePart)),
  });
}

function parseTerminal(value: unknown): ThinAgentRunTerminalData {
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.run_id !== "string"
    || !RUN_ID.test(value.run_id)
    || !safeId(value.root_message_id)
  ) return fail("invalid_server_event", "The terminal event is invalid.");
  if (value.outcome === "succeeded" && value.code === "completed") {
    return Object.freeze({
      version: 1,
      run_id: value.run_id,
      root_message_id: value.root_message_id,
      outcome: "succeeded",
      code: "completed",
    });
  }
  if (
    value.outcome === "cancelled"
    && value.code === "cancelled"
    && (value.message === undefined || (
      typeof value.message === "string"
      && value.message.length >= 1
      && value.message.length <= 512
    ))
  ) return Object.freeze({
    version: 1,
    run_id: value.run_id,
    root_message_id: value.root_message_id,
    outcome: "cancelled",
    code: "cancelled",
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  });
  if (
    value.outcome === "failed"
    && typeof value.code === "string"
    && ERROR_CODE.test(value.code)
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 512
    && typeof value.incident_id === "string"
    && INCIDENT_ID.test(value.incident_id)
    && typeof value.retryable === "boolean"
  ) return Object.freeze({
    version: 1,
    run_id: value.run_id,
    root_message_id: value.root_message_id,
    outcome: "failed",
    code: value.code,
    message: value.message,
    incident_id: value.incident_id,
    retryable: value.retryable,
  });
  return fail("invalid_server_event", "The terminal event is invalid.");
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const visit = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return "[too-complex]";
    if (current === null) return "null";
    if (typeof current === "boolean" || typeof current === "string") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? JSON.stringify(current) : "[non-finite]";
    }
    if (Array.isArray(current)) {
      return `[${current.map((entry) => visit(entry, depth + 1)).join(",")}]`;
    }
    if (!isRecord(current)) return `[${typeof current}]`;
    return `{${Object.keys(current).sort().map((key) =>
      `${JSON.stringify(key)}:${visit(current[key], depth + 1)}`).join(",")}}`;
  };
  return visit(value, 0);
}

function rememberRunState<T extends AgentRunState>(
  state: T,
  raw: unknown,
): T {
  runStateCanonicals.set(state, canonicalJson(raw));
  return state;
}

function parseUserMessage(value: unknown): AgentUserMessage {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["id", "role", "parts"])
    || !safeId(value.id)
    || value.role !== "user"
    || !Array.isArray(value.parts)
    || value.parts.length < 1
    || value.parts.length > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxContentBlocksPerMessage
  ) return fail("invalid_command", "A submit command needs one new user message.");
  let textBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  const parts = value.parts.map((part): AgentUserMessagePart => {
    if (!isRecord(part) || typeof part.type !== "string") {
      return fail("invalid_command", "The submitted user message contains an invalid part.");
    }
    if (part.type === "text") {
      if (
        !hasExactKeys(part, ["type", "text"])
        || typeof part.text !== "string"
        || part.text.trim().length < 1
      ) return fail("invalid_command", "The submitted text part is invalid.");
      const bytes = utf8Bytes(part.text);
      if (bytes > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTextBytesPerBlock) {
        return fail("invalid_command", "The submitted text part is too large.");
      }
      textBytes += bytes;
      return Object.freeze({ type: "text", text: part.text });
    }
    if (part.type === "file") {
      if (
        !hasExactKeys(part, ["type", "mediaType", "url"], ["filename"])
        || typeof part.mediaType !== "string"
        || !MEDIA_TYPE.test(part.mediaType)
        || part.mediaType.trim() !== part.mediaType
        || part.mediaType !== part.mediaType.toLowerCase()
        || typeof part.url !== "string"
        || part.url.length > MAX_FILE_URL_CHARS
        || !validAttachmentName(part.filename)
      ) return fail("invalid_command", "The submitted file part is invalid.");
      const bytes = parseBase64DataUrl(part.url, part.mediaType);
      if (!bytes || bytes.byteLength < 1) {
        return fail("invalid_command", "The submitted file data is invalid.");
      }
      if (DEFAULT_THIN_AGENT_INPUT_LIMITS.imageMimeTypes.includes(part.mediaType)) {
        if (bytes.byteLength > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxImageBytes) {
          return fail("invalid_command", "The submitted image is too large.");
        }
        imageCount += 1;
        imageBytes += bytes.byteLength;
      } else {
        if (
          !supportedTextFileMimeType(part.mediaType)
          || bytes.byteLength > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTextBytesPerBlock
        ) return fail("invalid_command", "The submitted text file is invalid.");
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return fail("invalid_command", "The submitted text file is not valid UTF-8.");
        }
        textBytes += bytes.byteLength;
      }
      return Object.freeze({
        type: "file",
        mediaType: part.mediaType,
        url: part.url,
        ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      });
    }
    return fail("invalid_command", "The submitted user message part is unsupported.");
  });
  if (
    textBytes > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTotalTextBytes
    || imageCount > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxImagesPerTurn
    || imageBytes > DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTotalImageBytes
  ) return fail("invalid_command", "The submitted user message exceeds the input limits.");
  return Object.freeze({ id: value.id, role: "user", parts: Object.freeze(parts) });
}

function commandBase(value: Record<string, unknown>): void {
  if (
    value.type !== FIRST_PARTY_THIN_AGENT_COMMAND_TYPE
    || value.version !== 1
    || !safeId(value.request_id)
  ) return fail("invalid_command", "The client command identity is invalid.");
}

export function parseAgentCommand(
  value: unknown,
): AgentCommand {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return fail("invalid_command", "The client command is invalid.");
  }
  commandBase(value);
  if (value.kind === "submit") {
    if (!hasExactKeys(
      value,
      ["type", "version", "kind", "request_id", "user_message"],
      ["context_ref"],
    )) return fail("invalid_command", "The submit command contains unsupported fields.");
    if (value.context_ref !== undefined && (
      typeof value.context_ref !== "string" || !CONTEXT_REF.test(value.context_ref)
    )) return fail("invalid_command", "The submit context reference is invalid.");
    return Object.freeze({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "submit",
      request_id: value.request_id as string,
      user_message: parseUserMessage(value.user_message),
      ...(value.context_ref === undefined ? {} : { context_ref: value.context_ref }),
    });
  }
  if (value.kind === "regenerate") {
    if (
      !hasExactKeys(value, [
        "type", "version", "kind", "request_id", "root_message_id",
      ])
      || !safeId(value.root_message_id)
    ) return fail("invalid_command", "The regenerate command is invalid.");
    return Object.freeze({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "regenerate",
      request_id: value.request_id as string,
      root_message_id: value.root_message_id,
    });
  }
  if (value.kind === "client_tool_result") {
    const common = [
      "type", "version", "kind", "request_id", "tool_call_id", "tool_name", "state",
    ] as const;
    if (
      typeof value.tool_call_id !== "string"
      || !TOOL_CALL_ID.test(value.tool_call_id)
      || typeof value.tool_name !== "string"
      || !TOOL_NAME.test(value.tool_name)
    ) return fail("invalid_command", "The client tool result identity is invalid.");
    if (value.state === "output-available") {
      if (!hasExactKeys(value, [...common, "output"])) {
        return fail("invalid_command", "A successful client tool result needs only output.");
      }
      return Object.freeze({
        type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
        version: 1,
        kind: "client_tool_result",
        request_id: value.request_id as string,
        tool_call_id: value.tool_call_id,
        tool_name: value.tool_name,
        state: "output-available",
        output: parseJsonValue(value.output),
      });
    }
    if (value.state === "output-error") {
      if (
        !hasExactKeys(value, [...common, "error_text"])
        || typeof value.error_text !== "string"
        || value.error_text.length < 1
        || value.error_text.length > MAX_ERROR_TEXT_CHARS
      ) return fail("invalid_command", "A failed client tool result needs one bounded error.");
      return Object.freeze({
        type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
        version: 1,
        kind: "client_tool_result",
        request_id: value.request_id as string,
        tool_call_id: value.tool_call_id,
        tool_name: value.tool_name,
        state: "output-error",
        error_text: value.error_text,
      });
    }
    return fail("invalid_command", "The client tool result state is invalid.");
  }
  if (value.kind === "client_tool_approval") {
    if (
      !hasExactKeys(value, [
        "type", "version", "kind", "request_id", "tool_call_id", "approved",
      ])
      || typeof value.tool_call_id !== "string"
      || !TOOL_CALL_ID.test(value.tool_call_id)
      || typeof value.approved !== "boolean"
    ) return fail("invalid_command", "The client tool approval is invalid.");
    return Object.freeze({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "client_tool_approval",
      request_id: value.request_id as string,
      tool_call_id: value.tool_call_id,
      approved: value.approved,
    });
  }
  if (value.kind === "cancel") {
    if (!hasExactKeys(value, ["type", "version", "kind", "request_id"])) {
      return fail("invalid_command", "The cancel command is invalid.");
    }
    return Object.freeze({
      type: FIRST_PARTY_THIN_AGENT_COMMAND_TYPE,
      version: 1,
      kind: "cancel",
      request_id: value.request_id as string,
    });
  }
  return fail("unsupported_command", "The client command kind is unsupported.");
}

export function parseAgentDiagnosticPayload(
  value: unknown,
): AgentDiagnosticPayload {
  const required = ["version", "severity", "code", "phase"] as const;
  const optional = [
    "sequence", "timestamp", "conversation_id", "request_id",
    "client_instance_id", "plugin_build_id", "server_run_id", "run_id",
    "incident_id", "tool_name", "tool_call_id", "status", "retryable",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, required, optional)) {
    return fail("invalid_diagnostic", "The client diagnostic contains unsupported fields.");
  }
  const phases = new Set([
    "start", "session", "response", "approval", "tool_execution",
    "mutation_journal", "persistence", "render", "unknown",
  ]);
  const severities = new Set(["info", "warn", "error"]);
  if (
    value.version !== 1
    || typeof value.severity !== "string"
    || !severities.has(value.severity)
    || typeof value.code !== "string"
    || !DIAGNOSTIC_CODE.test(value.code)
    || typeof value.phase !== "string"
    || !phases.has(value.phase)
    || (value.sequence !== undefined && !safeInteger(value.sequence))
    || (value.timestamp !== undefined && !safeInteger(value.timestamp))
    || (value.status !== undefined && (
      typeof value.status !== "number"
      || !Number.isInteger(value.status)
      || value.status < 100
      || value.status > 599
    ))
    || (value.retryable !== undefined && typeof value.retryable !== "boolean")
    || (value.tool_name !== undefined && (
      typeof value.tool_name !== "string" || !isFirstPartyToolName(value.tool_name)
    ))
  ) return fail("invalid_diagnostic", "The client diagnostic is invalid.");
  if (
    (value.conversation_id !== undefined && (
      typeof value.conversation_id !== "string"
      || !CONVERSATION_ID.test(value.conversation_id)
    ))
    || (value.client_instance_id !== undefined && (
      typeof value.client_instance_id !== "string"
      || !CLIENT_INSTANCE_ID.test(value.client_instance_id)
    ))
    || (value.server_run_id !== undefined && (
      typeof value.server_run_id !== "string"
      || !RUN_ID.test(value.server_run_id)
    ))
    || (value.incident_id !== undefined && (
      typeof value.incident_id !== "string"
      || !INCIDENT_ID.test(value.incident_id)
    ))
  ) return fail("invalid_diagnostic", "The client diagnostic identity is invalid.");
  for (const field of [
    "request_id", "plugin_build_id", "run_id", "tool_call_id",
  ] as const) {
    if (value[field] !== undefined && !boundedDiagnosticIdentifier(value[field])) {
      return fail("invalid_diagnostic", "The client diagnostic identity is invalid.");
    }
  }
  return Object.freeze({ ...value }) as AgentDiagnosticPayload;
}

export function parseAgentRunState(
  value: unknown,
): AgentRunState {
  if (!isRecord(value)) {
    return rememberRunState(
      Object.freeze({ version: null, cursor: null, state: "unknown" }),
      { version: null, cursor: null, state: "unknown" },
    );
  }
  const version = value.version === 1 ? 1 : null;
  const cursor = safeInteger(value.cursor) ? value.cursor : null;
  if (
    version === 1
    && cursor !== null
    && value.state === "idle"
    && hasExactKeys(value, ["version", "cursor", "state"])
  ) return rememberRunState(
    Object.freeze({ version: 1, cursor, state: "idle" }),
    value,
  );
  if (
    version === 1
    && cursor !== null
    && (value.state === "running" || value.state === "waiting_for_client")
    && hasExactKeys(value, [
      "version", "cursor", "state", "request_id", "run_id", "root_message_id",
    ])
    && safeId(value.request_id)
    && typeof value.run_id === "string"
    && RUN_ID.test(value.run_id)
    && safeId(value.root_message_id)
  ) {
    return rememberRunState(Object.freeze({
      version: 1,
      cursor,
      state: value.state,
      request_id: value.request_id,
      run_id: value.run_id,
      root_message_id: value.root_message_id,
    }), value);
  }
  return rememberRunState(
    Object.freeze({ version, cursor, state: "unknown" }),
    {
      version,
      cursor,
      state: typeof value.state === "string"
        && value.state.length >= 1
        && value.state.length <= 80
        ? value.state
        : "unknown",
    },
  );
}

function serverBase(
  value: Record<string, unknown>,
  expectedConversationId: string,
): Readonly<{
  type: typeof FIRST_PARTY_THIN_AGENT_EVENT_TYPE;
  version: 1;
  conversation_id: string;
}> {
  if (
    value.type !== FIRST_PARTY_THIN_AGENT_EVENT_TYPE
    || value.version !== 1
    || typeof value.conversation_id !== "string"
    || !CONVERSATION_ID.test(value.conversation_id)
    || value.conversation_id !== expectedConversationId
  ) return fail("invalid_server_event", "The authoritative server event identity is invalid.");
  return {
    type: FIRST_PARTY_THIN_AGENT_EVENT_TYPE,
    version: 1,
    conversation_id: value.conversation_id,
  };
}

export function parseAgentServerEvent(
  value: unknown,
  expectedConversationId: string,
): AgentServerEvent {
  if (
    !isRecord(value)
    || typeof value.kind !== "string"
    || value.kind.length < 1
    || value.kind.length > 80
  ) {
    return fail("invalid_server_event", "The authoritative server event is invalid.");
  }
  const base = serverBase(value, expectedConversationId);
  if (value.kind === "session_snapshot") {
    if (
      !Array.isArray(value.messages)
      || value.messages.length > MAX_SESSION_MESSAGES
    ) return fail("invalid_server_event", "The session snapshot is invalid.");
    return Object.freeze({
      ...base,
      kind: "session_snapshot",
      messages: Object.freeze(value.messages.map((message) => parseServerMessage(message))),
      run_state: parseAgentRunState(value.run_state),
    });
  }
  if (value.kind === "assistant_snapshot") {
    if (!safeId(value.request_id)) {
      return fail("invalid_server_event", "The assistant snapshot is invalid.");
    }
    return Object.freeze({
      ...base,
      kind: "assistant_snapshot",
      request_id: value.request_id,
      message: parseServerMessage(value.message, "assistant"),
    });
  }
  if (value.kind === "run_state") {
    return Object.freeze({
      ...base,
      kind: "run_state",
      run_state: parseAgentRunState(value.run_state),
    });
  }
  if (value.kind === "terminal") {
    if (!safeId(value.request_id)) {
      return fail("invalid_server_event", "The terminal request identity is invalid.");
    }
    return Object.freeze({
      ...base,
      kind: "terminal",
      request_id: value.request_id,
      terminal: parseTerminal(value.terminal),
    });
  }
  if (value.kind === "command_ack") {
    if (!safeId(value.request_id) || value.status !== "accepted") {
      return fail("invalid_server_event", "The command acknowledgement is invalid.");
    }
    if (
      value.command_kind === "submit"
      || value.command_kind === "regenerate"
      || value.command_kind === "cancel"
    ) {
      if (!hasExactKeys(value, [
        "type",
        "version",
        "kind",
        "conversation_id",
        "request_id",
        "command_kind",
        "status",
      ])) {
        return fail("invalid_server_event", "The command acknowledgement is invalid.");
      }
      return Object.freeze({
        ...base,
        kind: "command_ack",
        request_id: value.request_id,
        command_kind: value.command_kind,
        status: "accepted",
      });
    }
    if (
      (value.command_kind === "client_tool_result"
        || value.command_kind === "client_tool_approval")
      && typeof value.tool_call_id === "string"
      && TOOL_CALL_ID.test(value.tool_call_id)
      && hasExactKeys(value, [
        "type",
        "version",
        "kind",
        "conversation_id",
        "request_id",
        "command_kind",
        "tool_call_id",
        "status",
      ])
    ) {
      return Object.freeze({
        ...base,
        kind: "command_ack",
        request_id: value.request_id,
        command_kind: value.command_kind,
        tool_call_id: value.tool_call_id,
        status: "accepted",
      });
    }
    return fail("invalid_server_event", "The command acknowledgement is invalid.");
  }
  return Object.freeze({
    ...base,
    kind: "unknown",
    raw_kind: value.kind,
    raw: Object.freeze({
      type: base.type,
      version: base.version,
      kind: value.kind,
      conversation_id: base.conversation_id,
    }),
  });
}

export function canonicalAgentRunState(
  value: AgentRunState,
): string {
  const remembered = runStateCanonicals.get(value);
  if (remembered !== undefined) return remembered;
  if (value.state === "idle") {
    return JSON.stringify({ version: 1, cursor: value.cursor, state: "idle" });
  }
  if (value.state === "running" || value.state === "waiting_for_client") {
    return JSON.stringify({
      version: 1,
      cursor: value.cursor,
      state: value.state,
      request_id: value.request_id,
      run_id: value.run_id,
      root_message_id: value.root_message_id,
    });
  }
  return JSON.stringify({
    version: value.version,
    cursor: value.cursor,
    state: "unknown",
  });
}
