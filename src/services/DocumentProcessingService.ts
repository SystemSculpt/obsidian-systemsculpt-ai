import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { getManagedDocumentMimeType, normalizeFileExtension } from "../constants/fileTypes";
import type {
  DocumentProcessingFlow,
  DocumentProcessingLogEntry,
  DocumentProcessingProgressEvent,
  DocumentProcessingStage,
} from "../types/documentProcessing";
import { sha256HexFromBytesPortable } from "../studio/hash";
import { errorLogger } from "../utils/errorLogger";
import { ManagedJobClient } from "./managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "./managed/ManagedJobRecoveryStore";
import {
  ManagedDocumentProcessingAdapter,
  type ManagedDocumentDownloadResult,
  type ManagedDocumentProcessingResult,
} from "./managed/ManagedDocumentProcessingAdapter";
import {
  ManagedDocumentLocalStaging,
  type ManagedDocumentStagedArtifact,
} from "./managed/ManagedDocumentLocalStaging";
import { ObsidianManagedRecoveryAdapter } from "./managed/adapters/ObsidianManagedRecoveryAdapter";

const STAGE_ICONS: Record<DocumentProcessingStage, string> = {
  queued: "inbox",
  validating: "shield-check",
  uploading: "upload",
  processing: "cpu",
  downloading: "download",
  contextualizing: "sparkles",
  ready: "check-circle",
  error: "x-circle",
};

type ProgressMeta = Partial<
  Pick<DocumentProcessingLogEntry, "filePath" | "fileName" | "durationMs" | "attempt" | "source">
> & { documentId?: string; metadata?: Record<string, unknown> };

interface ImageMetadata {
  originalName: string;
  newName: string;
  path: string;
  size: number;
  documentName: string;
  timestamp: number;
}

export interface DocumentProcessingReceipt {
  extractionPath: string;
  imagePaths: string[];
  operationId: string;
  outputIdentity: string;
  markdownSha256: string;
  contextEffectId: string;
}

export interface DocumentProcessingOptions {
  onProgress?: (event: DocumentProcessingProgressEvent) => void;
  showNotices?: boolean;
  flow?: DocumentProcessingFlow;
  signal?: AbortSignal;
}

export interface DocumentProcessingReceiptOptions extends DocumentProcessingOptions {
  commitContextEffect?: (receipt: DocumentProcessingReceipt, signal: AbortSignal) => Promise<void>;
}

type ManagedDocumentAdapterPort = Pick<ManagedDocumentProcessingAdapter,
  "process" | "resume" | "beginLocalCommit" | "completeLocalCommit"
>;
type ManagedDocumentStagingPort = Pick<ManagedDocumentLocalStaging, "stage" | "readVerified" | "cleanup">;

export interface DocumentProcessingDependencies {
  managed?: ManagedDocumentAdapterPort;
  staging?: ManagedDocumentStagingPort;
}

interface PreparedImageEffect {
  originalName: string;
  newName: string;
  path: string;
  bytes: ArrayBuffer;
}

interface PreparedLocalEffects {
  extractionPath: string;
  markdownBytes: ArrayBuffer;
  images: PreparedImageEffect[];
  artifacts: Array<{ kind: "image" | "markdown"; bytes: ArrayBuffer }>;
}

interface NormalizedManagedDocumentResult {
  content: string;
  text: string;
  markdown: string;
  metadata: Readonly<Record<string, unknown>>;
  images: ManagedDocumentDownloadResult["images"] | Record<string, string>;
}

export class ManagedDocumentLocalEffectError extends Error {
  readonly code = "local_output_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "ManagedDocumentLocalEffectError";
  }
}

