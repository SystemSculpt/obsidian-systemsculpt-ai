/**
 * @jest-environment jsdom
 */

import { buildPercentileExcerpt, TranscriptionTitleService } from "../TranscriptionTitleService";

describe("buildPercentileExcerpt", () => {
  it("returns the full text when under the limit", () => {
    expect(buildPercentileExcerpt("hello world", 500)).toBe("hello world");
  });

  it("returns a bounded excerpt that includes the start and end", () => {
    const text = `START_${"a".repeat(5000)}_END`;
    const excerpt = buildPercentileExcerpt(text, 600);

    expect(excerpt.length).toBeLessThanOrEqual(600);
    expect(excerpt).toContain("START_");
    expect(excerpt).toContain("_END");
  });
});

describe("TranscriptionTitleService", () => {
  beforeEach(() => {
    (TranscriptionTitleService as any).instance = null;
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const plugin: any = { settings: {} };
      const service1 = TranscriptionTitleService.getInstance(plugin);
      const service2 = TranscriptionTitleService.getInstance(plugin);
      expect(service1).toBe(service2);
    });
  });

  describe("buildFallbackBasename", () => {
    it("returns just transcript label for empty prefix", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.buildFallbackBasename("")).toBe("transcript");
    });

    it("returns just transcript label for whitespace prefix", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.buildFallbackBasename("   ")).toBe("transcript");
    });

    it("combines prefix with transcript label", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.buildFallbackBasename("my-audio")).toBe("my-audio - transcript");
    });
  });

  describe("sanitizeGeneratedTitle", () => {
    it("sanitizes model output into a safe title", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.sanitizeGeneratedTitle('  "My/Title: Draft.md"  \n')).toBe("MyTitle Draft");
    });

    it("handles empty input", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.sanitizeGeneratedTitle("")).toBe("");
    });

    it("removes leading/trailing dashes", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.sanitizeGeneratedTitle("---Title---")).toBe("Title");
    });

    it("normalizes whitespace", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.sanitizeGeneratedTitle("Title   with   spaces")).toBe("Title with spaces");
    });
  });

  describe("isUsableTitle", () => {
    it("rejects empty titles", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.isUsableTitle("")).toBe(false);
    });

    it("rejects whitespace-only titles", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.isUsableTitle("   ")).toBe(false);
    });

    it("rejects overly long titles", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.isUsableTitle("a".repeat(121))).toBe(false);
    });

    it("accepts valid titles", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.isUsableTitle("Good Title")).toBe(true);
    });
  });

  describe("buildTitledBasename", () => {
    it("combines prefix and title", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      expect(service.buildTitledBasename("audio", "My Title")).toBe("audio - transcript - My Title");
    });
  });

  describe("buildTitleContext", () => {
    it("returns excerpt of transcript", () => {
      const plugin: any = { settings: {} };
      const service = TranscriptionTitleService.getInstance(plugin);
      const result = service.buildTitleContext("short text");
      expect(result).toBe("short text");
    });
  });

  describe("tryGenerateTitle", () => {
    it("returns null when no model is configured", async () => {
      const plugin: any = { settings: { selectedModelId: "" } };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      const result = await service.tryGenerateTitle("some transcript");
      expect(result).toBeNull();
    });

    it("returns null for empty transcript", async () => {
      const plugin: any = { settings: { selectedModelId: "gpt-4" } };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      const result = await service.tryGenerateTitle("");
      expect(result).toBeNull();
    });
  });

  describe("tryRenameTranscriptionFile", () => {
    it("returns original path when title generation fails", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue(null);

      const transcriptionFile: any = {
        path: "recordings/test.md",
        extension: "md",
      };

      const result = await service.tryRenameTranscriptionFile({} as any, transcriptionFile, {
        prefix: "test",
        transcriptText: "hello",
      });

      expect(result).toBe("recordings/test.md");
    });

    it("renames with collision suffix when destination exists", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue("My Title");

      const renameFile = jest.fn().mockResolvedValue(undefined);
      const vaultExists = new Set<string>([
        "recordings/test-audio - transcript - My Title.md",
      ]);

      const app: any = {
        vault: {
          getAbstractFileByPath: (path: string) => (vaultExists.has(path) ? ({ path } as any) : null),
        },
        fileManager: { renameFile },
      };

      const transcriptionFile: any = {
        path: "recordings/test-audio - transcript.md",
        extension: "md",
      };

      const finalPath = await service.tryRenameTranscriptionFile(app, transcriptionFile, {
        prefix: "test-audio",
        transcriptText: "hello",
        extension: "md",
      });

      expect(renameFile).toHaveBeenCalledWith(
        transcriptionFile,
        "recordings/test-audio - transcript - My Title (2).md"
      );
      expect(finalPath).toBe("recordings/test-audio - transcript - My Title (2).md");
    });

    it("returns original path when rename fails", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue("My Title");

      const app: any = {
        vault: {
          getAbstractFileByPath: () => null,
        },
        fileManager: {
          renameFile: jest.fn().mockRejectedValue(new Error("Rename failed")),
        },
      };

      const transcriptionFile: any = {
        path: "recordings/test.md",
        extension: "md",
      };

      const result = await service.tryRenameTranscriptionFile(app, transcriptionFile, {
        prefix: "test",
        transcriptText: "hello",
      });

      expect(result).toBe("recordings/test.md");
    });

    it("returns same path when destination equals current", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue("My Title");

      const app: any = {
        vault: {
          getAbstractFileByPath: () => null,
        },
        fileManager: { renameFile: jest.fn() },
      };

      const transcriptionFile: any = {
        path: "recordings/test - transcript - My Title.md",
        extension: "md",
      };

      const result = await service.tryRenameTranscriptionFile(app, transcriptionFile, {
        prefix: "test",
        transcriptText: "hello",
      });

      expect(result).toBe("recordings/test - transcript - My Title.md");
    });

    it("handles files without extension", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue("Title");

      const app: any = {
        vault: { getAbstractFileByPath: () => null },
        fileManager: { renameFile: jest.fn().mockResolvedValue(undefined) },
      };

      const transcriptionFile: any = {
        path: "recordings/test.md",
        extension: "",
      };

      const result = await service.tryRenameTranscriptionFile(app, transcriptionFile, {
        prefix: "test",
        transcriptText: "hello",
      });

      expect(result).toBe("recordings/test - transcript - Title.md");
    });

    it("handles root-level files", async () => {
      const plugin: any = { settings: {} };
      (TranscriptionTitleService as any).instance = null;
      const service = TranscriptionTitleService.getInstance(plugin);

      jest.spyOn(service, "tryGenerateTitle").mockResolvedValue("Title");

      const app: any = {
        vault: { getAbstractFileByPath: () => null },
        fileManager: { renameFile: jest.fn().mockResolvedValue(undefined) },
      };

      const transcriptionFile: any = {
        path: "test.md",
        extension: "md",
      };

      const result = await service.tryRenameTranscriptionFile(app, transcriptionFile, {
        prefix: "test",
        transcriptText: "hello",
      });

      expect(result).toBe("test - transcript - Title.md");
    });
  });
});

describe("buildPercentileExcerpt edge cases", () => {
  it("handles empty text", () => {
    expect(buildPercentileExcerpt("", 500)).toBe("");
  });

  it("handles null-ish text", () => {
    expect(buildPercentileExcerpt(null as any, 500)).toBe("");
  });

  it("handles very small maxChars", () => {
    const text = "This is a longer text that should be truncated";
    const result = buildPercentileExcerpt(text, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("normalizes CRLF to LF", () => {
    const text = "line1\r\nline2\r\nline3";
    const result = buildPercentileExcerpt(text, 500);
    expect(result).not.toContain("\r");
  });
});

