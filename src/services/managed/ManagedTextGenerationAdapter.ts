import type { ManagedAdmission } from "./ManagedAdmission";
import type { ManagedAdmissionOutcome, ManagedLease, ManagedTransportResult } from "./ManagedTypes";
import type { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";

export type ManagedTextGenerationPurpose = "transcript_postprocess" | "workflow_automation";
export type ManagedTextGenerationMessage = Readonly<{
  role: "system" | "user";
  content: string;
}>;

export type ManagedTextGenerationOperation = Readonly<{
  operationId: string;
  purpose: ManagedTextGenerationPurpose;
  buildMessages: () => readonly ManagedTextGenerationMessage[] | Promise<readonly ManagedTextGenerationMessage[]>;
  onDispatch?: () => void | Promise<void>;
  signal?: AbortSignal;
}>;

export type ManagedTextGenerationResult = Readonly<{
  operationId: string;
  requestId: string;
  text: string;
  finishReason: "stop" | "length";
  usage: Readonly<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}>;

export type ManagedTextGenerationErrorCode =
  | Exclude<ManagedAdmissionOutcome, "allowed">
  | "invalid_request"
  | "insufficient_credits"
  | "operation_in_progress"
  | "operation_already_completed"
  | "operation_terminal"
  | "settlement_pending"
  | "upgrade_required"
  | "internal_error"
  | "upstream_failed"
  | "ambiguous_outcome"
  | "invalid_response"
  | "local_aborted";

export type ManagedTextGenerationErrorOptions = Readonly<{
  code: ManagedTextGenerationErrorCode;
  message: string;
  operationId: string;
  status?: number;
  requestId?: string | null;
  retryable?: boolean;
  ambiguous?: boolean;
  disposition?: string;
  abort?: boolean;
}>;

export class ManagedTextGenerationError extends Error {
  public readonly code: ManagedTextGenerationErrorCode;
  public readonly operationId: string;
  public readonly status?: number;
  public readonly requestId: string | null;
  public readonly retryable: boolean;
  public readonly ambiguous: boolean;
  public readonly disposition?: string;

  constructor(options: ManagedTextGenerationErrorOptions) {
    super(options.message);
    this.name = options.abort ? "AbortError" : "ManagedTextGenerationError";
    this.code = options.code;
    this.operationId = options.operationId;
    this.status = options.status;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
    this.disposition = options.disposition;
  }
}

type Dependencies = Readonly<{
  admission: Pick<ManagedAdmission, "acquireLease">;
  transport: Pick<HostedTransportAdapter, "request">;
}>;

type JsonRecord = { readonly [key: string]: unknown };

const ROUTE_PATH = "/api/plugin/chat/completions" as const;
const ROUTE_METHOD = "POST" as const;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_BYTES = 524_288;
const MAX_AGGREGATE_BYTES = 1_048_576;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const PURPOSES: readonly ManagedTextGenerationPurpose[] = ["transcript_postprocess", "workflow_automation"];
const STATUS_CODES: Readonly<Record<number, Readonly<{ code: ManagedTextGenerationErrorCode; retryable: boolean }>>> = Object.freeze({
  400: { code: "invalid_request", retryable: false },
  401: { code: "license_required", retryable: false },
  402: { code: "insufficient_credits", retryable: false },
  403: { code: "license_rejected", retryable: false },
  426: { code: "upgrade_required", retryable: false },
  429: { code: "rate_limited", retryable: true },
  500: { code: "internal_error", retryable: false },
  502: { code: "upstream_failed", retryable: false },
  503: { code: "temporarily_unavailable", retryable: true },
});
const CONFLICT_DISPOSITIONS: Readonly<Record<string, string>> = Object.freeze({
  operation_in_progress: "manual_reconciliation",
  operation_already_completed: "completed_result_unavailable",
  operation_terminal: "terminal_no_retry",
  settlement_pending: "operator_reconciliation",
});

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(operationId: string, message: string): ManagedTextGenerationError {
  return new ManagedTextGenerationError({ code: "invalid_request", message, operationId });
}

function invalidResponse(operationId: string, requestId: string | null, message = "Managed text generation returned an invalid response."): ManagedTextGenerationError {
  return new ManagedTextGenerationError({ code: "invalid_response", message, operationId, requestId });
}

function localAbort(operationId: string, ambiguous: boolean): ManagedTextGenerationError {
  return new ManagedTextGenerationError({
    code: ambiguous ? "ambiguous_outcome" : "local_aborted",
    message: ambiguous
      ? "Managed text generation was stopped locally after dispatch; the server outcome is unknown."
      : "Managed text generation was stopped locally before dispatch.",
    operationId,
    ambiguous,
    retryable: false,
    abort: true,
  });
}

function throwIfAborted(signal: AbortSignal | undefined, operationId: string, ambiguous: boolean): void {
  if (signal?.aborted) throw localAbort(operationId, ambiguous);
}

function exactPurposeValues(value: readonly string[] | undefined): boolean {
  return !!value && value.length === PURPOSES.length && PURPOSES.every((purpose) => value.includes(purpose));
}

function validLease(lease: ManagedLease): boolean {
  const descriptor = lease.descriptor;
  const contract = lease.requestContract;
  return lease.outcome === "allowed"
    && descriptor?.alias === "systemsculpt/chat"
    && descriptor.endpoint === ROUTE_PATH
    && descriptor.availability === "available"
    && contract?.capability === "text_generation"
    && contract.header === "x-systemsculpt-capability"
    && contract.header_value === "text_generation"
    && contract.background_eligible === true
    && contract.purpose?.presence === "required"
    && exactPurposeValues(contract.purpose.values)
    && descriptor.request_contracts.includes(contract);
}

function validateOperation(operation: ManagedTextGenerationOperation): void {
  if (
    typeof operation.operationId !== "string"
    || operation.operationId.length < 1
    || operation.operationId.length > 128
    || !IDEMPOTENCY_PATTERN.test(operation.operationId)
  ) {
    throw invalid(String(operation.operationId ?? ""), "Managed text generation requires a durable 1-128 character operation ID.");
  }
  if (!PURPOSES.includes(operation.purpose)) {
    throw invalid(operation.operationId, "Managed text generation purpose is invalid.");
  }
  if (typeof operation.buildMessages !== "function") {
    throw invalid(operation.operationId, "Managed text generation requires a lazy message builder.");
  }
}

function validateMessages(operationId: string, value: unknown): ManagedTextGenerationMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) {
    throw invalid(operationId, "Managed text generation requires 1-8 messages.");
  }
  let aggregateBytes = 0;
  const messages: ManagedTextGenerationMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ["role", "content"])) {
      throw invalid(operationId, "Managed text generation messages must contain exactly role and content.");
    }
    if (item.role !== "system" && item.role !== "user") {
      throw invalid(operationId, "Managed text generation message role is invalid.");
    }
    if (typeof item.content !== "string" || item.content.length === 0) {
      throw invalid(operationId, "Managed text generation message content must be non-empty.");
    }
    const bytes = utf8Length(item.content);
    if (bytes > MAX_MESSAGE_BYTES) {
      throw invalid(operationId, "Managed text generation message content is too large.");
    }
    aggregateBytes += bytes;
    messages.push(Object.freeze({ role: item.role, content: item.content }));
  }
  if (aggregateBytes > MAX_AGGREGATE_BYTES) {
    throw invalid(operationId, "Managed text generation aggregate message content is too large.");
  }
  return messages;
}

