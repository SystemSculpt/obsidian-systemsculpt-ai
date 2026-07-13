import type { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type {
  AcceptedManagedChatOperation,
  JsonContractValue,
  ManagedTransportResult,
} from "../../../services/managed/ManagedTypes";
import type { AcceptedManagedChatRequestSnapshot, ManagedPreparedMessage } from "../../../services/chat/AcceptedChatRequestSnapshot";
import {
  composeAcceptedChatContinuation,
  composeAcceptedChatContinuationDelta,
  managedToolsetFingerprint,
} from "../../../services/chat/AcceptedChatRequestSnapshot";
import {
  hasUnavailableManagedAttachment,
  inspectManagedChatDispatchBudget,
} from "../../../services/managed/ManagedChatSessionBudget";
import type { StreamEvent, StreamToolCall } from "../../../streaming/types";
import {
  parseManagedChatSessionBinding,
  type ManagedChatSessionBinding,
} from "../storage/ChatPersistenceTypes";

export type ManagedChatSessionCheckpoint = Readonly<{
  id: string;
  revision: number;
}>;

export type ManagedChatRuntimeEvent =
  | Readonly<{ kind: "phase_restarted"; attempt: number }>
  | Readonly<{ kind: "content_delta"; text: string }>
  | Readonly<{ kind: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }>
  | Readonly<{ kind: "tool_call_completed"; index: number; id?: string; name?: string; arguments: string }>
  | Readonly<{ kind: "finish_reason"; reason: string }>
  | Readonly<{ kind: "request_id"; requestId: string }>
  | Readonly<{ kind: "usage"; promptTokens?: number; completionTokens?: number; totalTokens?: number; costTotal?: number }>
  | Readonly<{ kind: "session_committed"; checkpoint: ManagedChatSessionCheckpoint }>
  | Readonly<{ kind: "done" }>;

export type ManagedChatDiagnostic = Readonly<{ status?: number; code?: string; requestId?: string }>;

type FailureKind = "transport_failure" | "aborted" | "capability_request" | "license" | "credits"
  | "operation_in_progress" | "operation_already_completed" | "operation_terminal" | "settlement_pending"
  | "plugin_version" | "rate_limit" | "unavailable" | "session" | "attachment_unavailable";
export type ManagedChatDispatchResult =
  | Readonly<{ kind: "success"; events: AsyncIterable<ManagedChatRuntimeEvent>; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: "empty"; diagnostic: ManagedChatDiagnostic }>
  | Readonly<{ kind: FailureKind; diagnostic: ManagedChatDiagnostic }>;

export type ManagedChatDispatchInput = Readonly<{
  operation: AcceptedManagedChatOperation;
  acceptedRequestSnapshot: AcceptedManagedChatRequestSnapshot;
  phase: "initial" | "continuation";
  continuationIndex: number;
  postCheckpointDurableSnapshot?: import("../AgentTranscriptRepository").AgentTranscriptSnapshot;
  signal?: AbortSignal;
}>;

export type ManagedChatTranslationFence = Readonly<{ isOpen: () => boolean }>;
export type ManagedChatSessionStatePort = Readonly<{
  get: () => ManagedChatSessionBinding | undefined;
  invalidate: () => Promise<void>;
}>;
const LOCAL_ABORT = Symbol("managed-chat-local-abort");

function unreachableManagedEvent(event: never): never {
  throw new Error(`Unsupported managed Chat runtime event: ${JSON.stringify(event)}`);
}

function normalizedFinishReason(reason: string): string {
  return reason === "tool_calls" ? "toolUse" : reason;
}

/** The sole boundary from the closed managed event union into the existing stream pipeline. */
export async function* translateManagedChatEvents(
  events: AsyncIterable<ManagedChatRuntimeEvent>,
  signal: AbortSignal,
  fence: ManagedChatTranslationFence,
): AsyncGenerator<StreamEvent> {
  const toolIdentity = new Map<number, { id?: string; name?: string }>();
  let finishReasonSeen = false;
  const iterator = events[Symbol.asyncIterator]();
  let iteratorFinished = false;
  let abortedWhileWaiting = false;
  try {
    while (true) {
      if (signal.aborted || !fence.isOpen()) return;
      const step = await new Promise<IteratorResult<ManagedChatRuntimeEvent> | typeof LOCAL_ABORT>((resolve, reject) => {
        if (signal.aborted) { resolve(LOCAL_ABORT); return; }
        const onAbort = (): void => resolve(LOCAL_ABORT);
        signal.addEventListener("abort", onAbort, { once: true });
        void iterator.next().then(
          (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
          (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
        );
      });
      if (step === LOCAL_ABORT) {
        abortedWhileWaiting = true;
        return;
      }
      if (step.done) {
        iteratorFinished = true;
        return;
      }
      if (signal.aborted || !fence.isOpen()) return;
      const event = step.value;
      switch (event.kind) {
        case "phase_restarted":
          // This legacy translation seam has no mutable partial-message model.
          // The first-party controller consumes the restart event directly.
          toolIdentity.clear();
          finishReasonSeen = false;
          break;
        case "content_delta":
          yield { type: "content", text: event.text };
          break;
        case "tool_call_delta": {
          const previous = toolIdentity.get(event.index) ?? {};
          const current = {
            id: previous.id ?? event.id,
            name: previous.name ?? event.name,
          };
          toolIdentity.set(event.index, current);
          const call: StreamToolCall = {
            id: current.id ?? `managed_index_${event.index}`,
            type: "function",
            index: event.index,
            function: {
              name: current.name ?? "",
              arguments: event.arguments ?? "",
            },
          };
          yield { type: "tool-call", phase: "delta", call };
          break;
        }
        case "tool_call_completed": {
          const previous = toolIdentity.get(event.index) ?? {};
          const call: StreamToolCall = {
            id: previous.id ?? event.id ?? `managed_index_${event.index}`,
            type: "function",
            index: event.index,
            function: {
              name: previous.name ?? event.name ?? "",
              arguments: event.arguments,
            },
          };
          yield { type: "tool-call", phase: "final", call };
          break;
        }
        case "finish_reason":
          if (finishReasonSeen) throw new Error("Managed Chat stream emitted more than one finish reason.");
          finishReasonSeen = true;
          yield { type: "meta", key: "stop-reason", value: normalizedFinishReason(event.reason) };
          break;
        case "request_id":
        case "usage":
        case "session_committed":
          break;
        case "done":
          return;
        default:
          unreachableManagedEvent(event);
      }
      if (signal.aborted || !fence.isOpen()) return;
    }
  } finally {
    if (!iteratorFinished && iterator.return) {
      const closing = Promise.resolve(iterator.return());
      if (abortedWhileWaiting) void closing.catch(() => undefined);
      else await closing;
    }
  }
}

type JsonObject = { readonly [key: string]: JsonContractValue };
type OperationRegistry = Map<string, Promise<ManagedChatDispatchResult>>;
const MAX_TOOL_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_SAME_KEY_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;

type ManagedChatErrorFrame = Readonly<{
  code: string;
  message: string;
  retrySameIdempotencyKey: boolean;
}>;

class ManagedChatStreamFrameError extends Error {
  public constructor(public readonly frame: ManagedChatErrorFrame) {
    super(frame.message);
    this.name = "ManagedChatStreamFrameError";
  }
}

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

function normalizeErrorFrame(value: JsonContractValue): ManagedChatErrorFrame | null {
  const envelope = asObject(value);
  if (!envelope || !ownKeysExactly(envelope, ["error"])) return null;
  const error = asObject(envelope.error ?? null);
  if (!error) return null;
  const allowed = ["code", "message", "session_id", "current_revision", "retry_same_idempotency_key"];
  if (!Object.keys(error).every((key) => allowed.includes(key))) return null;
  const code = stringField(error, "code");
  const message = stringField(error, "message");
  if (
    !code || code.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(code)
    || !message || message.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)
  ) return null;
  if (typeof error.retry_same_idempotency_key !== "undefined" && typeof error.retry_same_idempotency_key !== "boolean") return null;
  if (typeof error.session_id !== "undefined") {
    if (typeof error.session_id !== "string" || !/^mchat_[0-9a-f]{32}$/.test(error.session_id)) return null;
  }
  if (typeof error.current_revision !== "undefined") {
    if (!Number.isSafeInteger(error.current_revision) || (error.current_revision as number) < 0) return null;
  }
  return Object.freeze({
    code,
    message,
    retrySameIdempotencyKey: error.retry_same_idempotency_key === true,
  });
}

function normalizeFrame(value: JsonContractValue): readonly ManagedChatRuntimeEvent[] | null {
  const object = asObject(value);
  if (!object || typeof object.error !== "undefined") return null;
  if (object.object === "systemsculpt.chat.session") {
    if (!ownKeysExactly(object, ["object", "session_id", "revision", "state"])) return null;
    const sessionId = stringField(object, "session_id");
    const revision = finiteNumber(object, "revision");
    if (
      object.state !== "committed"
      || !sessionId
      || !/^mchat_[0-9a-f]{32}$/.test(sessionId)
      || typeof revision !== "number"
      || !Number.isSafeInteger(revision)
      || revision < 1
    ) return null;
    return [{ kind: "session_committed", checkpoint: { id: sessionId, revision } }];
  }
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
        if (!["role", "content", "tool_calls"].includes(field)) return null;
      }
      if (typeof delta.role !== "undefined" && typeof delta.role !== "string") return null;
      if (typeof delta.content !== "undefined" && typeof delta.content !== "string" && delta.content !== null) return null;
      const content = stringField(delta, "content");
      if (content) events.push({ kind: "content_delta", text: content });
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
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function managedChatOperationKey(durableTurnId: string, phase: "initial" | "continuation", continuationIndex: number): Promise<string> {
  const index = phase === "initial" ? 0 : continuationIndex;
  return hashKey(`managed-chat-v2|${durableTurnId}|${phase}|${index}`);
}

const SESSION_REBASE_CODES = new Set([
  "session_not_found",
  "session_expired",
  "session_revision_conflict",
  "session_turn_conflict",
  "idempotency_key_reused",
]);

function responseErrorCode(errorText: string): string | undefined {
  try {
    const parsed: JsonContractValue = JSON.parse(errorText) as JsonContractValue;
    const object = asObject(parsed);
    const nestedError = object ? asObject(object.error ?? null) : null;
    return nestedError
      ? stringField(nestedError, "code")
      : object
        ? stringField(object, "code")
        : undefined;
  } catch {
    return undefined;
  }
}

function responseRetrySameIdempotencyKey(errorText: string): boolean {
  try {
    const parsed = JSON.parse(errorText) as JsonContractValue;
    return normalizeErrorFrame(parsed)?.retrySameIdempotencyKey === true;
  } catch {
    return false;
  }
}

function transportDiagnostic(transport: ManagedTransportResult): ManagedChatDiagnostic {
  const status = statusValue(transport.response.status);
  const requestId = bounded(transport.diagnostics.requestId, 128);
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

async function abortableRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    let timer = 0;
    const abort = (): void => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, RETRY_BASE_DELAY_MS * attempt);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function responseSessionCheckpoint(response: Response): ManagedChatSessionCheckpoint | null {
  const id = response.headers.get("x-systemsculpt-session-id")?.trim() ?? "";
  const revisionText = response.headers.get("x-systemsculpt-session-revision")?.trim() ?? "";
  const revision = Number(revisionText);
  if (
    !/^mchat_[0-9a-f]{32}$/.test(id)
    || !/^\d+$/.test(revisionText)
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) return null;
  return Object.freeze({ id, revision });
}

function requestByteLimit(
  operation: AcceptedManagedChatOperation,
  resumed: boolean,
): number | null {
  const limits = operation.lease.descriptor.limits;
  const value = resumed
    ? limits.max_delta_request_bytes ?? limits.max_request_bytes
    : limits.max_request_bytes;
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function requestBodyByteLength(body: Readonly<Record<string, JsonContractValue>>): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(body)).byteLength;
  } catch {
    return null;
  }
}

