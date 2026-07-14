const MAX_ERROR_MESSAGE_LENGTH = 160;

function errorCandidate(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  return errorCandidate(record.error) ?? errorCandidate(record.failure);
}

/** Keep unexpected managed errors visible, short, and safe for compact UI. */
export function readEmbeddingErrorMessage(
  value: unknown,
  fallback = "Embeddings failed. Try again.",
): string {
  const fallbackText = String(fallback || "Embeddings failed. Try again.").replace(/\s+/g, " ").trim()
    || "Embeddings failed. Try again.";
  const normalized = String(errorCandidate(value) ?? "").replace(/\s+/g, " ").trim();
  const message = normalized || fallbackText;
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1).trimEnd()}…`
    : message;
}