function responseRequestId(result: ManagedTransportResult, operationId: string): string {
  const header = result.response.headers.get("x-request-id");
  if (
    !header
    || header.length > 128
    || !REQUEST_ID_PATTERN.test(header)
    || (result.diagnostics.requestId !== null && result.diagnostics.requestId !== header)
  ) {
    throw invalidResponse(operationId, header);
  }
  return header;
}

function validateContentType(result: ManagedTransportResult, operationId: string, requestId: string): void {
  const value = result.response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!value.startsWith("application/json")) throw invalidResponse(operationId, requestId);
}

async function parseJson(result: ManagedTransportResult, operationId: string, requestId: string): Promise<unknown> {
  try {
    return await result.response.json();
  } catch {
    throw invalidResponse(operationId, requestId);
  }
}

function parseSuccess(value: unknown, operationId: string, requestId: string): ManagedTextGenerationResult {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "object", "created", "model", "choices", "usage"])) {
    throw invalidResponse(operationId, requestId);
  }
  if (
    typeof value.id !== "string" || value.id.length === 0
    || value.object !== "chat.completion"
    || !isNonNegativeInteger(value.created)
    || value.model !== "ai-agent"
    || !Array.isArray(value.choices)
    || value.choices.length !== 1
  ) throw invalidResponse(operationId, requestId);

  const choice = value.choices[0];
  if (
    !isRecord(choice)
    || !hasExactKeys(choice, ["index", "message", "finish_reason"])
    || choice.index !== 0
    || (choice.finish_reason !== "stop" && choice.finish_reason !== "length")
    || !isRecord(choice.message)
    || !hasExactKeys(choice.message, ["role", "content"])
    || choice.message.role !== "assistant"
    || typeof choice.message.content !== "string"
  ) throw invalidResponse(operationId, requestId);

  const usage = value.usage;
  if (
    !isRecord(usage)
    || !hasExactKeys(usage, ["prompt_tokens", "completion_tokens", "total_tokens"])
    || !isNonNegativeInteger(usage.prompt_tokens)
    || !isNonNegativeInteger(usage.completion_tokens)
    || !isNonNegativeInteger(usage.total_tokens)
  ) throw invalidResponse(operationId, requestId);

  return Object.freeze({
    operationId,
    requestId,
    text: choice.message.content,
    finishReason: choice.finish_reason,
    usage: Object.freeze({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    }),
  });
}