export class ManagedChatRuntimeAdapter {
  private readonly registry = new WeakMap<AcceptedManagedChatOperation, OperationRegistry>();
  private readonly terminal = new WeakSet<AcceptedManagedChatOperation>();

  public constructor(
    private readonly client: ManagedCapabilityClient,
    private readonly sessions: ManagedChatSessionStatePort = {
      get: () => undefined,
      invalidate: async () => undefined,
    },
  ) {}

  public dispatch(input: ManagedChatDispatchInput): Promise<ManagedChatDispatchResult> {
    if (input.acceptedRequestSnapshot.operation !== input.operation) {
      return Promise.resolve({ kind: "transport_failure", diagnostic: {} });
    }
    const validOrdinal = Number.isInteger(input.continuationIndex) && input.continuationIndex >= 0 &&
      (input.phase === "continuation" || (input.continuationIndex === 0 && input.acceptedRequestSnapshot.durableSnapshot === input.acceptedRequestSnapshot.operation.initialDurableSnapshot));
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

  public notifyDurablyTerminal(operation: AcceptedManagedChatOperation): void {
    this.terminal.add(operation);
    this.registry.delete(operation);
  }

  public hasRetainedEntries(operation: AcceptedManagedChatOperation): boolean {
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
    if (accepted.model !== "ai-agent") return { kind: "transport_failure", diagnostic: {} };
    try {
      const toolsetFingerprint = managedToolsetFingerprint(accepted.tools);
      let binding = await this.sessionBinding(input, toolsetFingerprint);
      let fullMessages: readonly ManagedPreparedMessage[];
      let deltaMessages: readonly ManagedPreparedMessage[];
      try {
        fullMessages = this.requestMessages(input, false);
        deltaMessages = this.requestMessages(input, true);
      } catch {
        return { kind: "transport_failure", diagnostic: { code: "local_transcript_invalid" } };
      }
      if (fullMessages.length === 0 || deltaMessages.length === 0) {
        return { kind: "transport_failure", diagnostic: { code: "local_transcript_invalid" } };
      }
      const budget = inspectManagedChatDispatchBudget({
        limits: input.operation.lease.descriptor.limits,
        fullMessages,
        deltaMessages,
        tools: accepted.tools,
        ...(binding ? { sessionBudget: binding.budget } : {}),
      });
      if (binding && budget.resumeIssue) {
        await this.sessions.invalidate();
        binding = undefined;
      }
      if (!binding && budget.createIssue) {
        return { kind: "capability_request", diagnostic: { code: budget.createIssue.code } };
      }
      const messages = binding ? deltaMessages : fullMessages;
      let body: Record<string, JsonContractValue> | null;
      try {
        body = this.requestBody(input, binding, messages);
      } catch {
        return { kind: "transport_failure", diagnostic: { code: "local_transcript_invalid" } };
      }
      if (!body) return { kind: "transport_failure", diagnostic: { code: "local_transcript_invalid" } };
      if (!binding && hasUnavailableManagedAttachment(body as JsonContractValue)) {
        return { kind: "attachment_unavailable", diagnostic: { code: "local_attachment_unavailable" } };
      }
      let bodyBytes = requestBodyByteLength(body);
      let byteLimit = requestByteLimit(input.operation, !!binding);
      if (bodyBytes === null || byteLimit === null) {
        return { kind: "transport_failure", diagnostic: { code: "local_contract_invalid" } };
      }
      if (bodyBytes > byteLimit) {
        return { kind: "capability_request", diagnostic: { code: "local_request_too_large" } };
      }
      const key = await managedChatOperationKey(input.acceptedRequestSnapshot.operation.durableTurnId, input.phase, input.continuationIndex);
      let transport = await this.client.streamAcceptedChat(ticket, input.operation.lease, body, key, input.signal);
      const firstErrorCode = transport.response.ok
        ? undefined
        : responseErrorCode(transport.diagnostics.errorText);
      if (binding && firstErrorCode && SESSION_REBASE_CODES.has(firstErrorCode)) {
        await this.sessions.invalidate();
        binding = undefined;
        if (budget.createIssue) {
          return { kind: "capability_request", diagnostic: { code: budget.createIssue.code } };
        }
        try {
          body = this.requestBody(input, undefined, fullMessages);
        } catch {
          return { kind: "transport_failure", diagnostic: { code: "local_transcript_invalid" } };
        }
        if (!body) return { kind: "transport_failure", diagnostic: {} };
        if (hasUnavailableManagedAttachment(body as JsonContractValue)) {
          return { kind: "attachment_unavailable", diagnostic: { code: "local_attachment_unavailable" } };
        }
        bodyBytes = requestBodyByteLength(body);
        byteLimit = requestByteLimit(input.operation, false);
        if (bodyBytes === null || byteLimit === null) {
          return { kind: "transport_failure", diagnostic: { code: "local_contract_invalid" } };
        }
        if (bodyBytes > byteLimit) {
          return { kind: "capability_request", diagnostic: { code: "local_request_too_large" } };
        }
        transport = await this.client.streamAcceptedChat(ticket, input.operation.lease, body, key, input.signal);
      }
      const diagnostic = transportDiagnostic(transport);
      if (
        !transport.response.ok
        && !responseRetrySameIdempotencyKey(transport.diagnostics.errorText)
      ) return this.statusResult(transport.response.status, transport.diagnostics.errorText, diagnostic);
      const expectedCheckpoint = responseSessionCheckpoint(transport.response);
      const expectedRevision = binding ? binding.revision + 1 : 1;
      if (
        transport.response.ok
        && (!expectedCheckpoint
          || expectedCheckpoint.revision !== expectedRevision
          || (binding && expectedCheckpoint.id !== binding.id))
      ) return { kind: "transport_failure", diagnostic };
      return {
        kind: "success",
        events: this.retryingStream({
          initialTransport: transport,
          ticket,
          input,
          body,
          key,
          expectedRevision,
          expectedSessionId: binding?.id,
        }),
        diagnostic,
      };
    } catch {
      if (input.signal?.aborted) return { kind: "aborted", diagnostic: {} };
      return { kind: "transport_failure", diagnostic: {} };
    }
  }

  private async sessionBinding(
    input: ManagedChatDispatchInput,
    toolsetFingerprint: string,
  ): Promise<ManagedChatSessionBinding | undefined> {
    const accepted = input.acceptedRequestSnapshot;
    const savedBinding = this.sessions.get();
    if (!savedBinding) return undefined;
    const binding = parseManagedChatSessionBinding(
      savedBinding,
      accepted.durableSnapshot.chatId,
    );
    if (!binding) {
      await this.sessions.invalidate();
      return undefined;
    }
    const snapshot = input.phase === "initial"
      ? accepted.durableSnapshot
      : input.postCheckpointDurableSnapshot;
    let anchorValid = false;
    if (snapshot) {
      if (input.phase === "initial") {
        const boundaries = snapshot.messages
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => message.message_id === accepted.durableTurnId);
        if (boundaries.length === 1 && boundaries[0].message.role === "user") {
          const preceding = snapshot.messages
            .slice(0, boundaries[0].index)
            .filter((message) => message.role !== "system");
          const previous = preceding[preceding.length - 1];
          anchorValid = previous?.role === "assistant"
            && previous.message_id === binding.checkpointMessageId
            && !previous.tool_calls?.length;
        }
      } else {
        let latestAssistantIndex = -1;
        for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
          if (snapshot.messages[index].role === "assistant") {
            latestAssistantIndex = index;
            break;
          }
        }
        const assistant = latestAssistantIndex >= 0 ? snapshot.messages[latestAssistantIndex] : undefined;
        const tail = latestAssistantIndex >= 0
          ? snapshot.messages.slice(latestAssistantIndex + 1).filter((message) => message.role !== "system")
          : [];
        anchorValid = assistant?.message_id === binding.checkpointMessageId
          && !!assistant.tool_calls?.length
          && assistant.tool_calls.every((call) => call.state === "completed" || call.state === "failed")
          && tail.length === 0;
      }
    }
    if (
      binding.boundChatId !== accepted.durableSnapshot.chatId
      || binding.revision < 1
      || binding.toolsetFingerprint !== toolsetFingerprint
      || !anchorValid
    ) {
      await this.sessions.invalidate();
      return undefined;
    }
    return binding;
  }

  private requestBody(
    input: ManagedChatDispatchInput,
    binding: ManagedChatSessionBinding | undefined,
    messages: readonly ManagedPreparedMessage[],
  ): Record<string, JsonContractValue> | null {
    const accepted = input.acceptedRequestSnapshot;
    if (messages.length === 0) return null;
    const body: Record<string, JsonContractValue> = {
      model: accepted.model,
      stream: true,
      session: binding
        ? { id: binding.id, revision: binding.revision }
        : { mode: "create" },
      messages,
    };
    if (!binding && accepted.tools?.length) body.tools = accepted.tools;
    if (input.phase === "initial" && accepted.webSearch) body.plugins = [{ id: "web" }];
    return body;
  }

  private requestMessages(
    input: ManagedChatDispatchInput,
    resumed: boolean,
  ): readonly ManagedPreparedMessage[] {
    const accepted = input.acceptedRequestSnapshot;
    if (input.phase === "initial") {
      return resumed ? accepted.turnMessages : accepted.messages;
    }
    if (!input.postCheckpointDurableSnapshot) return [];
    return resumed
      ? composeAcceptedChatContinuationDelta(accepted, input.postCheckpointDurableSnapshot)
      : composeAcceptedChatContinuation(accepted, input.postCheckpointDurableSnapshot);
  }

  private statusResult(status: number, errorText: string, base: ManagedChatDiagnostic): ManagedChatDispatchResult {
    const rawCode = responseErrorCode(errorText);
    const code = bounded(rawCode ?? null, 64);
    const diagnostic: ManagedChatDiagnostic = { ...base, ...(code ? { code } : {}) };
    if (status === 400) return { kind: "capability_request", diagnostic };
    if (status === 401 || status === 403) return { kind: "license", diagnostic };
    if (status === 402) return { kind: "credits", diagnostic };
    if (status === 426) return { kind: "plugin_version", diagnostic };
    if (status === 429) return { kind: "rate_limit", diagnostic };
    if (status === 503) return { kind: "unavailable", diagnostic };
    if (status === 404 || status === 410 || rawCode?.startsWith("session_")) {
      return { kind: "session", diagnostic };
    }
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

  /**
   * A staged provider response can outlive a transient session-finalization
   * failure. Replaying the exact body and idempotency key recovers that same
   * response without charging or running tools twice.
   */
  private async *retryingStream(params: Readonly<{
    initialTransport: ManagedTransportResult;
    ticket: NonNullable<ReturnType<ManagedCapabilityClient["beginAcceptedChatDispatch"]>>;
    input: ManagedChatDispatchInput;
    body: Readonly<Record<string, JsonContractValue>>;
    key: string;
    expectedRevision: number;
    expectedSessionId?: string;
  }>): AsyncGenerator<ManagedChatRuntimeEvent> {
    let transport = params.initialTransport;
    let retries = 0;
    while (true) {
      const diagnostic = transportDiagnostic(transport);
      if (!transport.response.ok) {
        if (
          !responseRetrySameIdempotencyKey(transport.diagnostics.errorText)
          || retries >= MAX_SAME_KEY_RETRIES
        ) {
          throw this.statusResult(
            transport.response.status,
            transport.diagnostics.errorText,
            diagnostic,
          );
        }
        retries += 1;
        yield { kind: "phase_restarted", attempt: retries };
        await abortableRetryDelay(retries, params.input.signal);
        transport = await this.client.streamAcceptedChat(
          params.ticket,
          params.input.operation.lease,
          params.body,
          params.key,
          params.input.signal,
        );
        continue;
      }

      const checkpoint = responseSessionCheckpoint(transport.response);
      if (
        !checkpoint
        || checkpoint.revision !== params.expectedRevision
        || (params.expectedSessionId && checkpoint.id !== params.expectedSessionId)
      ) {
        throw Object.freeze({ kind: "transport_failure", diagnostic });
      }
      try {
        yield* this.parseStream(transport.response, checkpoint, diagnostic, params.input.signal);
        return;
      } catch (error) {
        if (!(error instanceof ManagedChatStreamFrameError)) throw error;
        if (!error.frame.retrySameIdempotencyKey || retries >= MAX_SAME_KEY_RETRIES) {
          throw Object.freeze({
            kind: "transport_failure",
            diagnostic: { ...diagnostic, code: error.frame.code },
          });
        }
        retries += 1;
        yield { kind: "phase_restarted", attempt: retries };
        await abortableRetryDelay(retries, params.input.signal);
        transport = await this.client.streamAcceptedChat(
          params.ticket,
          params.input.operation.lease,
          params.body,
          params.key,
          params.input.signal,
        );
      }
    }
  }

  private async *parseStream(
    response: Response,
    expectedCheckpoint: ManagedChatSessionCheckpoint,
    diagnostic: ManagedChatDiagnostic,
    signal?: AbortSignal,
  ): AsyncGenerator<ManagedChatRuntimeEvent> {
    if (!response.body) throw Object.freeze({ kind: "transport_failure", diagnostic });
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const queued: ManagedChatRuntimeEvent[] = [];
    const toolState = new Map<number, { id?: string; name?: string; arguments: string }>();
    let line = "";
    let pendingCr = false;
    let data: string[] = [];
    let doneSeen = false;
    let committedCheckpoint: ManagedChatSessionCheckpoint | null = null;
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
        const streamError = normalizeErrorFrame(parsed);
        if (streamError) throw new ManagedChatStreamFrameError(streamError);
        const normalized = normalizeFrame(parsed);
        if (!normalized) return false;
        for (const event of normalized) {
          if (event.kind === "session_committed") {
            if (
              committedCheckpoint
              || event.checkpoint.id !== expectedCheckpoint.id
              || event.checkpoint.revision !== expectedCheckpoint.revision
            ) return false;
            committedCheckpoint = event.checkpoint;
          }
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
      } catch (error) {
        if (error instanceof ManagedChatStreamFrameError) throw error;
        return false;
      }
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
      if (!committedCheckpoint) throw Object.freeze({ kind: "transport_failure", diagnostic });
      for (const [index, state] of toolState) yield { kind: "tool_call_completed", index, ...state };
      yield { kind: "done" };
      iterationCompleted = true;
    } catch (error) {
      if (signal?.aborted) {
        await cancelReader();
        throw Object.freeze({ kind: "aborted", diagnostic });
      }
      if (error instanceof ManagedChatStreamFrameError) {
        try { await cancelReader(); } catch { /* the typed retry contract remains authoritative */ }
        throw error;
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
