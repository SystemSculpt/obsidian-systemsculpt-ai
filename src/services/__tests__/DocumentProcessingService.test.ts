import { App, Notice, TFile } from "obsidian";
import {
  DocumentProcessingService,
  ManagedDocumentLocalEffectError,
  type DocumentProcessingDependencies,
} from "../DocumentProcessingService";
import { sha256HexFromArrayBuffer, sha256HexFromBytesPortable } from "../../utils/sha256";
import { createVaultFileSource } from "../../platform/fileSource";
import type { ManagedFileSource } from "../managed/ManagedFileSource";

jest.mock("../../platform/fileSource", () => ({ createVaultFileSource: jest.fn() }));

jest.mock("../../utils/sha256", () => {
  const actual = jest.requireActual("../../utils/sha256");
  return { ...actual, sha256HexFromArrayBuffer: jest.fn(actual.sha256HexFromArrayBuffer) };
});
import { errorLogger } from "../../utils/errorLogger";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

jest.mock("../../utils/errorLogger", () => ({ errorLogger: { error: jest.fn() } }));

const HASH_SLICE_BYTES = 1024 * 1024;
const imageBase64 = Buffer.from("managed-image-bytes", "utf8").toString("base64");

function file(path = "documents/report.pdf"): TFile {
  const value = new TFile({ path, stat: { size: 4 } });
  Object.defineProperty(value, "extension", { value: "pdf" });
  Object.defineProperty(value, "name", { value: "report.pdf" });
  Object.defineProperty(value, "basename", { value: "report" });
  return value;
}

