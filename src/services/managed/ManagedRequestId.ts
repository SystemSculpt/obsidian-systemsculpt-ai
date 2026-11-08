/** Correlation identity only; durable operation IDs remain the idempotency keys. */
export function createManagedRequestId(prefix = "plugin"): string {
  return window.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
