import type { ChatMessage, MultiPartContent } from "../../../types";
import type { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type { AcceptedChatOperation, JsonContractValue } from "../../../services/managed/ManagedTypes";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";

export type ManagedChatRuntimeEvent =
  | Readonly<{ kind: "content_delta"; text: string }>
  | Readonly<{ kind: "reasoning_delta"; text: string }>
  | Readonly<{ kind: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }>
  | Readonly<{ kind: "finish_reason"; reason: string }>
  | Readonly<{ kind: "request_id"; requestId: string }>
  | Readonly<{ kind: "usage"; promptTokens?: number; completionTokens?: number; totalTokens?: number; costTotal?: number }>;

export type ManagedChatDiagnostic = Readonly<{ status?: number; code?: string; requestId?: string }>;

type FailureKind = "transport_failure" | "aborted" | "capability_request" | "license" | "credits"
  | "operation_in_progress" | "operation_already_completed" | "operation_terminal" | "settlement_pending"
  | "plugin_version" | "rate_limit" | "unavailable";
export type ManagedChatDispatchResult =
  | Readonly<{ kind: "success"; events: readonly ManagedChatRuntimeEvent[]; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: "empty"; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: FailureKind; diagnostic: ManagedChatDiagnostic }>;

export type ManagedChatTool = Readonly<{
  type: "function";
  function: Readonly<{ name: string; description?: string; parameters?: Readonly<{ [key: string]: JsonContractValue }> }>;
}>;
export type ManagedChatToolChoice = "auto" | "none" | "required";
export type ManagedChatDispatchInput = Readonly<{
  operation: AcceptedChatOperation;
  snapshot: ChatTranscriptSnapshot;
  phase: "initial" | "continuation";
  continuationIndex: number;
  tools?: readonly ManagedChatTool[];
  toolChoice?: ManagedChatToolChoice;
  signal?: AbortSignal;
}>;

type JsonObject = { readonly [key: string]: JsonContractValue };
type OperationRegistry = Map<string, Promise<ManagedChatDispatchResult>>;
const MAX_TOOL_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;

function bounded(value: string | null, limit: number): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, limit);
  return cleaned.length > 0 ? cleaned : undefined;
}

function statusValue(status: number): number | undefined {
  return Number.isFinite(status) && Number.isInteger(status) ? status : undefined;
}

function ownKeysExactly(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isDataUrl(value: string): boolean {
  return /^data:[^,]+,[\s\S]*$/.test(value);
}

function wireContent(content: string | readonly MultiPartContent[]): JsonContractValue | null {
  if (typeof content === "string") return content;
  const parts: JsonContractValue[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (!ownKeysExactly(part, ["type", "text"]) || typeof part.text !== "string") return null;
      parts.push({ type: "text", text: part.text });
    } else {
      if (!ownKeysExactly(part, ["type", "image_url"]) || !ownKeysExactly(part.image_url, ["url"]) || !isDataUrl(part.image_url.url)) return null;
      parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
    }
  }
  return parts.length > 0 ? parts : null;
}

function isJsonValue(value: JsonContractValue): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value).every(isJsonValue);
}

function isJsonSchemaObject(value: Readonly<{ [key: string]: JsonContractValue }>): boolean {
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value).every(isJsonValue);
}

function validateTools(tools: readonly ManagedChatTool[]): JsonContractValue[] | null {
  const serialized: JsonContractValue[] = [];
  for (const tool of tools) {
    if (!ownKeysExactly(tool, ["type", "function"]) || tool.type !== "function") return null;
    const fn = tool.function;
    const allowed = ["name", ...(typeof fn.description === "undefined" ? [] : ["description"]), ...(typeof fn.parameters === "undefined" ? [] : ["parameters"])];
    if (!ownKeysExactly(fn, allowed) || typeof fn.name !== "string" || fn.name.length === 0) return null;
    if (typeof fn.description !== "undefined" && typeof fn.description !== "string") return null;
    if (typeof fn.parameters !== "undefined" && !isJsonSchemaObject(fn.parameters)) return null;
    serialized.push({ type: "function", function: {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters ? { parameters: fn.parameters } : {}),
    } });
  }
  return serialized;
}

