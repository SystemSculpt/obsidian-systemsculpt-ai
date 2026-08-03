export const THIN_AGENT_CONTRACT_VERSION = "thin-agent-v1" as const;
export const THIN_AGENT_CAPABILITY_CONTRACT_VERSION =
  "thin-agent-capabilities-v1" as const;
export const THIN_AGENT_CAPABILITY_MANIFEST_SHA256 =
  "sha256:fb3e72b592556f80d6047339bdef5d82c0570b195f1abc8a8c9a3d7bf162d22c" as const;
export const THIN_AGENT_BOOTSTRAP_PATH =
  "/api/plugin/agent/bootstrap" as const;
export const THIN_AGENT_CONTEXT_PATH =
  "/api/plugin/agent/context" as const;
export const THIN_AGENT_MESSAGES_PATH =
  "/api/plugin/agent/connect/get-messages" as const;
export const THIN_AGENT_TURN_PATH =
  "/api/plugin/agent/turn" as const;

export const THIN_AGENT_CAPABILITIES = Object.freeze([
  Object.freeze({ id: "obsidian.vault", version: 1 as const }),
]);

export const THIN_AGENT_DATA_PART_TYPES = Object.freeze([
  "data-systemsculpt-run-terminal",
  "data-systemsculpt-client-tool-request",
] as const);

export type ThinAgentCapability = Readonly<{
  id: "obsidian.vault";
  version: 1;
}>;

export type ThinAgentCapabilityManifest = Readonly<{
  contract_version: typeof THIN_AGENT_CAPABILITY_CONTRACT_VERSION;
  capabilities: readonly ThinAgentCapability[];
}>;

export type ThinAgentForkRequest = Readonly<{
  source_conversation_id: string;
  before_message_id: string;
}>;

export type ThinAgentBootstrapRequest = Readonly<{
  contract_version: typeof THIN_AGENT_CONTRACT_VERSION;
  conversation_id: string;
  client_id: string;
  plugin_build_id: string;
  capability_manifest: ThinAgentCapabilityManifest;
  fork?: ThinAgentForkRequest;
}>;

export type ThinAgentBootstrapResponse = Readonly<{
  contract_version: typeof THIN_AGENT_CONTRACT_VERSION;
  conversation_id: string;
  session: Readonly<{
    id: string;
  }>;
  access: Readonly<{
    token: string;
    expires_at: string;
  }>;
  accepted_capabilities: readonly ThinAgentCapability[];
  client_input_limits: ThinAgentInputLimits;
}>;

export type ThinAgentContextSource =
  | Readonly<{ kind: "text"; path: string; content: string }>
  | Readonly<{ kind: "image"; path: string; data_url: string }>
  | Readonly<{ kind: "document_ref"; path: string; document_id: string }>;

export type ThinAgentContextRequest = Readonly<{
  contract_version: typeof THIN_AGENT_CONTRACT_VERSION;
  root_message_id: string;
  context_sources: readonly ThinAgentContextSource[];
}>;

export type ThinAgentContextResponse = Readonly<{
  contract_version: typeof THIN_AGENT_CONTRACT_VERSION;
  context_ref: string;
  expires_at: string;
  bytes: number;
  sha256: string;
}>;

export type ThinAgentRunTerminalData =
  | Readonly<{
      version: 1;
      run_id: string;
      root_message_id: string;
      outcome: "succeeded";
      code: "completed";
    }>
  | Readonly<{
      version: 1;
      run_id: string;
      root_message_id: string;
      outcome: "cancelled";
      code: "cancelled";
      message?: string;
    }>
  | Readonly<{
      version: 1;
      run_id: string;
      root_message_id: string;
      outcome: "failed";
      code: string;
      message: string;
      incident_id: string;
      retryable: boolean;
    }>;

export type ThinAgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ThinAgentJsonValue[]
  | Readonly<{ [key: string]: ThinAgentJsonValue }>;

export type ThinAgentClientToolRequestData = Readonly<{
  version: 1;
  tool_call_id: string;
  tool_name: string;
  target: ThinAgentCapability;
  input: ThinAgentJsonValue;
}>;

