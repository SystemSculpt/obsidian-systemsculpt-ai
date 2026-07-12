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

export type ManagedChatDispatchInput = Readonly<{
  operation: AcceptedChatOperation;
  snapshot: ChatTranscriptSnapshot;
  phase: "initial" | "continuation";
  continuationIndex: number;
  tools?: readonly JsonContractValue[];
  toolChoice?: JsonContractValue;
  signal?: AbortSignal;
}>;

type JsonObject = { readonly [key: string]: JsonContractValue };
type OperationRegistry = Map<string, Promise<ManagedChatDispatchResult>>;

function bounded(value: string | null, limit: number): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, limit);
  return cleaned.length > 0 ? cleaned : undefined;
}

function statusValue(status: number): number | undefined {
  return Number.isFinite(status) && Number.isInteger(status) ? status : undefined;
}

function wireContent(content: string | readonly MultiPartContent[] | null): JsonContractValue {
  if (content === null || typeof content === "string") return content;
  const parts: JsonContractValue[] = [];
  for (const part of content) {
    parts.push(part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: part.image_url.url } });
  }
  return parts;
}

function wireMessage(message: Readonly<ChatMessage>): JsonObject | null {
  const result: Record<string, JsonContractValue> = { role: message.role };
  if (message.role === "system") {
    if (typeof message.content !== "string") return null;
    result.content = message.content;
  } else if (message.role === "user") {
    if (message.content === null) return null;
    result.content = wireContent(message.content);
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

function asObject(value: JsonContractValue): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeFrame(value: JsonContractValue): readonly ManagedChatRuntimeEvent[] | null {
  const object = asObject(value);
  if (!object || asObject(object.error ?? null)) return null;
  const events: ManagedChatRuntimeEvent[] = [];
  const requestId = stringField(object, "id");
  if (requestId) events.push({ kind: "request_id", requestId });
  const choices = object.choices;
  if (Array.isArray(choices)) {
    for (const choiceValue of choices) {
      const choice = asObject(choiceValue);
      if (!choice) return null;
      const delta = asObject(choice.delta ?? null);
      if (delta) {
        const content = stringField(delta, "content") ?? stringField(delta, "text");
        if (content) events.push({ kind: "content_delta", text: content });
        const reasoning = stringField(delta, "reasoning_content");
        if (reasoning) events.push({ kind: "reasoning_delta", text: reasoning });
        const calls = delta.tool_calls;
        if (Array.isArray(calls)) {
          for (const callValue of calls) {
            const call = asObject(callValue);
            if (!call) return null;
            const index = finiteNumber(call, "index");
            if (typeof index === "undefined" || !Number.isInteger(index) || index < 0) return null;
            const fn = asObject(call.function ?? null);
            events.push({ kind: "tool_call_delta", index, id: stringField(call, "id"), name: fn ? stringField(fn, "name") : undefined, arguments: fn ? stringField(fn, "arguments") : undefined });
          }
        }
      }
      const finish = choice.finish_reason;
      if (typeof finish === "string") events.push({ kind: "finish_reason", reason: finish });
      else if (finish !== null && typeof finish !== "undefined") return null;
    }
  } else if (typeof choices !== "undefined") return null;
  const usage = asObject(object.usage ?? null);
  if (usage) {
    const cost = asObject(usage.cost ?? null);
    events.push({ kind: "usage", promptTokens: finiteNumber(usage, "prompt_tokens"), completionTokens: finiteNumber(usage, "completion_tokens"), totalTokens: finiteNumber(usage, "total_tokens"), costTotal: cost ? finiteNumber(cost, "total") : undefined });
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
    if (!this.client.managedChatConfigurationReady()) return { kind: "transport_failure", diagnostic: {} };
    if (
      !input.operation.durableTurnId || input.continuationIndex < 0 || !Number.isInteger(input.continuationIndex) ||
      (input.phase === "initial" && input.snapshot !== input.operation.initialDurableSnapshot)
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
    if (input.tools) body.tools = input.tools;
    if (typeof input.toolChoice !== "undefined") body.tool_choice = input.toolChoice;
    const key = await managedChatOperationKey(input.operation.durableTurnId, input.phase, input.continuationIndex);
    try {
      const transport = await this.client.streamAcceptedChat(input.operation.lease, body, key, input.signal);
      const status = statusValue(transport.response.status);
      const requestId = bounded(transport.diagnostics.requestId, 128);
      const diagnostic: ManagedChatDiagnostic = {
        ...(typeof status === "number" ? { status } : {}),
        ...(requestId ? { requestId } : {}),
      };
      if (!transport.response.ok) return this.statusResult(transport.response.status, transport.diagnostics.errorText, diagnostic);
      return await this.parseStream(transport.response, diagnostic, input.signal);
    } catch (error) {
      if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return { kind: "aborted", diagnostic: {} };
      return { kind: "transport_failure", diagnostic: {} };
    }
  }

  private statusResult(status: number, errorText: string, base: ManagedChatDiagnostic): ManagedChatDispatchResult {
    let code: string | undefined;
    try {
      const parsed: JsonContractValue = JSON.parse(errorText) as JsonContractValue;
      const object = asObject(parsed);
      code = object ? bounded(stringField(object, "code") ?? null, 64) : undefined;
    } catch { code = undefined; }
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
      const kind = code ? exact[code] : undefined;
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
