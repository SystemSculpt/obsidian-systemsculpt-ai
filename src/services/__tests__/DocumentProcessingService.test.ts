import { App, Notice, TFile } from "obsidian";
import { DocumentProcessingService } from "../DocumentProcessingService";
import { SystemSculptService } from "../SystemSculptService";
import { errorLogger } from "../../utils/errorLogger";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    error: jest.fn(),
  },
}));

const uploadDocument = jest.fn();

jest.mock("../SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({
      uploadDocument,
    })),
  },
}));

const createPlugin = () => {
  const app = new App();
  app.vault.adapter.exists = jest.fn().mockResolvedValue(true);
  app.vault.adapter.read = jest.fn().mockResolvedValue("{}");
  app.vault.adapter.write = jest.fn().mockResolvedValue(undefined);
  app.vault.create = jest.fn().mockResolvedValue(new TFile({ path: "SystemSculpt/Extractions/out.md" }));
  app.vault.createFolder = jest.fn().mockResolvedValue(undefined);
  app.vault.modify = jest.fn().mockResolvedValue(undefined);
  app.vault.getAbstractFileByPath = jest.fn().mockReturnValue(null);
  app.workspace = {
    getLeaf: jest.fn(() => ({
      open: jest.fn().mockResolvedValue(undefined),
    })),
    openLinkText: jest.fn().mockResolvedValue(undefined),
    setActiveLeaf: jest.fn(),
  } as any;

  return {
    app,
    settings: {
      extractionsDirectory: "SystemSculpt/Extractions",
    },
    getLicenseManager: () => ({
      validateLicenseKey: jest.fn().mockResolvedValue(true),
    }),
  } as any;
};