export type ThinAgentKnownDataPart =
  | Readonly<{
      kind: "known";
      type: "data-systemsculpt-run-terminal";
      data: ThinAgentRunTerminalData;
    }>
  | Readonly<{
      kind: "known";
      type: "data-systemsculpt-client-tool-request";
      data: ThinAgentClientToolRequestData;
    }>;

export type ThinAgentParsedDataPart =
  | ThinAgentKnownDataPart
  | Readonly<{ kind: "unknown"; type: string }>
  | Readonly<{ kind: "invalid"; type: string }>
  | null;

export type ThinAgentContractErrorCode =
  | "unsupported_contract"
  | "invalid_identity"
  | "invalid_capabilities"
  | "invalid_fork"
  | "invalid_bootstrap"
  | "invalid_context";

export class ThinAgentContractError extends Error {
  constructor(
    public readonly code: ThinAgentContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ThinAgentContractError";
  }
}

const CLIENT_ID = /^client_[a-f0-9]{32}$/;
const CONVERSATION_ID = /^conversation_[a-f0-9]{32}$/;
const SESSION_ID = /^session_[a-f0-9]{32}$/;
const RUN_ID = /^run_[a-f0-9]{32}$/;
const INCIDENT_ID = /^incident_[a-f0-9]{32}$/;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{16,4096}$/;
const CONTEXT_REF = /^ctx1_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const DOCUMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_PATH_CHARS = 1_024;
const MAX_CONTEXT_ARTIFACT_BYTES = 24 * 1024 * 1024;
const MAX_CLIENT_TOOL_INPUT_DEPTH = 64;
const MAX_CLIENT_TOOL_INPUT_NODES = 65_536;
const MAX_CLIENT_TOOL_INPUT_TEXT_CHARS = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsPublicTicketMaterial(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object"
      || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (isRecord(current)) {
      if (Object.prototype.hasOwnProperty.call(current, "ticket")) {
        return true;
      }
      pending.push(...Object.values(current));
    } else if (Array.isArray(current)) {
      pending.push(...current);
    }
  }
  return false;
}

function containsRetiredBootstrapShape(
  value: Record<string, unknown>,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, "connection")
    || containsPublicTicketMaterial(value);
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

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= max;
}

type ParsedJsonValue =
  | Readonly<{ ok: true; value: ThinAgentJsonValue }>
  | Readonly<{ ok: false }>;

