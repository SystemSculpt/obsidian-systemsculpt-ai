import { App, Notice, TFile } from "obsidian";
import {
  DocumentProcessingService,
  ManagedDocumentLocalEffectError,
  type DocumentProcessingDependencies,
} from "../DocumentProcessingService";
import { sha256HexFromBytesPortable } from "../../studio/hash";
import { errorLogger } from "../../utils/errorLogger";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

jest.mock("../../utils/errorLogger", () => ({ errorLogger: { error: jest.fn() } }));

const sourceBytes = new Uint8Array([1, 2, 3, 4]).buffer;
const imageBase64 = Buffer.from("managed-image-bytes", "utf8").toString("base64");

function file(path = "documents/report.pdf"): TFile {
  const value = new TFile({ path });
  Object.defineProperty(value, "extension", { value: "pdf" });
  Object.defineProperty(value, "name", { value: "report.pdf" });
  Object.defineProperty(value, "basename", { value: "report" });
  return value;
}

function harness(options: { images?: boolean; exists?: boolean; existingMarkdown?: string } = {}) {
  const events: string[] = [];
  const app = new App();
  app.vault.readBinary = jest.fn(async () => { events.push("vault-read"); return sourceBytes; });
  app.vault.createBinary = jest.fn(async () => { events.push("image-effect"); return file("out.png"); });
  app.vault.create = jest.fn(async () => { events.push("markdown-effect"); return file("out.md"); });
  app.vault.adapter.exists = jest.fn(async () => options.exists ?? false);
  app.vault.adapter.read = jest.fn(async () => options.existingMarkdown ?? "different");
  app.vault.adapter.readBinary = jest.fn(async () => new Uint8Array([9]).buffer);

  const result = {
    content: [],
    text: "managed text",
    markdown: options.images ? "![figure](figure.png)" : "# Managed document",
    images: options.images ? [{ name: "figure.png", data: `data:image/png;base64,${imageBase64}` }] : [],
    metadata: { title: "Managed" },
  };
  const managed = {
    process: jest.fn(async (source: any, context: any) => {
      events.push("managed");
      await source.fingerprint();
      await source.load();
      context.onProgress?.(50, "Uploading document…");
      return { operationId: "document-op-1", documentId: "document-1", result };
    }),
    resume: jest.fn(),
    beginLocalCommit: jest.fn(async () => { events.push("local-pending"); return {} as any; }),
    completeLocalCommit: jest.fn(async () => { events.push("local-complete"); return {} as any; }),
  };
  let artifacts: ReadonlyArray<{ kind: "image" | "markdown"; bytes: ArrayBuffer }> = [];
  const staging = {
    stage: jest.fn(async (_operationId: string, values: typeof artifacts) => {
      events.push("stage");
      artifacts = values;
      return values.map((value, index) => ({
        id: String(index + 1).repeat(64),
        kind: value.kind,
        byteLength: value.bytes.byteLength,
        sha256: sha256HexFromBytesPortable(new Uint8Array(value.bytes)),
      }));
    }),
    readVerified: jest.fn(async () => { events.push("stage-read"); return artifacts.map((value) => value.bytes); }),
    cleanup: jest.fn(async () => { events.push("cleanup"); }),
  };
  const plugin = {
    app,
    manifest: { id: "systemsculpt-ai", dir: ".obsidian/plugins/systemsculpt-ai" },
    settings: { extractionsDirectory: "SystemSculpt/Extractions" },
    directoryManager: { ensureDirectoryByPath: jest.fn(async () => { events.push("directory"); }) },
    createDirectory: jest.fn(),
  } as any;
  const dependencies: DocumentProcessingDependencies = { managed: managed as any, staging: staging as any };
  return { app, dependencies, events, managed, plugin, staging };
}

