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