function parseClientToolInput(value: unknown): ParsedJsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textChars = 0;

  const clone = (candidate: unknown, depth: number): ParsedJsonValue => {
    nodes += 1;
    if (nodes > MAX_CLIENT_TOOL_INPUT_NODES
      || depth > MAX_CLIENT_TOOL_INPUT_DEPTH) return { ok: false };
    if (candidate === null || typeof candidate === "boolean") {
      return { ok: true, value: candidate };
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate)
        ? { ok: true, value: Object.is(candidate, -0) ? 0 : candidate }
        : { ok: false };
    }
    if (typeof candidate === "string") {
      textChars += candidate.length;
      return textChars <= MAX_CLIENT_TOOL_INPUT_TEXT_CHARS
        ? { ok: true, value: candidate }
        : { ok: false };
    }
    if (typeof candidate !== "object" || seen.has(candidate)) {
      return { ok: false };
    }
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_CLIENT_TOOL_INPUT_NODES) return { ok: false };
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some((key) => typeof key !== "string")
        || ownKeys.length !== candidate.length + 1) return { ok: false };
      const output: ThinAgentJsonValue[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return { ok: false };
        const item = clone(descriptor.value, depth + 1);
        if (!item.ok) return item;
        output.push(item.value);
      }
      return { ok: true, value: Object.freeze(output) };
    }

    const prototype = Object.getPrototypeOf(candidate);
    // Obsidian pop-out windows and hardened protocol clones can supply an
    // ordinary record whose Object.prototype belongs to another realm. A
    // plain-object prototype still terminates at null; a class instance does
    // not, so keep rejecting stateful/exotic inputs without realm identity.
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      return { ok: false };
    }
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.length > MAX_CLIENT_TOOL_INPUT_NODES
      || ownKeys.some((key) => typeof key !== "string")) return { ok: false };
    const output: Record<string, ThinAgentJsonValue> = {};
    for (const key of (ownKeys as string[]).sort()) {
      textChars += key.length;
      if (textChars > MAX_CLIENT_TOOL_INPUT_TEXT_CHARS) return { ok: false };
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return { ok: false };
      const item = clone(descriptor.value, depth + 1);
      if (!item.ok) return item;
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: item.value,
        writable: false,
      });
    }
    return { ok: true, value: Object.freeze(output) };
  };

  try {
    return clone(value, 0);
  } catch {
    return { ok: false };
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function imageDataUrlBytes(
  value: unknown,
  limits: ThinAgentInputLimits,
): number | null {
  if (typeof value !== "string") return null;
  const comma = value.indexOf(",");
  if (comma <= 0) return null;
  const metadata = value.slice(0, comma).toLowerCase();
  if (!metadata.startsWith("data:") || !metadata.endsWith(";base64")) return null;
  const mimeType = metadata.slice("data:".length, -";base64".length);
  if (!limits.imageMimeTypes.includes(mimeType)) return null;
  const base64 = value.slice(comma + 1);
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64.test(base64)) {
    return null;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  return bytes > 0 && bytes <= limits.maxImageBytes ? bytes : null;
}

function parseContextSource(
  value: unknown,
  limits: ThinAgentInputLimits,
): ThinAgentContextSource | null {
  if (!isRecord(value)
    || typeof value.kind !== "string"
    || typeof value.path !== "string"
    || value.path.length < 1
    || value.path.length > MAX_PATH_CHARS
    || value.path.includes("\0")) {
    return null;
  }
  if (value.kind === "text"
    && hasExactKeys(value, ["kind", "path", "content"])
    && typeof value.content === "string"
    && utf8Bytes(value.content) <= limits.maxTextBytesPerBlock) {
    return Object.freeze({
      kind: "text",
      path: value.path,
      content: value.content,
    });
  }
  if (value.kind === "image"
    && hasExactKeys(value, ["kind", "path", "data_url"])
    && imageDataUrlBytes(value.data_url, limits) !== null) {
    return Object.freeze({
      kind: "image",
      path: value.path,
      data_url: value.data_url as string,
    });
  }
  if (value.kind === "document_ref"
    && hasExactKeys(value, ["kind", "path", "document_id"])
    && typeof value.document_id === "string"
    && DOCUMENT_ID.test(value.document_id)) {
    return Object.freeze({
      kind: "document_ref",
      path: value.path,
      document_id: value.document_id,
    });
  }
  return null;
}

export function parseThinAgentContextRequest(
  value: unknown,
  limits: ThinAgentInputLimits,
): ThinAgentContextRequest {
  if (!isRecord(value)
    || !hasExactKeys(
      value,
      ["contract_version", "root_message_id", "context_sources"],
    )
    || value.contract_version !== THIN_AGENT_CONTRACT_VERSION
    || typeof value.root_message_id !== "string"
    || !MESSAGE_ID.test(value.root_message_id)
    || !Array.isArray(value.context_sources)
    || value.context_sources.length > limits.maxContentBlocksPerMessage) {
    throw new ThinAgentContractError(
      "invalid_context",
      "The selected vault context request is invalid.",
    );
  }
  const contextSources = value.context_sources.map((source) =>
    parseContextSource(source, limits));
  if (contextSources.some((source) => source === null)) {
    throw new ThinAgentContractError(
      "invalid_context",
      "A selected context source is malformed.",
    );
  }
  const sources = contextSources as ThinAgentContextSource[];
  let textBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  for (const source of sources) {
    if (source.kind === "text") {
      textBytes += utf8Bytes(source.path) + utf8Bytes(source.content);
    } else if (source.kind === "image") {
      imageCount += 1;
      imageBytes += imageDataUrlBytes(source.data_url, limits) ?? 0;
    }
  }
  if (textBytes > limits.maxTotalTextBytes
    || imageCount > limits.maxImagesPerTurn
    || imageBytes > limits.maxTotalImageBytes) {
    throw new ThinAgentContractError(
      "invalid_context",
      "Selected vault context is too large.",
    );
  }
  return Object.freeze({
    contract_version: THIN_AGENT_CONTRACT_VERSION,
    root_message_id: value.root_message_id,
    context_sources: Object.freeze(sources),
  });
}

function parseCapabilityList(value: unknown): readonly ThinAgentCapability[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new ThinAgentContractError(
      "invalid_capabilities",
      "A supported client capability is required.",
    );
  }
  const capabilities: ThinAgentCapability[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ["id", "version"])) {
      throw new ThinAgentContractError(
        "invalid_capabilities",
        "Client capabilities may contain only an ID and version.",
      );
    }
    if (item.id !== "obsidian.vault" || item.version !== 1) {
      throw new ThinAgentContractError(
        "invalid_capabilities",
        "The client requires an unsupported capability version.",
      );
    }
    const key = `${item.id}@${item.version}`;
    if (seen.has(key)) {
      throw new ThinAgentContractError(
        "invalid_capabilities",
        "Client capabilities must be unique.",
      );
    }
    seen.add(key);
    capabilities.push(Object.freeze({ id: item.id, version: item.version }));
  }
  return Object.freeze(capabilities.sort((left, right) =>
    left.id.localeCompare(right.id) || left.version - right.version));
}