describe("DocumentProcessingService managed local effects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.atob ??= (value: string) => Buffer.from(value, "base64").toString("binary");
  });

  it("uses one signal and commits verified image, Markdown, and context effects in order", async () => {
    const { app, dependencies, events, managed, plugin, staging } = harness({ images: true });
    const service = new DocumentProcessingService(app, plugin, dependencies);
    const controller = new AbortController();
    const context = jest.fn(async () => { events.push("context-effect"); });

    const receipt = await service.processDocumentWithReceipt(file(), {
      signal: controller.signal,
      showNotices: false,
      commitContextEffect: context,
    });

    expect(receipt.extractionPath).toBe("SystemSculpt/Extractions/report/report-extraction.md");
    expect(receipt.imagePaths).toHaveLength(1);
    expect(receipt.markdownSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.contextEffectId).toMatch(/^[a-f0-9]{64}$/);
    expect(events.indexOf("stage")).toBeLessThan(events.indexOf("image-effect"));
    expect(events.indexOf("image-effect")).toBeLessThan(events.indexOf("markdown-effect"));
    expect(events.indexOf("markdown-effect")).toBeLessThan(events.indexOf("context-effect"));
    expect(events.indexOf("context-effect")).toBeLessThan(events.indexOf("local-complete"));
    expect(events.at(-1)).toBe("cleanup");
    expect(managed.process.mock.calls[0][1].signal).toBe(controller.signal);
    expect(staging.stage.mock.calls[0][2]).toBe(controller.signal);
    expect(context.mock.calls[0][1]).toBe(controller.signal);
    expect(app.vault.create).toHaveBeenCalledWith(
      receipt.extractionPath,
      expect.stringContaining("images-report/report-figure-"),
    );
  });

  it("stops all later local effects when abort wins an image write", async () => {
    const { app, dependencies, managed, plugin } = harness({ images: true });
    const service = new DocumentProcessingService(app, plugin, dependencies);
    const controller = new AbortController();
    (app.vault.createBinary as jest.Mock).mockImplementationOnce(async () => { controller.abort(); return file("out.png"); });

    await expect(service.processDocument(file(), { signal: controller.signal, showNotices: false }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(managed.completeLocalCommit).not.toHaveBeenCalled();
  });

  it("fails closed when an existing Markdown target has a different effect identity", async () => {
    const { app, dependencies, plugin } = harness({ exists: true, existingMarkdown: "different" });
    const service = new DocumentProcessingService(app, plugin, dependencies);

    await expect(service.processDocument(file(), { showNotices: false }))
      .rejects.toBeInstanceOf(ManagedDocumentLocalEffectError);
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("keeps progress, payload normalization, deterministic names, and portable base64 behavior", () => {
    const { app, dependencies, plugin } = harness();
    const service = new DocumentProcessingService(app, plugin, dependencies);
    const handler = jest.fn();
    (service as any).emitProgress(handler, { stage: "processing", progress: 150, label: "Test", icon: "cpu" }, { filePath: "doc.pdf" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ progress: 100, flow: "document" }));
    expect((service as any).mapNormalizedStatusToStage("completed")).toBe("ready");
    expect((service as any).extractImagesFromData({ images: [{ filename: "a.png", base64: "abc" }] })).toEqual({ "a.png": "abc" });
    expect((service as any).generateUniqueImageName("My Doc", "Image 1.PNG", "data")).toMatch(/^My-Doc-Image-1-.*\.png$/);
    expect(new TextDecoder().decode((service as any).base64ToArrayBuffer(Buffer.from("hello").toString("base64")))).toBe("hello");
    expect((service as any).formatExtractionContent({ metadata: { title: "Title" }, text: "Body" })).toContain("# Title\n\nBody");
  });

  it("contains progress-handler failures without altering conversion state", () => {
    const { app, dependencies, plugin } = harness();
    const service = new DocumentProcessingService(app, plugin, dependencies);
    (service as any).emitProgress(() => { throw new Error("boom"); }, { stage: "processing", progress: 20, label: "Test", icon: "cpu" });
    expect(errorLogger.error).toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });
});
