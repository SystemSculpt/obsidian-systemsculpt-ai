import type { ManagedEmbeddingsErrorCode } from "./gateway/ManagedEmbeddingsIndexAdapter";

/** Stops batch admission and suspends queued indexing, including after reload. */
export function isFatalManagedEmbeddingsCode(code: unknown): code is ManagedEmbeddingsErrorCode {
  return code === "payment_required"
    || code === "license_required"
    || code === "license_rejected"
    || code === "version_unsupported"
    || code === "capability_unavailable";
}