export function parseThinAgentCapabilityManifest(
  value: unknown,
): ThinAgentCapabilityManifest {
  if (!isRecord(value)
    || !hasExactKeys(value, ["contract_version", "capabilities"])) {
    throw new ThinAgentContractError(
      "invalid_capabilities",
      "The client capability manifest is malformed.",
    );
  }
  if (value.contract_version !== THIN_AGENT_CAPABILITY_CONTRACT_VERSION) {
    throw new ThinAgentContractError(
      "invalid_capabilities",
      "The client capability manifest version is unsupported.",
    );
  }
  return Object.freeze({
    contract_version: THIN_AGENT_CAPABILITY_CONTRACT_VERSION,
    capabilities: parseCapabilityList(value.capabilities),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function canonicalizeThinAgentCapabilityManifest(value: unknown): string {
  return stableJson(parseThinAgentCapabilityManifest(value));
}

function parseFork(value: unknown, conversationId: string): ThinAgentForkRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ["source_conversation_id", "before_message_id"])
    || typeof value.source_conversation_id !== "string"
    || !CONVERSATION_ID.test(value.source_conversation_id)
    || value.source_conversation_id === conversationId
    || typeof value.before_message_id !== "string"
    || !MESSAGE_ID.test(value.before_message_id)) {
    throw new ThinAgentContractError(
      "invalid_fork",
      "The edited conversation request is invalid.",
    );
  }
  return Object.freeze({
    source_conversation_id: value.source_conversation_id,
    before_message_id: value.before_message_id,
  });
}

export function parseThinAgentBootstrapRequest(
  value: unknown,
): ThinAgentBootstrapRequest {
  const required = [
    "contract_version",
    "conversation_id",
    "client_id",
    "plugin_build_id",
    "capability_manifest",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, required, ["fork"])) {
    throw new ThinAgentContractError(
      "invalid_bootstrap",
      "The request to start this chat is invalid.",
    );
  }
  if (value.contract_version !== THIN_AGENT_CONTRACT_VERSION) {
    throw new ThinAgentContractError(
      "unsupported_contract",
      "This SystemSculpt version is not supported. Update the plugin and try again.",
    );
  }
  if (typeof value.conversation_id !== "string"
    || !CONVERSATION_ID.test(value.conversation_id)
    || typeof value.client_id !== "string"
    || !CLIENT_ID.test(value.client_id)
    || typeof value.plugin_build_id !== "string"
    || !SHA256_ID.test(value.plugin_build_id)) {
    throw new ThinAgentContractError(
      "invalid_identity",
      "The plugin artifact or client conversation identity is invalid.",
    );
  }
  const capabilityManifest = parseThinAgentCapabilityManifest(value.capability_manifest);
  return Object.freeze({
    contract_version: THIN_AGENT_CONTRACT_VERSION,
    conversation_id: value.conversation_id,
    client_id: value.client_id,
    plugin_build_id: value.plugin_build_id,
    capability_manifest: capabilityManifest,
    ...(value.fork === undefined
      ? {}
      : { fork: parseFork(value.fork, value.conversation_id) }),
  });
}

