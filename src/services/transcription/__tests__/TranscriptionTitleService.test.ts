/** @jest-environment jsdom */
import { buildPercentileExcerpt, TranscriptionTitleService } from "../TranscriptionTitleService";

describe("TranscriptionTitleService", () => {
  beforeEach(() => {
    (TranscriptionTitleService as unknown as { instance: TranscriptionTitleService | null }).instance = null;
  });

  const service = () => TranscriptionTitleService.getInstance({} as never);

  it("builds deterministic fallback names", () => {
    expect(service().buildFallbackBasename("")).toBe("transcript");
    expect(service().buildFallbackBasename("audio")).toBe("audio - transcript");
  });

  it("derives a safe local title from the first meaningful transcript line", async () => {
    await expect(service().tryGenerateTitle("[00:01] Managed architecture cutover status\nMore detail"))
      .resolves.toBe("Managed architecture cutover status");
  });

  it("returns null for empty transcripts and never needs a plugin runtime", async () => {
    await expect(service().tryGenerateTitle("   ")).resolves.toBeNull();
  });

  it("sanitizes and bounds titles", () => {
    expect(service().sanitizeGeneratedTitle('  "My/Title: Draft.md"  ')).toBe("MyTitle Draft");
    expect(service().isUsableTitle("a".repeat(121))).toBe(false);
  });

  it("renames with a collision suffix", async () => {
    const renameFile = jest.fn().mockResolvedValue(undefined);
    const app = {
      vault: { getAbstractFileByPath: (path: string) => path.endsWith("Local meeting title.md") ? { path } : null },
      fileManager: { renameFile },
    } as any;
    const file = { path: "recordings/audio - transcript.md", extension: "md" } as any;
    jest.spyOn(service(), "tryGenerateTitle").mockResolvedValue("Local meeting title");
    await expect(service().tryRenameTranscriptionFile(app, file, { prefix: "audio", transcriptText: "body" }))
      .resolves.toBe("recordings/audio - transcript - Local meeting title (2).md");
    expect(renameFile).toHaveBeenCalledTimes(1);
  });
});

describe("buildPercentileExcerpt", () => {
  it("keeps short text and bounds long text with start and end samples", () => {
    expect(buildPercentileExcerpt("hello", 50)).toBe("hello");
    const excerpt = buildPercentileExcerpt(`START_${"a".repeat(5000)}_END`, 600);
    expect(excerpt.length).toBeLessThanOrEqual(600);
    expect(excerpt).toContain("START_");
    expect(excerpt).toContain("_END");
  });
});
