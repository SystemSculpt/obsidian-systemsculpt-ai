export interface EmbeddingsIndexStats {
  total: number;
  processed: number;
  present: number;
  needsProcessing: number;
  failed: number;
}

export type EmbeddingsIndexPresentationState =
  | "processing"
  | "needs-attention"
  | "needs-processing"
  | "ready";

export interface EmbeddingsIndexPresentation {
  state: EmbeddingsIndexPresentationState;
  label: string;
  indicator: "active" | "attention" | "pending" | "idle";
  showProgress: boolean;
  errorMessage: string | null;
}

const MAX_ERROR_MESSAGE_LENGTH = 160;

function errorCandidate(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  return errorCandidate(record.error) ?? errorCandidate(record.failure);
}

/**
 * Produces short, visible product copy from errors and event payloads.
 * Presentation surfaces call this at their boundary so whitespace-only or
 * unexpected payload shapes can never render an empty alert.
 */
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

function failedFilesMessage(count: number): string {
  return count === 1
    ? "1 file couldn’t be embedded. Retry it."
    : `${count} files couldn’t be embedded. Retry them.`;
}

/**
 * One precedence-ordered state model for the status badge, progress surface,
 * alert, and actions. Failures win over transient processing locks; pending
 * work wins over readiness.
 */
export function deriveEmbeddingsIndexPresentation(
  stats: EmbeddingsIndexStats,
  isProcessing: boolean,
  error: unknown = null,
): EmbeddingsIndexPresentation {
  const failed = Math.max(0, Number.isFinite(stats.failed) ? stats.failed : 0);
  const needsProcessing = Math.max(
    0,
    Number.isFinite(stats.needsProcessing) ? stats.needsProcessing : 0,
  );
  const explicitError = error === null || error === undefined
    ? null
    : readEmbeddingErrorMessage(error);

  if (explicitError || failed > 0) {
    return {
      state: "needs-attention",
      label: "Needs attention",
      indicator: "attention",
      showProgress: false,
      errorMessage: explicitError ?? failedFilesMessage(failed),
    };
  }

  if (isProcessing) {
    return {
      state: "processing",
      label: "Processing",
      indicator: "active",
      showProgress: true,
      errorMessage: null,
    };
  }

  if (needsProcessing > 0) {
    return {
      state: "needs-processing",
      label: "Needs processing",
      indicator: "pending",
      showProgress: false,
      errorMessage: null,
    };
  }

  return {
    state: "ready",
    label: "Ready",
    indicator: "idle",
    showProgress: false,
    errorMessage: null,
  };
}
