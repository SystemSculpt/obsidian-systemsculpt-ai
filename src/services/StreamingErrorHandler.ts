import { ERROR_CODES, type ErrorCode, SystemSculptError } from "../utils/errors";

function retryAfterSeconds(response: Response, payload: Record<string, any>): number | undefined {
  const raw = response.headers?.get?.("retry-after") ?? payload.retry_after_seconds ?? payload.retry_after;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  if (typeof raw === "string") {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return undefined;
}

function decodePayload(text: string): Record<string, any> {
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
    const nested = payload.error && typeof payload.error === "object" ? payload.error : {};
    const serverCode = String(nested.code ?? payload.code ?? "").trim().toLowerCase();
    const code = errorCode(response.status, serverCode);
    const message = String(nested.message ?? payload.message ?? "").trim() ||
      (code === ERROR_CODES.SERVICE_UNAVAILABLE
        ? "SystemSculpt is temporarily unavailable."
        : "SystemSculpt could not complete the request.");

    throw new SystemSculptError(message, code, response.status, {
      endpoint: context?.endpoint,
      serverCode: serverCode || undefined,
      retryAfterSeconds: retryAfterSeconds(response, { ...payload, ...nested }),
      licenseFailure: code === ERROR_CODES.INVALID_LICENSE,
    });
  }
}
