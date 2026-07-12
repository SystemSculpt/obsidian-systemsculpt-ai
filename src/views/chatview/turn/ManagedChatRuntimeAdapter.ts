import type { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type { AcceptedChatOperation, JsonContractValue } from "../../../services/managed/ManagedTypes";
import type { AcceptedChatRequestSnapshot, ManagedPreparedMessage } from "../../../services/chat/AcceptedChatRequestSnapshot";
import { composeAcceptedChatContinuation } from "../../../services/chat/AcceptedChatRequestSnapshot";

export type ManagedChatRuntimeEvent =
  | Readonly<{ kind: "content_delta"; text: string }>
  | Readonly<{ kind: "reasoning_delta"; text: string }>
  | Readonly<{ kind: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }>
  | Readonly<{ kind: "tool_call_completed"; index: number; id?: string; name?: string; arguments: string }>
  | Readonly<{ kind: "finish_reason"; reason: string }>
  | Readonly<{ kind: "request_id"; requestId: string }>
  | Readonly<{ kind: "usage"; promptTokens?: number; completionTokens?: number; totalTokens?: number; costTotal?: number }>
  | Readonly<{ kind: "done" }>;

export type ManagedChatDiagnostic = Readonly<{ status?: number; code?: string; requestId?: string }>;

type FailureKind = "transport_failure" | "aborted" | "capability_request" | "license" | "credits"
  | "operation_in_progress" | "operation_already_completed" | "operation_terminal" | "settlement_pending"
  | "plugin_version" | "rate_limit" | "unavailable";
export type ManagedChatDispatchResult =
  | Readonly<{ kind: "success"; events: AsyncIterable<ManagedChatRuntimeEvent>; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: "empty"; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: FailureKind; diagnostic: ManagedChatDiagnostic }>;

export type ManagedChatDispatchInput = Readonly<{
  acceptedRequestSnapshot: AcceptedChatRequestSnapshot;
  phase: "initial" | "continuation";
  continuationIndex: number;
  postCheckpointDurableSnapshot?: import("../transcript/ChatTranscriptTypes").ChatTranscriptSnapshot;
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
      (input.phase === "continuation" || (input.continuationIndex === 0 && input.acceptedRequestSnapshot.durableSnapshot === input.acceptedRequestSnapshot.operation.initialDurableSnapshot));
    if (!validOrdinal) return Promise.resolve({ kind: "transport_failure", diagnostic: {} });
    if (this.terminal.has(input.acceptedRequestSnapshot.operation)) return Promise.resolve({ kind: "operation_terminal", diagnostic: {} });
    let operations = this.registry.get(input.acceptedRequestSnapshot.operation);
    if (!operations) {
      operations = new Map();
      this.registry.set(input.acceptedRequestSnapshot.operation, operations);
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
      !input.acceptedRequestSnapshot.operation.durableTurnId || input.continuationIndex < 0 || !Number.isInteger(input.continuationIndex) ||
      (input.phase === "initial" && (input.continuationIndex !== 0 || input.acceptedRequestSnapshot.durableSnapshot !== input.acceptedRequestSnapshot.operation.initialDurableSnapshot))
    ) {
      return { kind: "transport_failure", diagnostic: {} };
    }
    const accepted = input.acceptedRequestSnapshot;
    const messages: readonly ManagedPreparedMessage[] = input.phase === "initial"
      ? accepted.messages
      : input.postCheckpointDurableSnapshot
        ? composeAcceptedChatContinuation(accepted, input.postCheckpointDurableSnapshot)
        : [];
    if (messages.length === 0 || accepted.model !== "ai-agent") return { kind: "transport_failure", diagnostic: {} };
    const body: Record<string, JsonContractValue> = { model: accepted.model, stream: true, messages };
    if (accepted.tools?.length) body.tools = accepted.tools;
    const key = await managedChatOperationKey(input.acceptedRequestSnapshot.operation.durableTurnId, input.phase, input.continuationIndex);
    try {
      const transport = await this.client.streamAcceptedChat(ticket, input.acceptedRequestSnapshot.operation.lease, body, key, input.signal);
      const status = statusValue(transport.response.status);
      const requestId = bounded(transport.diagnostics.requestId, 128);
      const diagnostic: ManagedChatDiagnostic = {
        ...(typeof status === "number" ? { status } : {}),
        ...(requestId ? { requestId } : {}),
      };
      if (!transport.response.ok) return this.statusResult(transport.response.status, transport.diagnostics.errorText, diagnostic);
      return { kind: "success", events: this.parseStream(transport.response, diagnostic, input.signal), diagnostic };
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

  private async *parseStream(response: Response, diagnostic: ManagedChatDiagnostic, signal?: AbortSignal): AsyncGenerator<ManagedChatRuntimeEvent> {
    if (!response.body) throw Object.freeze({ kind: "transport_failure", diagnostic });
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const queued: ManagedChatRuntimeEvent[] = [];
    const toolState = new Map<number, { id?: string; name?: string; arguments: string }>();
    let line = "";
    let pendingCr = false;
    let data: string[] = [];
    let doneSeen = false;
    let iterationCompleted = false;
    let readerCancelled = false;
    const cancelReader = async (): Promise<void> => {
      if (readerCancelled) return;
      readerCancelled = true;
      await reader.cancel();
    };
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
        for (const event of normalized) {
          if (event.kind === "tool_call_delta") {
            const previous = toolState.get(event.index) ?? { arguments: "" };
            toolState.set(event.index, {
              id: event.id ?? previous.id,
              name: event.name ?? previous.name,
              arguments: previous.arguments + (event.arguments ?? ""),
            });
          }
          queued.push(event);
        }
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
        if (signal?.aborted) { await cancelReader(); throw Object.freeze({ kind: "aborted", diagnostic }); }
        const chunk = signal
          ? await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
              const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
            })
          : await reader.read();
        if (chunk.done) break;
        if (!consume(decoder.decode(chunk.value, { stream: true }))) throw Object.freeze({ kind: "transport_failure", diagnostic });
        while (queued.length > 0) yield queued.shift()!;
      }
      if (!consume(decoder.decode())) throw Object.freeze({ kind: "transport_failure", diagnostic });
      while (queued.length > 0) yield queued.shift()!;
      if (pendingCr) line += "\r";
      if (line.length > 0 || data.length > 0) throw Object.freeze({ kind: "transport_failure", diagnostic });
      if (!doneSeen) throw Object.freeze({ kind: "transport_failure", diagnostic });
      for (const [index, state] of toolState) yield { kind: "tool_call_completed", index, ...state };
      yield { kind: "done" };
      iterationCompleted = true;
    } catch {
      if (signal?.aborted) {
        await cancelReader();
        throw Object.freeze({ kind: "aborted", diagnostic });
      }
      throw Object.freeze({ kind: "transport_failure", diagnostic });
    } finally {
      try {
        if (!iterationCompleted) await cancelReader();
      } finally {
        reader.releaseLock();
      }
    }
  }
}
