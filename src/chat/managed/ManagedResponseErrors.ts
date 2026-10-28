import { isRecord } from "./WireConversation";
import type { ManagedAgentError } from "../ChatConversation";
import type { AgentIncidentFailureMechanism } from "../../core/diagnostics/AgentIncidentSchema";

export function wasDefinitelyRejected(error: unknown): boolean {
  return isRecord(error) && error.serverAdmissionPossible === false;
}

export function managedError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ManagedAgentError {
  if (isRecord(error)) {
    const status = typeof error.status === "number" && Number.isInteger(error.status)
      ? error.status
      : undefined;
    const retryable = typeof error.retryable === "boolean"
      ? error.retryable
      : status === undefined || status === 401 || status === 429 || status >= 500;
    const code = typeof error.code === "string"
      && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : fallbackCode;
    const requestId = typeof error.requestId === "string"
      && /^incident_[a-f0-9]{32}$/u.test(error.requestId)
      ? error.requestId
      : undefined;
    return {
      code,
      message: fallbackMessage,
      ...(status === undefined ? {} : { status }),
      ...(requestId ? { requestId } : {}),
      ...(requestId ? { incidentId: requestId } : {}),
      retryable,
    };
  }
  return {
    code: fallbackCode,
    message: fallbackMessage,
    retryable: true,
  };
}

export function managedException(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): Error & ManagedAgentError {
  const details = managedError(error, fallbackCode, fallbackMessage);
  return Object.assign(new Error(details.message), details);
}

export function responseStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number"
    ? error.status
    : undefined;
}

export function incidentFailureMechanism(
  error: Pick<ManagedAgentError, "status">,
  fallback: AgentIncidentFailureMechanism,
): AgentIncidentFailureMechanism {
  return Number.isInteger(error.status)
    && error.status !== undefined
    && error.status >= 400
    && error.status <= 599
    ? "http_rejection"
    : fallback;
}

export function boundedErrorPayload(text: string): Readonly<{
  message?: string;
  incidentId?: string;
}> {
  if (text.length > 4_096) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return {};
    const nested = isRecord(value.error) ? value.error : {};
    const rawMessage = nested.message ?? value.message;
    const rawIncident = nested.incident_id ?? value.incident_id;
    return {
      ...(typeof rawMessage === "string" ? { message: rawMessage } : {}),
      ...(typeof rawIncident === "string" && /^incident_[a-f0-9]{32}$/u.test(rawIncident)
        ? { incidentId: rawIncident }
        : {}),
    };
  } catch {
    return {};
  }
}

