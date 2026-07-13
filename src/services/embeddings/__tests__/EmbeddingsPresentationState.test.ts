import {
  deriveEmbeddingsIndexPresentation,
  readEmbeddingErrorMessage,
  type EmbeddingsIndexStats,
} from "../EmbeddingsPresentationState";

const stats = (overrides: Partial<EmbeddingsIndexStats> = {}): EmbeddingsIndexStats => ({
  total: 10,
  processed: 10,
  present: 10,
  needsProcessing: 0,
  failed: 0,
  ...overrides,
});

describe("EmbeddingsPresentationState", () => {
  it("orders failure, processing, pending, and ready states without overlap", () => {
    expect(deriveEmbeddingsIndexPresentation(stats({ failed: 1 }), true)).toMatchObject({
      state: "needs-attention",
      label: "Needs attention",
      showProgress: false,
      errorMessage: "1 file couldn’t be embedded. Retry it.",
    });
    expect(deriveEmbeddingsIndexPresentation(stats(), true)).toMatchObject({
      state: "processing",
      label: "Processing",
      showProgress: true,
      errorMessage: null,
    });
    expect(deriveEmbeddingsIndexPresentation(stats({ processed: 8, needsProcessing: 2 }), false)).toMatchObject({
      state: "needs-processing",
      label: "Needs processing",
      showProgress: false,
      errorMessage: null,
    });
    expect(deriveEmbeddingsIndexPresentation(stats(), false)).toMatchObject({
      state: "ready",
      label: "Ready",
      showProgress: false,
      errorMessage: null,
    });
  });

  it("uses an explicit error before count-based fallback copy", () => {
    expect(deriveEmbeddingsIndexPresentation(
      stats({ failed: 2 }),
      false,
      { error: { message: "  Managed service unavailable  " } },
    ).errorMessage).toBe("Managed service unavailable");
  });

  it("normalizes unexpected, empty, and overlong errors", () => {
    expect(readEmbeddingErrorMessage({ error: { message: "  Network   unavailable " } })).toBe("Network unavailable");
    expect(readEmbeddingErrorMessage({ error: { message: "  " } }, "Try again.")).toBe("Try again.");
    expect(readEmbeddingErrorMessage("x".repeat(300)).length).toBe(160);
    expect(readEmbeddingErrorMessage("x".repeat(300)).endsWith("…")).toBe(true);
  });
});