function harness(options: { images?: boolean; exists?: boolean; existingMarkdown?: string } = {}) {
  const events: string[] = [];
  const app = new App();
  app.vault.readBinary = jest.fn(async () => { throw new Error("Whole-file document reads are forbidden."); });
  const readSlice = jest.fn(async (start: number, end: number) => {
    if (start < 0 || end < start || end - start > HASH_SLICE_BYTES) {
      throw new Error("Expected a bounded document slice.");
    }
    return Uint8Array.from({ length: end - start }, (_, index) => (start + index + 1) % 256).buffer;
  });
  const release = jest.fn();
  jest.mocked(createVaultFileSource).mockImplementation((_app, selected) => ({
    sizeBytes: selected.stat.size,
    readSlice: (start, end) => {
      if (end > selected.stat.size) throw new Error("Document slice exceeds source size.");
      return readSlice(start, end);
    },
    release,
  }));
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
    processAndCommit: jest.fn(async (source: ManagedFileSource, context: any, commit: (value: any) => Promise<unknown>) => {
      events.push("managed");
      await source.fingerprint(context.signal);
      const loaded = await source.load();
      await loaded.readSlice(0, Math.min(loaded.sizeBytes, HASH_SLICE_BYTES));
      context.onProgress?.(50, "Uploading document…");
      return commit({ operationId: "document-op-1", documentId: "document-1", result });
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
  return { app, dependencies, events, managed, plugin, staging, readSlice, release };
}

describe("DocumentProcessingService managed local effects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.atob ??= (value: string) => Buffer.from(value, "base64").toString("binary");
  });

  it.each([
    [4, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"],
    [HASH_SLICE_BYTES + 4, "3516c0e390bf2c6467c0dd255b76a134f0f0d9c27c6ecadeb71cd5cd173f2af1"],
  ] as const)("caches the exact %s-byte SHA-256 while hashing and verifying only bounded windows", async (sizeBytes, expectedHash) => {
    const { app, dependencies, managed, plugin, readSlice } = harness();
    const selected = file();
    selected.stat.size = sizeBytes;
    const ranges = sizeBytes > HASH_SLICE_BYTES ? [[0, HASH_SLICE_BYTES], [HASH_SLICE_BYTES, sizeBytes]] : [[0, sizeBytes]];
    managed.processAndCommit.mockImplementationOnce(async (source: ManagedFileSource) => {
      const [first, second] = await Promise.all([source.fingerprint(), source.fingerprint()]);
      expect(first).toBe(`sha256:${expectedHash}`);
      expect(second).toBe(first);
      expect(readSlice.mock.calls).toEqual(ranges);
      expect(sha256HexFromArrayBuffer).toHaveBeenCalledTimes(ranges.length);
      const loaded = await source.load();
      expect(loaded).toMatchObject({ filename: "report.pdf", contentType: "application/pdf", sizeBytes });
      expect(loaded).not.toHaveProperty("bytes");
      expect(new Uint8Array(await loaded.readSlice(sizeBytes - 4, sizeBytes))).toEqual(new Uint8Array([1, 2, 3, 4]));
      return {};
    });
    await new DocumentProcessingService(app, plugin, dependencies).processDocumentWithReceipt(selected, { showNotices: false });
    expect(createVaultFileSource).toHaveBeenCalledTimes(1);
    expect(createVaultFileSource).toHaveBeenCalledWith(app, selected);
    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(readSlice.mock.calls).toEqual([...ranges, ranges.at(-1)]);
    expect(jest.mocked(sha256HexFromArrayBuffer).mock.calls.map(([bytes]) => bytes.byteLength))
      .toEqual([...ranges, ranges.at(-1)!].map(([start, end]) => end - start));
  });

  it("does not stage or write results when cancellation wins an asynchronous image digest", async () => {
    const { app, dependencies, managed, plugin, staging } = harness({ images: true });
    const controller = new AbortController();
    jest.mocked(sha256HexFromArrayBuffer)
      // Fingerprint window, then verification of the upload slice, then image.
      .mockImplementationOnce(async (bytes) => sha256HexFromBytesPortable(new Uint8Array(bytes)))
      .mockImplementationOnce(async (bytes) => sha256HexFromBytesPortable(new Uint8Array(bytes)))
      .mockImplementationOnce(async (bytes) => {
        controller.abort();
        return sha256HexFromBytesPortable(new Uint8Array(bytes));
      });
    await expect(new DocumentProcessingService(app, plugin, dependencies).processDocument(file(), {
      signal: controller.signal, showNotices: false,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(staging.stage).not.toHaveBeenCalled();
    expect(app.vault.createBinary).not.toHaveBeenCalled();
    expect(managed.completeLocalCommit).not.toHaveBeenCalled();
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
    expect(managed.processAndCommit.mock.calls[0][1].signal).toBe(controller.signal);
    expect(staging.stage.mock.calls[0][2]).toBe(controller.signal);
    expect(context.mock.calls[0][1]).toBe(controller.signal);
    expect(app.vault.create).toHaveBeenCalledWith(
      receipt.extractionPath,
      expect.stringContaining("images-report/report-figure-"),
    );
  });

  it("names the folder that holds the extracted images in the note", async () => {
    const { app, dependencies, plugin } = harness({ images: true });
    const service = new DocumentProcessingService(app, plugin, dependencies);

    const receipt = await service.processDocumentWithReceipt(file(), { showNotices: false });

    expect(receipt.imagePaths).toEqual([expect.stringMatching(/^SystemSculpt\/Extractions\/report\/images-report\//)]);
    expect(app.vault.create).toHaveBeenCalledWith(
      receipt.extractionPath,
      expect.stringContaining("1 image was extracted from this document and saved in the 'images-report' folder."),
    );
  });

  it("shows a recovery notice for the selected file even when progress notices are off", async () => {
    const { app, dependencies, managed, plugin } = harness();
    const convert = managed.processAndCommit.getMockImplementation()!;
    managed.processAndCommit.mockImplementationOnce(async (source: any, context: any, commit: (value: any) => Promise<unknown>) => {
      context.onNotice?.("A new conversion was started.");
      return convert(source, context, commit);
    });
    const service = new DocumentProcessingService(app, plugin, dependencies);

    await service.processDocument(file(), { showNotices: false });

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith("report.pdf: A new conversion was started.", expect.any(Number));
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

  it("reuses identical image and Markdown effects after cancellation on the same service", async () => {
    const { app, dependencies, managed, plugin, staging } = harness({ images: true });
    const service = new DocumentProcessingService(app, plugin, dependencies);
    const controller = new AbortController();
    const images = new Map<string, ArrayBuffer>();
    const notes = new Map<string, string>();
    (app.vault.adapter.exists as jest.Mock).mockImplementation(async (path: string) => images.has(path) || notes.has(path));
    (app.vault.adapter.readBinary as jest.Mock).mockImplementation(async (path: string) => images.get(path));
    (app.vault.adapter.read as jest.Mock).mockImplementation(async (path: string) => notes.get(path));
    (app.vault.createBinary as jest.Mock).mockImplementation(async (path: string, bytes: ArrayBuffer) => {
      images.set(path, bytes);
      return file(path);
    });
    (app.vault.create as jest.Mock).mockImplementation(async (path: string, text: string) => {
      notes.set(path, text);
      return file(path);
    });

    await expect(service.processDocumentWithReceipt(file(), {
      signal: controller.signal,
      showNotices: false,
      commitContextEffect: async () => { controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(managed.completeLocalCommit).not.toHaveBeenCalled();
    const originalNotes = [...notes.entries()];

    const receipt = await service.processDocumentWithReceipt(file(), { showNotices: false });
    expect(receipt.imagePaths).toHaveLength(1);
    expect(managed.completeLocalCommit).toHaveBeenCalledTimes(1);
    expect(app.vault.createBinary).toHaveBeenCalledTimes(1);
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    expect([...notes.entries()]).toEqual(originalNotes);
    const firstMarkdown = staging.stage.mock.calls[0][1].at(-1)!.bytes;
    const retriedMarkdown = staging.stage.mock.calls[1][1].at(-1)!.bytes;
    expect(new Uint8Array(retriedMarkdown)).toEqual(new Uint8Array(firstMarkdown));
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
