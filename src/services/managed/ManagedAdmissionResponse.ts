import {
  MANAGED_ADMISSION_CONTRACT,
  type ManagedServerOutcome,
} from "./ManagedTypes";

export type ManagedLicenseRejectReason = "invalid" | "expired" | "revoked";

export type DecodedManagedAdmission = Readonly<{
  outcome: ManagedServerOutcome;
  reason?: ManagedLicenseRejectReason;
}>;

const FORBIDDEN_FIELDS = ["license_key", "licenseKey", "credential", "token"] as const;
const REJECT_REASONS = new Set<ManagedLicenseRejectReason>(["invalid", "expired", "revoked"]);
const STATUS_BY_OUTCOME: Readonly<Record<ManagedServerOutcome, number>> = {
  allowed: 200,
  license_required: 401,
  license_rejected: 403,
  rate_limited: 429,
  temporarily_unavailable: 503,
};

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * Decode the negotiated admission-v1 envelope conservatively. Any response
 * that is incomplete, contradictory, or contains credential material is an
 * availability failure, never evidence that a paid license is invalid.
 */
export function decodeManagedAdmissionResponse(
  status: number,
  value: unknown,
): DecodedManagedAdmission {
  const unavailable: DecodedManagedAdmission = { outcome: "temporarily_unavailable" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;

  const record = value as Record<string, unknown>;
  if (FORBIDDEN_FIELDS.some((field) => field in record)) return unavailable;
  if (
    record.contract_version !== MANAGED_ADMISSION_CONTRACT ||
    typeof record.message !== "string" ||
    typeof record.request_id !== "string"
  ) {
    return unavailable;
  }

  const outcome = record.code;
  if (
    typeof outcome !== "string" ||
    !(outcome in STATUS_BY_OUTCOME) ||
    STATUS_BY_OUTCOME[outcome as ManagedServerOutcome] !== status
  ) {
    return unavailable;
  }

  if (outcome === "license_rejected") {
    const reason = record.reason;
    if (
      typeof reason !== "string" ||
      !REJECT_REASONS.has(reason as ManagedLicenseRejectReason) ||
      !hasExactKeys(record, ["contract_version", "code", "message", "request_id", "reason"])
    ) {
      return unavailable;
    }
    return { outcome, reason: reason as ManagedLicenseRejectReason };
  }

  if (outcome === "temporarily_unavailable") {
    if (
      record.retryable !== true ||
      record.grace_eligible !== true ||
      !hasExactKeys(record, [
        "contract_version",
        "code",
        "message",
        "request_id",
        "retryable",
        "grace_eligible",
      ])
    ) {
      return unavailable;
    }
    return { outcome };
  }

  if (!hasExactKeys(record, ["contract_version", "code", "message", "request_id"])) {
    return unavailable;
  }
  return { outcome: outcome as ManagedServerOutcome };
}

export type LegacyLicenseProfile = Readonly<{
  email: string;
  userName: string;
  displayName: string;
}>;

/**
 * The established success envelope of servers that predate admission-v1.
 * Only license validation accepts it, and only as proof of a valid license;
 * managed admission never treats it as `allowed`.
 */
export function decodeLegacyLicenseProfile(status: number, value: unknown): LegacyLicenseProfile | null {
  if (status !== 200 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.status !== "success" || !envelope.data || typeof envelope.data !== "object") return null;
  const profile = envelope.data as Record<string, unknown>;
  if (profile.subscription_status !== "active" || typeof profile.email !== "string") return null;
  const userName = typeof profile.user_name === "string" ? profile.user_name : profile.email;
  const displayName = typeof profile.display_name === "string" ? profile.display_name : userName;
  return { email: profile.email, userName, displayName };
}