describe("DocumentProcessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    if (!globalThis.window) {
      (globalThis as any).window = {};
    }
    if (!globalThis.window.atob) {
      globalThis.window.atob = (b64: string) =>
        Buffer.from(b64, "base64").toString("binary");
    }
  });

  it("clamps progress values", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    expect((service as any).clampProgress(NaN)).toBe(0);
    expect((service as any).clampProgress(Infinity)).toBe(100);
    expect((service as any).clampProgress(-10)).toBe(0);
    expect((service as any).clampProgress(120)).toBe(100);
    expect((service as any).clampProgress(42)).toBe(42);
  });

  it("maps normalized status values to stages", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    expect((service as any).mapNormalizedStatusToStage("queued")).toBe("queued");
    expect((service as any).mapNormalizedStatusToStage("validating")).toBe("validating");
    expect((service as any).mapNormalizedStatusToStage("processing")).toBe("processing");
    expect((service as any).mapNormalizedStatusToStage("contextualizing")).toBe("contextualizing");
    expect((service as any).mapNormalizedStatusToStage("completed")).toBe("ready");
    expect((service as any).mapNormalizedStatusToStage("failed")).toBe("error");
    expect((service as any).mapNormalizedStatusToStage("unknown")).toBe("processing");
  });

  it("processes cached documents without polling", async () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    uploadDocument.mockResolvedValue({ documentId: "doc-1", cached: true });

    const downloadExtraction = jest
      .spyOn(service as any, "downloadExtraction")
      .mockResolvedValue({ markdown: "cached" });
    const saveExtractionResults = jest
      .spyOn(service as any, "saveExtractionResults")
      .mockResolvedValue("SystemSculpt/Extractions/doc-1.md");

    const result = await service.processDocument(new TFile({ path: "doc.pdf", name: "doc.pdf" }), {
      showNotices: true,
    });

    expect(result).toBe("SystemSculpt/Extractions/doc-1.md");
    expect(downloadExtraction).toHaveBeenCalled();
    expect(saveExtractionResults).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalled();
  });

  it("processes fresh documents with polling", async () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    uploadDocument.mockResolvedValue({ documentId: "doc-2", cached: false });

    const pollSpy = jest
      .spyOn(service as any, "pollUntilComplete")
      .mockResolvedValue({ completed: true });
    jest
      .spyOn(service as any, "downloadExtraction")
      .mockResolvedValue({ markdown: "fresh" });
    jest
      .spyOn(service as any, "saveExtractionResults")
      .mockResolvedValue("SystemSculpt/Extractions/doc-2.md");

    const result = await service.processDocument(new TFile({ path: "doc2.pdf", name: "doc2.pdf" }), {
      showNotices: false,
    });

    expect(result).toBe("SystemSculpt/Extractions/doc-2.md");
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(pollSpy.mock.calls[0]?.[4]).toBe(180);
  });

  it("uses actionable timeout fallback when polling is incomplete without explicit error", async () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    uploadDocument.mockResolvedValue({ documentId: "doc-timeout", cached: false });

    jest
      .spyOn(service as any, "pollUntilComplete")
      .mockResolvedValue({ completed: false, status: "processing" });

    await expect(
      service.processDocument(new TFile({ path: "slow.pdf", name: "slow.pdf" }), {
        showNotices: false,
      })
    ).rejects.toThrow(
      "Document is still processing on SystemSculpt. Please retry in about a minute."
    );
  });

  it("rejects when license validation fails", async () => {
    const plugin = createPlugin();
    plugin.getLicenseManager = () => ({
      validateLicenseKey: jest.fn().mockResolvedValue(false),
    });
    const service = new DocumentProcessingService(plugin.app, plugin);
    uploadDocument.mockResolvedValue({ documentId: "doc-3" });

    await expect(
      service.processDocument(new TFile({ path: "doc3.pdf", name: "doc3.pdf" }), {
        showNotices: false,
      })
    ).rejects.toThrow("Valid license required");
  });

  it("normalizes progress and flow when emitting updates", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    const handler = jest.fn();

    (service as any).emitProgress(
      handler,
      { stage: "processing", progress: 150, label: "Test", icon: "cpu" },
      { filePath: "doc.pdf" },
      "document"
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ progress: 100, flow: "document" })
    );
  });

  it("logs when progress handlers throw", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    const handler = jest.fn(() => {
      throw new Error("boom");
    });

    (service as any).emitProgress(
      handler,
      { stage: "processing", progress: 20, label: "Test", icon: "cpu" },
      { filePath: "doc.pdf" },
      "document"
    );

    expect(errorLogger.error).toHaveBeenCalled();
  });

  it("parses document status responses from json and text payloads", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    const jsonResponse = (service as any).parseDocumentStatusResponse({
      json: { data: { normalizedStatus: "READY", status: "done", error: "bad", progress: 42 } },
    });

    expect(jsonResponse.normalizedStatus).toBe("ready");
    expect(jsonResponse.rawStatus).toBe("done");
    expect(jsonResponse.error).toBe("bad");
    expect(jsonResponse.progress).toBe(42);

    const textResponse = (service as any).parseDocumentStatusResponse({
      text: JSON.stringify({ status: "COMPLETED", error: "nope" }),
    });

    expect(textResponse.normalizedStatus).toBe("completed");
    expect(textResponse.rawStatus).toBe("COMPLETED");
    expect(textResponse.error).toBe("nope");

    const invalidResponse = (service as any).parseDocumentStatusResponse({
      text: "not json",
    });

    expect(invalidResponse.normalizedStatus).toBe("processing");
  });

  it("extracts images from supported payload shapes", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    const images = (service as any).extractImagesFromData({
      images: { "a.png": "img-a", ignore: 5 },
      document: { images: { "b.png": "img-b" } },
      imageList: [{ name: "c.png", data: "img-c" }, { data: 4 }],
      figures: [{ name: "d.png", image: "img-d" }, {}],
    });

    expect(images).toEqual({
      "a.png": "img-a",
      "b.png": "img-b",
      "c.png": "img-c",
      "d.png": "img-d",
    });
  });

  it("formats extraction content with metadata and image notes", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    (service as any).imageMetadataLog = [
      { path: "SystemSculpt/Extractions/images-doc/image-1.png" },
    ];

    const content = (service as any).formatExtractionContent({
      metadata: { title: "My Title" },
      text: "Hello",
      images: { "image-1.png": "data" },
    });

    expect(content).toContain("# My Title");
    expect(content).toContain("Hello");
    expect(content).toContain("Images");
    expect(content).toContain("images-doc");

    const fallback = (service as any).formatExtractionContent(null);
    expect(fallback).toContain("No content was extracted");
  });

  it("formats extraction content with direct title and plural image notes", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    const content = (service as any).formatExtractionContent({
      title: "Direct Title",
      content: "Body",
      images: { "a.png": "data", "b.png": "data" },
    });

    expect(content).toContain("# Direct Title");
    expect(content).toContain("Body");
    expect(content).toContain("2 images were");
  });

  it("stringifies objects with no content fields", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    const content = (service as any).formatExtractionContent({ foo: "bar" });
    expect(content).toContain('"foo": "bar"');
  });

  it("generates deterministic image names and hashes", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);

    const name1 = (service as any).generateUniqueImageName("My Doc", "Image 1.PNG", "data");
    const name2 = (service as any).generateUniqueImageName("My Doc", "Image 1.PNG", "data");
    const name3 = (service as any).generateUniqueImageName("My Doc", "Image 1.PNG");

    expect(name1).toBe(name2);
    expect(name1).toContain("My-Doc");
    expect(name1).toContain("Image-1");
    expect(name1.endsWith(".png")).toBe(true);
    expect(name3).toContain("My-Doc");
  });

  it("decodes base64 data into array buffers and sanitizes paths", () => {
    const plugin = createPlugin();
    const service = new DocumentProcessingService(plugin.app, plugin);
    const payload = Buffer.from("hello", "utf8").toString("base64");
    const buffer = (service as any).base64ToArrayBuffer(`data:image/png;base64,${payload}`);

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array(Buffer.from("hello", "utf8")));
    expect((service as any).sanitizeFilename("My File.pdf")).toBe("My-File-pdf");
    expect((service as any).normalizePath("/a/b//")).toBe("a/b");
  });
});