function errorKeysForStatus(status: number, value: JsonRecord): readonly string[] | null {
  const common = ["code", "message", "request_id", "retryable"];
  if (status === 402) {
    const optional = [
      ...(Object.prototype.hasOwnProperty.call(value, "credits_remaining") ? ["credits_remaining"] : []),
      ...(Object.prototype.hasOwnProperty.call(value, "cycle_ends_at") ? ["cycle_ends_at"] : []),
    ];
    return [...common, ...optional];
  }
  if (status === 409) return [...common, "disposition", "retry_after_ms"];
  if (status === 426) return [...common, "minimum_version", "current_version"];
  if (status === 429) return [...common, "retry_after_ms"];
  return STATUS_CODES[status] ? common : null;
}

function parseError(value: unknown, status: number, operationId: string, requestId: string): ManagedTextGenerationError {
  if (!isRecord(value) || !hasExactKeys(value, ["error"]) || !isRecord(value.error)) {
    throw invalidResponse(operationId, requestId);
  }
  const error = value.error;
  const expectedKeys = errorKeysForStatus(status, error);
  if (
    !expectedKeys
    || !hasExactKeys(error, expectedKeys)
    || typeof error.message !== "string"
    || error.message.length < 1
    || error.message.length > MAX_ERROR_MESSAGE_LENGTH
    || error.request_id !== requestId
    || typeof error.retryable !== "boolean"
  ) throw invalidResponse(operationId, requestId);

  if (status === 409) {
    const disposition = typeof error.code === "string" ? CONFLICT_DISPOSITIONS[error.code] : undefined;
    if (!disposition || error.disposition !== disposition || error.retry_after_ms !== null || error.retryable !== false) {
      throw invalidResponse(operationId, requestId);
    }
    return new ManagedTextGenerationError({
      code: error.code as ManagedTextGenerationErrorCode,
      message: error.message,
      operationId,
      status,
      requestId,
      retryable: false,
      disposition,
    });
  }

  const descriptor = STATUS_CODES[status];
  if (!descriptor || error.code !== descriptor.code || error.retryable !== descriptor.retryable) {
    throw invalidResponse(operationId, requestId);
  }
  if (status === 402) {
    if (error.credits_remaining !== undefined && !isNonNegativeInteger(error.credits_remaining)) throw invalidResponse(operationId, requestId);
    if (error.cycle_ends_at !== undefined && error.cycle_ends_at !== null && typeof error.cycle_ends_at !== "string") throw invalidResponse(operationId, requestId);
  }
  if (status === 426 && (typeof error.minimum_version !== "string" || !(error.current_version === null || typeof error.current_version === "string"))) {
    throw invalidResponse(operationId, requestId);
  }
  if (status === 429 && (!Number.isInteger(error.retry_after_ms) || (error.retry_after_ms as number) < 1)) {
    throw invalidResponse(operationId, requestId);
  }
  return new ManagedTextGenerationError({
    code: descriptor.code,
    message: error.message,
    operationId,
    status,
    requestId,
    retryable: descriptor.retryable,
  });
}