function parseTimestamp(value: unknown): value is string {
  return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

export function parseThinAgentBootstrapResponse(
  value: unknown,
  expected?: Readonly<{
    conversation_id: string;
  }>,
): ThinAgentBootstrapResponse {
  if (!isRecord(value)
    || containsRetiredBootstrapShape(value)
    || value.contract_version !== THIN_AGENT_CONTRACT_VERSION
    || typeof value.conversation_id !== "string"
    || !CONVERSATION_ID.test(value.conversation_id)
    || !isRecord(value.session)
    || typeof value.session.id !== "string"
    || !SESSION_ID.test(value.session.id)
    || !isRecord(value.access)
    || typeof value.access.token !== "string"
    || !ACCESS_TOKEN.test(value.access.token)
    || !parseTimestamp(value.access.expires_at)) {
    throw new ThinAgentContractError(
      "invalid_bootstrap",
      "SystemSculpt returned an invalid response while starting this chat.",
    );
  }
  const acceptedCapabilities = parseCapabilityList(value.accepted_capabilities);
  let clientInputLimits: ThinAgentInputLimits;
  try {
    clientInputLimits = parseThinAgentInputLimits(value.client_input_limits);
  } catch {
    throw new ThinAgentContractError(
      "invalid_bootstrap",
      "SystemSculpt returned invalid attachment limits.",
    );
  }
  if (expected
    && value.conversation_id !== expected.conversation_id) {
    throw new ThinAgentContractError(
      "invalid_identity",
      "SystemSculpt returned a response for a different conversation.",
    );
  }
  return Object.freeze({
    contract_version: THIN_AGENT_CONTRACT_VERSION,
    conversation_id: value.conversation_id,
    session: Object.freeze({
      id: value.session.id,
    }),
    access: Object.freeze({
      token: value.access.token,
      expires_at: value.access.expires_at,
    }),
    accepted_capabilities: acceptedCapabilities,
    client_input_limits: clientInputLimits,
  });
}

export function parseThinAgentContextResponse(
  value: unknown,
): ThinAgentContextResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "contract_version",
      "context_ref",
      "expires_at",
      "bytes",
      "sha256",
    ])
    || value.contract_version !== THIN_AGENT_CONTRACT_VERSION
    || typeof value.context_ref !== "string"
    || !CONTEXT_REF.test(value.context_ref)
    || !parseTimestamp(value.expires_at)
    || typeof value.bytes !== "number"
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 2
    || value.bytes > MAX_CONTEXT_ARTIFACT_BYTES
    || typeof value.sha256 !== "string"
    || !SHA256_ID.test(value.sha256)) {
    throw new ThinAgentContractError(
      "invalid_context",
      "SystemSculpt returned an invalid vault context response.",
    );
  }
  return Object.freeze({
    contract_version: THIN_AGENT_CONTRACT_VERSION,
    context_ref: value.context_ref,
    expires_at: value.expires_at,
    bytes: value.bytes,
    sha256: value.sha256,
  });
}

function knownDataPart<T extends ThinAgentKnownDataPart>(
  value: T,
): T {
  return Object.freeze(value);
}

