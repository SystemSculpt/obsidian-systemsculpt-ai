import { ERROR_CODES, type ErrorCode, SystemSculptError } from "../utils/errors";

import { parseRetryAfterMs } from "../utils/retryAfter";

function decodePayload(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return text.trim() ? { message: text.trim() } : {};
  }
}

function errorCode(status: number, serverCode: string): ErrorCode {
  if (status === 401 || status === 403) return ERROR_CODES.INVALID_LICENSE;
  if (status === 402 || serverCode === "insufficient_credits") return ERROR_CODES.INSUFFICIENT_CREDITS;
  if (status === 409 || serverCode === "turn_in_flight") return ERROR_CODES.TURN_IN_FLIGHT;
  if (status === 429) return ERROR_CODES.RATE_LIMIT_ERROR;
  if (status >= 500) return ERROR_CODES.SERVICE_UNAVAILABLE;
  return ERROR_CODES.INVALID_RESPONSE;
}

export class StreamingErrorHandler {
  public static async handleResponseError(
    response: Response,
    context?: { endpoint?: string },
  ): Promise<never> {
    const payload = decodePayload(await response.text());
    const nested: Record<string, unknown> = payload.error
      && typeof payload.error === "object"
      && !Array.isArray(payload.error)
      ? payload.error as Record<string, unknown>
      : {};
    const serverCode = String(nested.code ?? payload.code ?? "").trim().toLowerCase();
    const code = errorCode(response.status, serverCode);
    const message = String(nested.message ?? payload.message ?? "").trim() ||
      (code === ERROR_CODES.SERVICE_UNAVAILABLE
        ? "SystemSculpt is temporarily unavailable."
        : "SystemSculpt could not complete the request.");

    const retryMs = parseRetryAfterMs(response.headers?.get?.("retry-after") ?? null, {
      payload: { ...payload, ...nested },
    });
    throw new SystemSculptError(message, code, response.status, {
      endpoint: context?.endpoint,
      serverCode: serverCode || undefined,
      retryAfterSeconds: retryMs === undefined ? undefined : Math.ceil(retryMs / 1_000),
      licenseFailure: code === ERROR_CODES.INVALID_LICENSE,
    });
  }
}