export class ManagedTextGenerationAdapter {
  constructor(private readonly dependencies: Dependencies) {}

  async generate(operation: ManagedTextGenerationOperation): Promise<ManagedTextGenerationResult> {
    validateOperation(operation);
    throwIfAborted(operation.signal, operation.operationId, false);

    const lease = await this.dependencies.admission.acquireLease({
      alias: "systemsculpt/chat",
      requestContract: "text_generation",
    });
    throwIfAborted(operation.signal, operation.operationId, false);
    if (lease.outcome !== "allowed") {
      throw new ManagedTextGenerationError({
        code: lease.outcome,
        message: `Managed text generation is unavailable (${lease.outcome}).`,
        operationId: operation.operationId,
        requestId: lease.diagnostics?.requestId,
        retryable: lease.outcome === "temporarily_unavailable" || lease.outcome === "rate_limited",
      });
    }
    if (!validLease(lease)) {
      throw new ManagedTextGenerationError({
        code: "capability_unavailable",
        message: "Managed text generation capability does not match the pinned contract.",
        operationId: operation.operationId,
      });
    }

    const messages = validateMessages(operation.operationId, await operation.buildMessages());
    throwIfAborted(operation.signal, operation.operationId, false);
    const body = Object.freeze({
      model: "ai-agent" as const,
      stream: false as const,
      purpose: operation.purpose,
      messages: Object.freeze(messages),
    });
    await operation.onDispatch?.();
    throwIfAborted(operation.signal, operation.operationId, false);

    let result: ManagedTransportResult;
    try {
      const pending = this.dependencies.transport.request({
        path: ROUTE_PATH,
        method: ROUTE_METHOD,
        capability: "text_generation",
        idempotencyKey: operation.operationId,
        body,
        signal: operation.signal,
      });
      result = await pending;
    } catch (error) {
      if (operation.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw localAbort(operation.operationId, true);
      }
      throw new ManagedTextGenerationError({
        code: "ambiguous_outcome",
        message: "Managed text generation transport failed after dispatch; the server outcome is unknown.",
        operationId: operation.operationId,
        retryable: false,
        ambiguous: true,
      });
    }

    throwIfAborted(operation.signal, operation.operationId, true);
    const requestId = responseRequestId(result, operation.operationId);
    validateContentType(result, operation.operationId, requestId);
    const value = await parseJson(result, operation.operationId, requestId);
    throwIfAborted(operation.signal, operation.operationId, true);
    if (!result.response.ok) throw parseError(value, result.response.status, operation.operationId, requestId);
    if (result.response.status !== 200) throw invalidResponse(operation.operationId, requestId);
    return parseSuccess(value, operation.operationId, requestId);
  }
}
