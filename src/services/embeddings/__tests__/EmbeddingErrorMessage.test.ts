import { readEmbeddingErrorMessage } from "../EmbeddingErrorMessage";

describe("readEmbeddingErrorMessage", () => {
  it("normalizes unexpected, empty, and overlong errors", () => {
    expect(readEmbeddingErrorMessage({ error: { message: "  Network   unavailable " } })).toBe("Network unavailable");
    expect(readEmbeddingErrorMessage({ error: { message: "  " } }, "Try again.")).toBe("Try again.");
    expect(readEmbeddingErrorMessage("x".repeat(300)).length).toBe(160);
    expect(readEmbeddingErrorMessage("x".repeat(300)).endsWith("…")).toBe(true);
  });
});