function wireMessage(message: Readonly<ChatMessage>): JsonObject | null {
  const result: Record<string, JsonContractValue> = { role: message.role };
  if (message.role === "system") {
    if (typeof message.content !== "string") return null;
    result.content = message.content;
  } else if (message.role === "user") {
    if (message.content === null) return null;
    const content = wireContent(message.content);
    if (content === null) return null;
    result.content = content;
  } else if (message.role === "tool") {
    if (typeof message.content !== "string" || !message.tool_call_id) return null;
    result.content = message.content;
    result.tool_call_id = message.tool_call_id;
    if (message.name) result.name = message.name;
  } else {
    if (typeof message.content === "string") result.content = message.content;
    else if (message.content !== null) return null;
    if (message.reasoning) result.reasoning_content = message.reasoning;
    if (message.tool_calls?.length) {
      result.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.request.function.name, arguments: call.request.function.arguments },
      }));
    }
    if (typeof result.content === "undefined" && typeof result.reasoning_content === "undefined" && typeof result.tool_calls === "undefined") return null;
  }
  return result;
}

function isJsonArray(value: JsonContractValue): value is readonly JsonContractValue[] {
  return Array.isArray(value);
}

function asObject(value: JsonContractValue): JsonObject | null {
  return value !== null && typeof value === "object" && !isJsonArray(value) ? value as JsonObject : null;
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUsableBoundedToolIdentifier(value: string, limit: number): boolean {
  return value.length <= limit && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function optionalFiniteNumber(object: JsonObject, key: string): number | undefined | null {
  if (typeof object[key] === "undefined") return undefined;
  const value = finiteNumber(object, key);
  return typeof value === "number" ? value : null;
}

function normalizeFrame(value: JsonContractValue): readonly ManagedChatRuntimeEvent[] | null {
  const object = asObject(value);
  if (!object || typeof object.error !== "undefined") return null;
  if (!isJsonArray(object.choices)) return null;
  const events: ManagedChatRuntimeEvent[] = [];
  if (typeof object.id !== "undefined" && typeof object.id !== "string") return null;
  const requestId = stringField(object, "id");
  if (requestId) events.push({ kind: "request_id", requestId });
  for (const choiceValue of object.choices) {
    const choice = asObject(choiceValue);
    if (!choice) return null;
    const hasDelta = typeof choice.delta !== "undefined";
    const hasFinish = typeof choice.finish_reason !== "undefined" && choice.finish_reason !== null;
    if (!hasDelta && !hasFinish) return null;
    if (hasDelta) {
      const delta = asObject(choice.delta ?? null);
      if (!delta) return null;
      for (const field of Object.keys(delta)) {
        if (!["role", "content", "text", "reasoning_content", "tool_calls"].includes(field)) return null;
      }
      if (typeof delta.role !== "undefined" && typeof delta.role !== "string") return null;
      if (typeof delta.content !== "undefined" && typeof delta.content !== "string" && delta.content !== null) return null;
      if (typeof delta.text !== "undefined" && typeof delta.text !== "string") return null;
      if (typeof delta.reasoning_content !== "undefined" && typeof delta.reasoning_content !== "string" && delta.reasoning_content !== null) return null;
      const content = stringField(delta, "content") ?? stringField(delta, "text");
      if (content) events.push({ kind: "content_delta", text: content });
      const reasoning = stringField(delta, "reasoning_content");
      if (reasoning) events.push({ kind: "reasoning_delta", text: reasoning });
      if (typeof delta.tool_calls !== "undefined") {
        if (!isJsonArray(delta.tool_calls)) return null;
        for (const callValue of delta.tool_calls) {
          const call = asObject(callValue);
          if (!call) return null;
          for (const field of Object.keys(call)) if (!["index", "id", "type", "function"].includes(field)) return null;
          const index = finiteNumber(call, "index");
          if (typeof index === "undefined" || !Number.isInteger(index) || index < 0) return null;
          if (typeof call.id !== "undefined" && (typeof call.id !== "string" || !isUsableBoundedToolIdentifier(call.id, MAX_TOOL_CALL_ID_LENGTH))) return null;
          if (typeof call.type !== "undefined" && call.type !== "function") return null;
          let name: string | undefined;
          let argumentsDelta: string | undefined;
          if (typeof call.function !== "undefined") {
            const fn = asObject(call.function);
            if (!fn || !Object.keys(fn).every((field) => field === "name" || field === "arguments")) return null;
            if (typeof fn.name !== "undefined" && (typeof fn.name !== "string" || !isUsableBoundedToolIdentifier(fn.name, MAX_TOOL_NAME_LENGTH))) return null;
            if (typeof fn.arguments !== "undefined" && typeof fn.arguments !== "string") return null;
            name = stringField(fn, "name");
            argumentsDelta = stringField(fn, "arguments");
            if (typeof name === "undefined" && typeof argumentsDelta === "undefined") return null;
          }
          const id = stringField(call, "id");
          if (typeof id === "undefined" && typeof name === "undefined" && typeof argumentsDelta === "undefined") return null;
          events.push({ kind: "tool_call_delta", index, ...(id ? { id } : {}), ...(name ? { name } : {}), ...(typeof argumentsDelta === "string" ? { arguments: argumentsDelta } : {}) });
        }
      }
    }
    if (typeof choice.finish_reason === "string") events.push({ kind: "finish_reason", reason: choice.finish_reason });
    else if (choice.finish_reason !== null && typeof choice.finish_reason !== "undefined") return null;
  }
  if (typeof object.usage !== "undefined" && object.usage !== null) {
    const usage = asObject(object.usage);
    if (!usage) return null;
    for (const field of Object.keys(usage)) if (!["prompt_tokens", "completion_tokens", "total_tokens", "cost"].includes(field)) return null;
    const promptTokens = optionalFiniteNumber(usage, "prompt_tokens");
    const completionTokens = optionalFiniteNumber(usage, "completion_tokens");
    const totalTokens = optionalFiniteNumber(usage, "total_tokens");
    if (promptTokens === null || completionTokens === null || totalTokens === null) return null;
    let costTotal: number | undefined;
    if (typeof usage.cost !== "undefined") {
      const cost = asObject(usage.cost);
      if (!cost || !ownKeysExactly(cost, ["total"])) return null;
      const total = optionalFiniteNumber(cost, "total");
      if (total === null || typeof total === "undefined") return null;
      costTotal = total;
    }
    if (typeof promptTokens === "undefined" && typeof completionTokens === "undefined" && typeof totalTokens === "undefined" && typeof costTotal === "undefined") return null;
    events.push({ kind: "usage", ...(typeof promptTokens === "number" ? { promptTokens } : {}), ...(typeof completionTokens === "number" ? { completionTokens } : {}), ...(typeof totalTokens === "number" ? { totalTokens } : {}), ...(typeof costTotal === "number" ? { costTotal } : {}) });
  }
  return events;
}

async function hashKey(preimage: string): Promise<string> {
  const bytes = new TextEncoder().encode(preimage);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function managedChatOperationKey(durableTurnId: string, phase: "initial" | "continuation", continuationIndex: number): Promise<string> {
  const index = phase === "initial" ? 0 : continuationIndex;
  return hashKey(`managed-chat-v1|${durableTurnId}|${phase}|${index}`);
}

export class ManagedChatRuntimeAdapter {
  private readonly registry = new WeakMap<AcceptedChatOperation, OperationRegistry>();
  private readonly terminal = new WeakSet<AcceptedChatOperation>();

  public constructor(private readonly client: ManagedCapabilityClient) {}

  public dispatch(input: ManagedChatDispatchInput): Promise<ManagedChatDispatchResult> {
    const validOrdinal = Number.isInteger(input.continuationIndex) && input.continuationIndex >= 0 &&
      (input.phase === "continuation" || (input.continuationIndex === 0 && input.snapshot === input.operation.initialDurableSnapshot));
    if (!validOrdinal) return Promise.resolve({ kind: "transport_failure", diagnostic: {} });
    if (this.terminal.has(input.operation)) return Promise.resolve({ kind: "operation_terminal", diagnostic: {} });
    let operations = this.registry.get(input.operation);
    if (!operations) {
      operations = new Map();
      this.registry.set(input.operation, operations);
    }
    const localKey = `${input.phase}:${input.phase === "initial" ? 0 : input.continuationIndex}`;
    const existing = operations.get(localKey);
    if (existing) return existing;
    const pending = this.perform(input);
    operations.set(localKey, pending);
    return pending;
  }

  public notifyDurablyTerminal(operation: AcceptedChatOperation): void {
    this.terminal.add(operation);
    this.registry.delete(operation);
  }

  public hasRetainedEntries(operation: AcceptedChatOperation): boolean {
    return (this.registry.get(operation)?.size ?? 0) > 0;
  }

  private async perform(input: ManagedChatDispatchInput): Promise<ManagedChatDispatchResult> {
    const ticket = this.client.beginAcceptedChatDispatch();
    if (!ticket) return { kind: "transport_failure", diagnostic: {} };
    if (
      !input.operation.durableTurnId || input.continuationIndex < 0 || !Number.isInteger(input.continuationIndex) ||
      (input.phase === "initial" && (input.continuationIndex !== 0 || input.snapshot !== input.operation.initialDurableSnapshot))
    ) {
      return { kind: "transport_failure", diagnostic: {} };
    }
    const messages: JsonContractValue[] = [];
    for (const message of input.snapshot.messages) {
      const serialized = wireMessage(message);
      if (!serialized) return { kind: "transport_failure", diagnostic: {} };
      messages.push(serialized);
    }
    if (messages.length === 0) return { kind: "transport_failure", diagnostic: {} };
    const body: Record<string, JsonContractValue> = {
      model: "ai-agent",
      stream: true,
      messages,
    };
    if (input.tools) {
      const tools = validateTools(input.tools);
      if (!tools) return { kind: "transport_failure", diagnostic: {} };
      body.tools = tools;
    }
    if (typeof input.toolChoice !== "undefined") {
      if (input.toolChoice !== "auto" && input.toolChoice !== "none" && input.toolChoice !== "required") return { kind: "transport_failure", diagnostic: {} };
      body.tool_choice = input.toolChoice;
    }
    const key = await managedChatOperationKey(input.operation.durableTurnId, input.phase, input.continuationIndex);
    try {
      const transport = await this.client.streamAcceptedChat(ticket, input.operation.lease, body, key, input.signal);
      const status = statusValue(transport.response.status);
      const requestId = bounded(transport.diagnostics.requestId, 128);
      const diagnostic: ManagedChatDiagnostic = {
        ...(typeof status === "number" ? { status } : {}),
        ...(requestId ? { requestId } : {}),
      };
      if (!transport.response.ok) return this.statusResult(transport.response.status, transport.diagnostics.errorText, diagnostic);
      return await this.parseStream(transport.response, diagnostic, input.signal);
    } catch {
      if (input.signal?.aborted) return { kind: "aborted", diagnostic: {} };
      return { kind: "transport_failure", diagnostic: {} };
    }
  }

  private statusResult(status: number, errorText: string, base: ManagedChatDiagnostic): ManagedChatDispatchResult {
    let rawCode: string | undefined;
    try {
      const parsed: JsonContractValue = JSON.parse(errorText) as JsonContractValue;
      const object = asObject(parsed);
      rawCode = object ? stringField(object, "code") : undefined;
    } catch { rawCode = undefined; }
    const code = bounded(rawCode ?? null, 64);
    const diagnostic: ManagedChatDiagnostic = { ...base, ...(code ? { code } : {}) };
    if (status === 400) return { kind: "capability_request", diagnostic };
    if (status === 401 || status === 403) return { kind: "license", diagnostic };
    if (status === 402) return { kind: "credits", diagnostic };
    if (status === 426) return { kind: "plugin_version", diagnostic };
    if (status === 429) return { kind: "rate_limit", diagnostic };
    if (status === 503) return { kind: "unavailable", diagnostic };
    if (status === 409) {
      const exact: Readonly<Record<string, FailureKind>> = {
        operation_in_progress: "operation_in_progress",
        operation_already_completed: "operation_already_completed",
        operation_terminal: "operation_terminal",
        settlement_pending: "settlement_pending",
      };
      const kind = rawCode ? exact[rawCode] : undefined;
      if (kind) return { kind, diagnostic };
    }
    return { kind: "transport_failure", diagnostic };
  }

  private async parseStream(response: Response, diagnostic: ManagedChatDiagnostic, signal?: AbortSignal): Promise<ManagedChatDispatchResult> {
    if (!response.body) return { kind: "transport_failure", diagnostic };
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const events: ManagedChatRuntimeEvent[] = [];
    let line = "";
    let pendingCr = false;
    let data: string[] = [];
    let doneSeen = false;
    const dispatchEvent = (): boolean => {
      if (data.length === 0) return true;
      const payload = data.join("\n");
      data = [];
      if (payload === "[DONE]") {
        if (doneSeen) return false;
        doneSeen = true;
        return true;
      }
      if (doneSeen) return false;
      try {
        const parsed: JsonContractValue = JSON.parse(payload) as JsonContractValue;
        const normalized = normalizeFrame(parsed);
        if (!normalized) return false;
        events.push(...normalized);
        return true;
      } catch { return false; }
    };
    const processLine = (value: string): boolean => {
      if (value === "") return dispatchEvent();
      if (value.startsWith(":")) return true;
      const colon = value.indexOf(":");
      const field = colon < 0 ? value : value.slice(0, colon);
      let fieldValue = colon < 0 ? "" : value.slice(colon + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "data") data.push(fieldValue);
      return true;
    };
    const consume = (text: string): boolean => {
      for (const character of text) {
        if (doneSeen) return false;
        if (pendingCr) {
          if (character === "\n") {
            pendingCr = false;
            if (!processLine(line)) return false;
            line = "";
            continue;
          }
          line += "\r";
          pendingCr = false;
        }
        if (character === "\r") pendingCr = true;
        else if (character === "\n") { if (!processLine(line)) return false; line = ""; }
        else line += character;
      }
      return true;
    };
    try {
      while (true) {
        if (signal?.aborted) { await reader.cancel(); return { kind: "aborted", diagnostic }; }
        const chunk = signal
          ? await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
              const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
            })
          : await reader.read();
        if (chunk.done) break;
        if (!consume(decoder.decode(chunk.value, { stream: true }))) return { kind: "transport_failure", diagnostic };
      }
      if (!consume(decoder.decode())) return { kind: "transport_failure", diagnostic };
      if (pendingCr) line += "\r";
      if (line.length > 0 || data.length > 0) return { kind: "transport_failure", diagnostic };
      if (!doneSeen) return { kind: "transport_failure", diagnostic };
      return events.length > 0 ? { kind: "success", events, diagnostic } : { kind: "empty", diagnostic };
    } catch {
      if (signal?.aborted) {
        await reader.cancel();
        return { kind: "aborted", diagnostic };
      }
      return { kind: "transport_failure", diagnostic };
    } finally {
      reader.releaseLock();
    }
  }
}