export class DocumentProcessingService {
  private static instance: DocumentProcessingService;
  private readonly imageMetadataLog: ImageMetadata[] = [];
  private managedAdapter: ManagedDocumentAdapterPort | null;
  private localStaging: ManagedDocumentStagingPort | null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    dependencies: DocumentProcessingDependencies = {},
  ) {
    this.managedAdapter = dependencies.managed ?? null;
    this.localStaging = dependencies.staging ?? null;
  }

  public static getInstance(app: App, plugin: SystemSculptPlugin): DocumentProcessingService {
    if (!DocumentProcessingService.instance) DocumentProcessingService.instance = new DocumentProcessingService(app, plugin);
    return DocumentProcessingService.instance;
  }

  public async processDocument(file: TFile, options: DocumentProcessingOptions = {}): Promise<string> {
    return (await this.processDocumentWithReceipt(file, options)).extractionPath;
  }

  public async processDocumentWithReceipt(
    file: TFile,
    options: DocumentProcessingReceiptOptions = {},
  ): Promise<DocumentProcessingReceipt> {
    const signal = options.signal ?? new AbortController().signal;
    const flow = options.flow ?? "document";
    const showNotices = options.showNotices ?? true;
    const startedAt = Date.now();
    const meta: ProgressMeta = { filePath: file.path, fileName: file.name };
    throwIfAborted(signal);
    this.emitProgress(options.onProgress, {
      stage: "validating",
      progress: 5,
      label: "Checking document access…",
      icon: STAGE_ICONS.validating,
      metadata: { startedAt },
    }, meta, flow);

    try {
      const identity = `vault:${file.path}`;
      const remote = await this.adapter().process({
        identity,
        fingerprint: () => `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(identity))}`,
        load: async () => {
          throwIfAborted(signal);
          const contentType = getManagedDocumentMimeType(normalizeFileExtension(file.extension));
          if (!contentType) {
            throw new Error(`Managed document processing does not support .${file.extension || "unknown"} files.`);
          }
          const bytes = await this.app.vault.readBinary(file);
          throwIfAborted(signal);
          return { filename: file.name, contentType, bytes };
        },
      }, {
        signal,
        onProgress: (progress, status) => {
          if (signal.aborted) return;
          const stage: DocumentProcessingStage = progress < 70 ? "uploading" : "processing";
          this.emitProgress(options.onProgress, {
            stage,
            progress,
            label: status,
            icon: STAGE_ICONS[stage],
          }, meta, flow);
        },
      });
      throwIfAborted(signal);
      meta.documentId = remote.documentId;
      this.emitProgress(options.onProgress, {
        stage: "downloading",
        progress: 96,
        label: "Verifying converted document…",
        icon: STAGE_ICONS.downloading,
        documentId: remote.documentId,
      }, meta, flow);

      const receipt = await this.commitLocalEffects(file, remote, options, signal);
      throwIfAborted(signal);
      meta.durationMs = Date.now() - startedAt;
      this.emitProgress(options.onProgress, {
        stage: "ready",
        progress: 100,
        label: "Document ready",
        icon: STAGE_ICONS.ready,
        documentId: remote.documentId,
      }, meta, flow);
      if (showNotices) new Notice("Document successfully converted to Markdown");
      return receipt;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.emitProgress(options.onProgress, {
        stage: "error",
        progress: 0,
        label: `Error: ${message}`,
        icon: STAGE_ICONS.error,
        error: message,
      }, meta, flow);
      if (showNotices) new Notice(`Failed to process document: ${message}`);
      throw error;
    }
  }

  private adapter(): ManagedDocumentAdapterPort {
    if (this.managedAdapter) return this.managedAdapter;
    const graph = this.plugin.getManagedCapabilityGraph();
    this.managedAdapter = new ManagedDocumentProcessingAdapter({
      admission: graph.admission,
      jobs: new ManagedJobClient(graph.transport).documents,
      recovery: new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(this.app)),
    });
    return this.managedAdapter;
  }

  private staging(): ManagedDocumentStagingPort {
    if (!this.localStaging) this.localStaging = new ManagedDocumentLocalStaging(this.plugin);
    return this.localStaging;
  }

  private async commitLocalEffects(
    file: TFile,
    remote: ManagedDocumentProcessingResult,
    options: DocumentProcessingReceiptOptions,
    signal: AbortSignal,
  ): Promise<DocumentProcessingReceipt> {
    await this.adapter().beginLocalCommit(remote.operationId, signal);
    throwIfAborted(signal);
    const prepared = this.prepareLocalEffects(file, remote.result);
    throwIfAborted(signal);
    const metadata = await this.staging().stage(remote.operationId, prepared.artifacts, signal);
    throwIfAborted(signal);
    const verified = await this.staging().readVerified(remote.operationId, metadata, signal);
    throwIfAborted(signal);
    if (verified.length !== prepared.artifacts.length || metadata.length !== prepared.artifacts.length) {
      throw new Error("Managed document staging returned an incomplete artifact set.");
    }

    for (let index = 0; index < prepared.images.length; index += 1) {
      const image = prepared.images[index];
      const staged = metadata[index];
      if (staged.kind !== "image") throw new Error("Managed document staging image order changed.");
      await this.commitBinaryEffect(image.path, verified[index], staged, signal);
      this.recordImageMetadata({
        originalName: image.originalName,
        newName: image.newName,
        path: image.path,
        size: staged.byteLength,
        documentName: file.basename,
        timestamp: Date.now(),
      });
    }

    const markdownIndex = metadata.length - 1;
    const markdownMetadata = metadata[markdownIndex];
    if (markdownMetadata.kind !== "markdown") throw new Error("Managed document staging Markdown order changed.");
    await this.commitMarkdownEffect(prepared.extractionPath, verified[markdownIndex], markdownMetadata, signal);
    throwIfAborted(signal);

    const outputIdentity = `vault:${prepared.extractionPath}`;
    const contextEffectId = sha256HexFromBytesPortable(new TextEncoder().encode(
      `managed-document-context-effect-v1\0${remote.operationId}\0${outputIdentity}\0${markdownMetadata.sha256}`,
    ));
    const receipt: DocumentProcessingReceipt = {
      extractionPath: prepared.extractionPath,
      imagePaths: prepared.images.map((image) => image.path),
      operationId: remote.operationId,
      outputIdentity,
      markdownSha256: markdownMetadata.sha256,
      contextEffectId,
    };
    await options.commitContextEffect?.(receipt, signal);
    throwIfAborted(signal);
    await this.adapter().completeLocalCommit(remote.operationId, signal);
    throwIfAborted(signal);
    try {
      await this.staging().cleanup(remote.operationId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      errorLogger.error("Managed document staging cleanup is pending", error, {
        source: "DocumentProcessingService",
        method: "commitLocalEffects",
        metadata: { operationId: remote.operationId },
      });
    }
    return receipt;
  }

  private prepareLocalEffects(file: TFile, result: ManagedDocumentDownloadResult): PreparedLocalEffects {
    const extractionFolder = this.plugin.settings.extractionsDirectory?.trim() ?? "";
    const baseName = this.sanitizeFilename(file.basename);
    const parentPath = extractionFolder ? `${extractionFolder}/${baseName}` : `${file.parent?.path || ""}/${baseName}`;
    const imagesPath = `${parentPath}/images-${this.sanitizeFilename(baseName).substring(0, 20)}`;
    const rawImages = this.extractImagesFromData(result);
    const preparedImages: PreparedImageEffect[] = [];
    const imagePathMap = new Map<string, string>();
    const contentPaths = new Map<string, { path: string; relativePath: string }>();

    for (const [imageName, imageBase64] of Object.entries(rawImages)) {
      const bytes = this.base64ToArrayBuffer(imageBase64);
      const contentHash = sha256HexFromBytesPortable(new Uint8Array(bytes));
      const existing = contentPaths.get(contentHash);
      if (existing) {
        imagePathMap.set(imageName, existing.relativePath);
        continue;
      }
      const newName = this.generateUniqueImageName(baseName, imageName, imageBase64);
      const path = this.normalizePath(`${imagesPath}/${newName}`);
      const relativePath = `${imagesPath.split("/").pop() || "images"}/${newName}`;
      contentPaths.set(contentHash, { path, relativePath });
      imagePathMap.set(imageName, relativePath);
      preparedImages.push({ originalName: imageName, newName, path, bytes });
    }

    const processed = this.normalizeManagedResult(result);
    if (imagePathMap.size) {
      processed.images = rawImages;
      let content = String(processed.content ?? processed.markdown ?? processed.text ?? "");
      imagePathMap.forEach((newPath, originalName) => {
        const escaped = originalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        content = content
          .replace(new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}\\)`, "g"), `![$1](${newPath})`)
          .replace(new RegExp(`<img([^>]*)src=["']${escaped}["']([^>]*)>`, "g"), `<img$1src="${newPath}"$2>`);
      });
      processed.content = content;
    }
    const markdown = this.formatExtractionContent(processed);
    const markdownBytes = new TextEncoder().encode(markdown).buffer;
    const extractionPath = this.normalizePath(`${parentPath}/${baseName}-extraction.md`);
    return {
      extractionPath,
      markdownBytes,
      images: preparedImages,
      artifacts: [
        ...preparedImages.map((image) => ({ kind: "image" as const, bytes: image.bytes })),
        { kind: "markdown" as const, bytes: markdownBytes },
      ],
    };
  }

  private normalizeManagedResult(result: ManagedDocumentDownloadResult): NormalizedManagedDocumentResult {
    const content = result.markdown.trim()
      ? result.markdown
      : result.text.trim()
      ? result.text
      : result.content.length
      ? JSON.stringify(result.content, null, 2)
      : "";
    return { content, text: result.text, markdown: result.markdown, metadata: result.metadata, images: result.images };
  }

  private async commitBinaryEffect(
    path: string,
    bytes: ArrayBuffer,
    metadata: ManagedDocumentStagedArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.ensureDirectory(path.slice(0, path.lastIndexOf("/")), signal);
    const exists = await this.app.vault.adapter.exists(path);
    throwIfAborted(signal);
    if (exists) {
      const current = await this.app.vault.adapter.readBinary(path);
      throwIfAborted(signal);
      const currentHash = sha256HexFromBytesPortable(new Uint8Array(current));
      if (current.byteLength !== metadata.byteLength || currentHash !== metadata.sha256) {
        throw new ManagedDocumentLocalEffectError(`Existing image conflicts with managed effect ${path}.`);
      }
      return;
    }
    await this.app.vault.createBinary(path, bytes);
    throwIfAborted(signal);
  }

  private async commitMarkdownEffect(
    path: string,
    bytes: ArrayBuffer,
    metadata: ManagedDocumentStagedArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.ensureDirectory(path.slice(0, path.lastIndexOf("/")), signal);
    const exists = await this.app.vault.adapter.exists(path);
    throwIfAborted(signal);
    if (exists) {
      const current = await this.app.vault.adapter.read(path);
      throwIfAborted(signal);
      const currentBytes = new TextEncoder().encode(current);
      const currentHash = sha256HexFromBytesPortable(currentBytes);
      if (currentBytes.byteLength !== metadata.byteLength || currentHash !== metadata.sha256) {
        throw new ManagedDocumentLocalEffectError(`Existing Markdown conflicts with managed effect ${path}.`);
      }
      return;
    }
    await this.app.vault.create(path, new TextDecoder().decode(bytes));
    throwIfAborted(signal);
  }

  private async ensureDirectory(path: string, signal: AbortSignal): Promise<void> {
    if (!path) return;
    throwIfAborted(signal);
    if (this.plugin.directoryManager) await this.plugin.directoryManager.ensureDirectoryByPath(path);
    else await this.plugin.createDirectory(path);
    throwIfAborted(signal);
  }

  private emitProgress(
    handler: ((event: DocumentProcessingProgressEvent) => void) | undefined,
    event: DocumentProcessingProgressEvent,
    meta: ProgressMeta = {},
    fallbackFlow: DocumentProcessingFlow = "document",
  ): void {
    const normalizedEvent: DocumentProcessingProgressEvent = {
      ...event,
      progress: this.clampProgress(event.progress),
      flow: event.flow ?? fallbackFlow,
    };
    try {
      handler?.(normalizedEvent);
    } catch (error) {
      errorLogger.error("Progress handler threw", error, {
        source: "DocumentProcessingService",
        method: "emitProgress",
        metadata: { stage: normalizedEvent.stage, filePath: meta.filePath },
      });
    }
  }

  private clampProgress(value: number | undefined): number {
    if (typeof value !== "number" || Number.isNaN(value)) return 0;
    if (!Number.isFinite(value)) return value > 0 ? 100 : 0;
    return Math.min(100, Math.max(0, value));
  }

  private formatExtractionContent(data: any): string {
    const title = data?.title ?? data?.metadata?.title ?? data?.document?.title ?? "Document Extraction";
    let content = data?.content ?? data?.text ?? data?.document?.content ?? data?.document?.text ?? data?.markdown ?? data?.extraction ?? "";
    if (!content && data && typeof data === "object") content = JSON.stringify(data, null, 2);
    if (!content) content = "No content was extracted from this document. The server may be experiencing issues or the document format is not supported.";
    let imageNote = "";
    if (data?.images && Object.keys(data.images).length > 0) {
      const imageCount = Object.keys(data.images).length;
      let folderInfo = "the images folder";
      if (this.imageMetadataLog.length > 0) {
        const firstImage = this.imageMetadataLog[Math.max(0, this.imageMetadataLog.length - imageCount)];
        const parts = firstImage?.path?.split("/") ?? [];
        if (parts.length >= 2) folderInfo = `the '${parts[parts.length - 2]}' folder`;
      }
      imageNote = `\n\n> [!note] Images\n> ${imageCount} image${imageCount > 1 ? "s were" : " was"} extracted from this document and saved in ${folderInfo}.\n`;
    }
    return `# ${title}\n\n${String(content)}${imageNote}\n\n---\nExtracted with SystemSculpt\n`;
  }

  private extractImagesFromData(data: any): Record<string, string> {
    const images: Record<string, string> = {};
    const add = (name: unknown, value: unknown, index: number) => {
      if (typeof value === "string" && value) images[typeof name === "string" && name ? name : `image-${index}.png`] = value;
    };
    if (!data) return images;
    if (Array.isArray(data.images)) {
      data.images.forEach((image: any, index: number) => {
        if (typeof image === "string") add(undefined, image, index);
        else add(image?.name ?? image?.filename, image?.data ?? image?.base64 ?? image?.content, index);
      });
    } else if (data.images && typeof data.images === "object") {
      Object.entries(data.images).forEach(([name, value], index) => add(name, value, index));
    }
    if (data.document?.images && typeof data.document.images === "object") {
      Object.entries(data.document.images).forEach(([name, value], index) => add(name, value, index));
    }
    if (Array.isArray(data.imageList)) data.imageList.forEach((image: any, index: number) => add(image?.name, image?.data, index));
    if (Array.isArray(data.figures)) data.figures.forEach((image: any, index: number) => add(image?.name, image?.image, index));
    return images;
  }

  private generateUniqueImageName(baseName: string, imageName: string, imageData?: string): string {
    const extension = imageName.split(".").pop()?.toLowerCase() || "png";
    const sanitizedBaseName = this.sanitizeFilename(baseName);
    const contentHash = this.simpleHash(imageData?.substring(0, 1000) || `${baseName}-${imageName}`);
    const sanitizedImageName = this.sanitizeFilename(imageName.split(".")[0]);
    return `${sanitizedBaseName}-${sanitizedImageName}-${contentHash}.${extension}`;
  }

  private simpleHash(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    return (hash >>> 0).toString(16).substring(0, 8);
  }

  private base64ToArrayBuffer(value: string): ArrayBuffer {
    const base64 = value.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, "");
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  private recordImageMetadata(metadata: ImageMetadata): void {
    this.imageMetadataLog.push(metadata);
  }

  private sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9-_]/g, "-");
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