function parseRunTerminal(
  type: "data-systemsculpt-run-terminal",
  data: Record<string, unknown>,
): ThinAgentParsedDataPart {
  if (data.version !== 1
    || typeof data.run_id !== "string"
    || !RUN_ID.test(data.run_id)
    || typeof data.root_message_id !== "string"
    || !MESSAGE_ID.test(data.root_message_id)) {
    return { kind: "invalid", type };
  }
  if (data.outcome === "succeeded") {
    if (data.code !== "completed"
      || data.message !== undefined
      || data.incident_id !== undefined
      || data.retryable !== undefined) {
      return { kind: "invalid", type };
    }
    return knownDataPart({
      kind: "known",
      type,
      data: Object.freeze({
        version: 1,
        run_id: data.run_id,
        root_message_id: data.root_message_id,
        outcome: "succeeded",
        code: "completed",
      }),
    });
  }
  if (data.outcome === "cancelled") {
    if (data.code !== "cancelled"
      || (data.message !== undefined && !boundedString(data.message, 512))
      || data.incident_id !== undefined
      || data.retryable !== undefined) {
      return { kind: "invalid", type };
    }
    return knownDataPart({
      kind: "known",
      type,
      data: Object.freeze({
        version: 1,
        run_id: data.run_id,
        root_message_id: data.root_message_id,
        outcome: "cancelled",
        code: "cancelled",
        ...(typeof data.message === "string" ? { message: data.message } : {}),
      }),
    });
  }
  if (data.outcome !== "failed"
    || typeof data.code !== "string"
    || !ERROR_CODE.test(data.code)
    || !boundedString(data.message, 512)
    || typeof data.incident_id !== "string"
    || !INCIDENT_ID.test(data.incident_id)
    || typeof data.retryable !== "boolean") {
    return { kind: "invalid", type };
  }
  return knownDataPart({
    kind: "known",
    type,
    data: Object.freeze({
      version: 1,
      run_id: data.run_id,
      root_message_id: data.root_message_id,
      outcome: "failed",
      code: data.code,
      message: data.message,
      incident_id: data.incident_id,
      retryable: data.retryable,
    }),
  });
}

function parseClientToolRequest(
  type: "data-systemsculpt-client-tool-request",
  data: Record<string, unknown>,
): ThinAgentParsedDataPart {
  if (data.version !== 1
    || !boundedString(data.tool_call_id, 512)
    || typeof data.tool_name !== "string"
    || !TOOL_NAME.test(data.tool_name)
    || !isRecord(data.target)
    || data.target.id !== "obsidian.vault"
    || data.target.version !== 1) {
    return { kind: "invalid", type };
  }
  const input = parseClientToolInput(data.input);
  if (!input.ok) return { kind: "invalid", type };
  return knownDataPart({
    kind: "known",
    type,
    data: Object.freeze({
      version: 1,
      tool_call_id: data.tool_call_id,
      tool_name: data.tool_name,
      target: Object.freeze({
        id: "obsidian.vault",
        version: 1,
      }),
      input: input.value,
    }),
  });
}

/**
 * Parse only SystemSculpt application data parts. Unknown data part types and
 * unknown fields on known parts are ignored so server additions do not strand
 * a released client. Invalid payloads for a known type are surfaced without
 * interpreting partial data.
 */
export function parseThinAgentDataPart(value: unknown): ThinAgentParsedDataPart {
  if (!isRecord(value) || typeof value.type !== "string"
    || !value.type.startsWith("data-")) return null;
  if (!THIN_AGENT_DATA_PART_TYPES.includes(
    value.type as (typeof THIN_AGENT_DATA_PART_TYPES)[number],
  )) {
    return Object.freeze({ kind: "unknown", type: value.type });
  }
  if (!isRecord(value.data)) {
    return Object.freeze({ kind: "invalid", type: value.type });
  }
  switch (value.type) {
    case "data-systemsculpt-run-terminal":
      return parseRunTerminal(value.type, value.data);
    case "data-systemsculpt-client-tool-request":
      return parseClientToolRequest(value.type, value.data);
    default:
      return Object.freeze({ kind: "unknown", type: value.type });
  }
}
import {
  parseThinAgentInputLimits,
  type ThinAgentInputLimits,
} from "./ThinAgentInputLimits";
