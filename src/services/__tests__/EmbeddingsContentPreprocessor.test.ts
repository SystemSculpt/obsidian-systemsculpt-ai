import { ContentPreprocessor } from "../embeddings/processing/ContentPreprocessor";

describe("ContentPreprocessor", () => {
  const preprocessor = new ContentPreprocessor();

  it("retains large content bodies below the hard truncate limit", () => {
    const longText = "a".repeat(150_000);
    const processed = preprocessor.process(longText, {} as any);
    expect(processed).not.toBeNull();
    expect(processed?.length).toBe(150_000);
  });

  it("splits extremely long unpunctuated content into multiple chunks", () => {
    const oversized = "b".repeat(20_000);
    const chunks = preprocessor.chunkContent(oversized);
    expect(chunks.length).toBeGreaterThan(1);
    const maxChunkLength = Math.max(...chunks.map((chunk) => chunk.length));
    expect(maxChunkLength).toBeLessThanOrEqual(3_400);
  });

  it("produces matching chunk hashes for deterministic content", () => {
    const base = ["First sentence.", "Second sentence.", "Third sentence."].join(" ");
    const withHashes = preprocessor.chunkContentWithHashes(base);
    expect(withHashes.length).toBeGreaterThan(0);
    const recomputed = preprocessor.chunkContentWithHashes(base);
    expect(recomputed.map((chunk) => chunk.hash)).toEqual(withHashes.map((chunk) => chunk.hash));
  });

  it("captures heading context when chunking structured markdown", () => {
    const content = `# Title\n\nA paragraph about testing. Another sentence for good measure.\n\n## Subsection\n\nMore detailed notes follow here with additional content to force chunking.`;
    const processed = preprocessor.process(content, {} as any);
    expect(processed).not.toBeNull();
    const chunks = preprocessor.chunkContentWithHashes(processed!.content, processed!.source);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].headingPath).toContain("Title");
    if (chunks.length > 1) {
      // Later chunks should retain the most specific heading available
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.headingPath[lastChunk.headingPath.length - 1]).toBe("Subsection");
    }
  });
});
