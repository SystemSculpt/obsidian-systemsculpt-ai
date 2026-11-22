const AGENT_BILLING_FAILURE_CODES: ReadonlySet<string> = new Set([
  "insufficient_credits",
  "payment_required",
  "out_of_credits",
]);

export function isAgentBillingFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; status?: unknown };
  return failure.status === 402
    || (
      typeof failure.code === "string"
      && AGENT_BILLING_FAILURE_CODES.has(failure.code)
    );
}

/**
 * A hosted 401 or 403: the server refused the license key the turn carried.
 * The license manager decides what it means; only a key the server no longer
 * knows signs the plugin out.
 */
export function isAgentAuthorizationRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status } = error as { status?: unknown };
  return status === 401 || status === 403;
}
