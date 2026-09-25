import { App, TFile } from "obsidian";
import { errorLogger } from "../../../utils/errorLogger";
import {
  ManagedEmbeddingsError,
  type ManagedEmbeddingsIndexAdapter,
  type ManagedEmbeddingsIndexGeneration,
  type ManagedEmbeddingsIndexResult,
} from "../gateway/ManagedEmbeddingsIndexAdapter";
import {
  createLocalEmptyEmbeddingMarkerForRevision,
  isLocalEmptyEmbeddingMarker,
  LOCAL_EMPTY_EMBEDDING_NAMESPACE,
  localEmptyEmbeddingMarkerId,
} from "../LocalEmptyEmbeddingMarker";
import type {
  EmbeddingVector,
  FailedProcessingDetail,
  ProcessingProgress,
  ProcessingResult,
} from "../types";
import type { EmbeddingsStorage } from "../storage/EmbeddingsStorage";
import { buildVectorId } from "../utils/vectorId";
import { parseManagedNamespace } from "../utils/namespace";
import { sha256HexFromArrayBuffer } from "../../../utils/sha256";

/** Stable source identity captured before remote inference begins. */
export interface EmbeddingSourceRevision {
  path: string;
  basename: string;
  mtime: number;
}

export interface EmbeddingsProcessingOptions {
  sourceRevisions?: ReadonlyMap<TFile, EmbeddingSourceRevision>;
  preflight?: () => Promise<void>;
  /**
   * Generation whose stored roots may be reused when a note's bytes are
   * unchanged. Null or absent always asks the server.
   */
  reuseNamespace?: string | null;
  /** Notes indexed at once. Bulk runs use a small bound; edits use one. */
  concurrency?: number;
}

/** Bulk runs overlap a few requests instead of one round trip per note. */
export const BULK_INDEX_CONCURRENCY = 3;
const MAX_INDEX_CONCURRENCY = 4;

type IndexGateway = Pick<ManagedEmbeddingsIndexAdapter, "index">;
type AtomicStorage = Pick<EmbeddingsStorage, "publishPath" | "replacePath"> & Partial<Pick<
  EmbeddingsStorage,
  "getVectorSync" | "touchPath"
>>;

const FATAL_MANAGED_ERROR_CODES = new Set([
  "payment_required",
  "license_required",
  "license_rejected",
  "version_unsupported",
  "capability_unavailable",
]);

class StaleEmbeddingSourceError extends Error {
  constructor() {
    super("The note changed while its semantic index was being generated.");
    this.name = "StaleEmbeddingSourceError";
  }
}

export class EmbeddingsProcessor {
  private cancelled = false;
  private operationController = new AbortController();

  constructor(
    private readonly gateway: IndexGateway,
    private readonly storage: AtomicStorage,
  ) {}

  async processFiles(
    files: TFile[],
    app: App,
    onProgress?: (progress: ProcessingProgress) => void,
    options: EmbeddingsProcessingOptions = {},
  ): Promise<ProcessingResult> {
    this.cancelled = false;
    this.operationController = new AbortController();
    const completedPaths: string[] = [];
    const reusedPaths: string[] = [];
    const failedPaths: string[] = [];
    const failedDetails: Record<string, FailedProcessingDetail> = {};
    let generation: ManagedEmbeddingsIndexGeneration | undefined;
    let fatalError: ManagedEmbeddingsError | null = null;
    let next = 0;

    const processOne = async (file: TFile): Promise<void> => {
      const revision = options.sourceRevisions?.get(file) ?? this.captureSourceRevision(file);
      onProgress?.({
        current: completedPaths.length,
        total: files.length,
        currentFile: revision.path,
      });

      try {
        const markdown = await app.vault.read(file);
        if (this.cancelled || fatalError) return;
        const sourceSha256 = await sha256HexFromArrayBuffer(new TextEncoder().encode(markdown).buffer);
        if (this.cancelled || fatalError) return;
        if (await this.reuseUnchangedSource(file, revision, sourceSha256, options.reuseNamespace)) {
          completedPaths.push(revision.path);
          reusedPaths.push(revision.path);
        } else {
          const indexed = await this.gateway.index({
            prepare: () => ({ markdown }),
            signal: this.operationController.signal,
          });
          if (this.cancelled) return;
          this.assertSourceCurrent(file, revision);
          await this.publishResult(revision, markdown, indexed);
          if (indexed.generation) generation = indexed.generation;
          completedPaths.push(revision.path);
        }
        onProgress?.({
          current: completedPaths.length,
          total: files.length,
          currentFile: revision.path,
        });
      } catch (error) {
        const managed = error instanceof ManagedEmbeddingsError ? error : null;
        if (
          this.cancelled
          || managed?.code === "request_cancelled"
          || (error instanceof DOMException && error.name === "AbortError")
        ) {
          this.cancelled = true;
          return;
        }
        if (fatalError) return;
        recordFailure(revision.path, error);
      }
    };

    const recordFailure = (path: string, error: unknown): void => {
      const managed = error instanceof ManagedEmbeddingsError ? error : null;
      const detail = this.failureDetail(error, managed);
      failedPaths.push(path);
      failedDetails[path] = detail;
      errorLogger.warn("Failed to index note with managed embeddings", {
        source: "EmbeddingsProcessor",
        method: "processFiles",
        metadata: {
          path,
          code: detail.code,
          status: detail.status ?? 0,
          ...(detail.requestId ? { requestId: detail.requestId } : {}),
        },
      });
      if (managed && FATAL_MANAGED_ERROR_CODES.has(managed.code)) fatalError = managed;
    };

    // One credits check per run, before any note is read or uploaded.
    if (files.length > 0 && options.preflight) {
      try {
        await options.preflight();
      } catch (error) {
        const managed = error instanceof ManagedEmbeddingsError ? error : null;
        if (managed?.code === "request_cancelled") {
          this.cancelled = true;
        } else {
          const first = options.sourceRevisions?.get(files[0]) ?? this.captureSourceRevision(files[0]);
          recordFailure(first.path, error);
          next = 1;
        }
      }
    }

    const worker = async (): Promise<void> => {
      while (!this.cancelled && !fatalError && next < files.length) {
        await processOne(files[next++]);
      }
    };
    const concurrency = Math.max(1, Math.min(
      MAX_INDEX_CONCURRENCY,
      Math.floor(options.concurrency ?? 1),
      files.length,
    ));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      completed: completedPaths.length,
      completedPaths,
      ...(reusedPaths.length > 0 ? { reusedPaths } : {}),
      failed: failedPaths.length,
      failedPaths,
      cancelled: this.cancelled,
      fatalError,
      ...(generation ? { generation } : {}),
      ...(failedPaths.length > 0 ? { failedDetails } : {}),
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.operationController.abort();
  }

  cleanup(): void {
    this.cancel();
  }

  /**
   * The same bytes under the same generation always produce the same vectors,
   * so an unchanged note only needs its stored revision stamped current.
   */
  private async reuseUnchangedSource(
    file: TFile,
    revision: EmbeddingSourceRevision,
    sourceSha256: string,
    namespace: string | null | undefined,
  ): Promise<boolean> {
    if (typeof this.storage.getVectorSync !== "function" || typeof this.storage.touchPath !== "function") {
      return false;
    }
    const marker = this.storage.getVectorSync(localEmptyEmbeddingMarkerId(revision.path));
    const identity = parseManagedNamespace(namespace);
    const root = namespace && identity
      ? this.storage.getVectorSync(buildVectorId(namespace, revision.path, 0))
      : null;
    let reusable: string | null = null;
    if (isLocalEmptyEmbeddingMarker(marker) && marker?.metadata.sourceSha256 === sourceSha256) {
      reusable = LOCAL_EMPTY_EMBEDDING_NAMESPACE;
    } else if (
      namespace
      && root
      && root.metadata.namespace === namespace
      && root.metadata.generation === identity?.generationId
      && root.metadata.complete === true
      && root.metadata.partial !== true
      && root.metadata.sourceSha256 === sourceSha256
    ) {
      reusable = namespace;
    }
    if (!reusable) return false;
    this.assertSourceCurrent(file, revision);
    return this.storage.touchPath(revision.path, reusable, {
      mtime: revision.mtime,
      title: revision.basename,
    });
  }

  private async publishResult(
    revision: EmbeddingSourceRevision,
    markdown: string,
    indexed: ManagedEmbeddingsIndexResult,
  ): Promise<void> {
    if (indexed.empty) {
      await this.storage.replacePath(revision.path, [
        createLocalEmptyEmbeddingMarkerForRevision(revision, markdown, indexed.source.contentSha256),
      ]);
      return;
    }
    const generation = indexed.generation;
    if (!generation) {
      throw new ManagedEmbeddingsError(
        "invalid_response",
        "Managed embedding index generation is missing.",
        200,
      );
    }
    const createdAt = Date.now();
    const vectors = indexed.chunks.map((chunk): EmbeddingVector => ({
      id: buildVectorId(generation.indexNamespace, revision.path, chunk.ordinal),
      path: revision.path,
      chunkId: chunk.ordinal,
      vector: new Float32Array(chunk.vector),
      metadata: {
        title: revision.basename,
        excerpt: chunk.excerpt,
        mtime: revision.mtime,
        contentHash: chunk.textHash,
        generation: generation.id,
        dimension: generation.dimensions,
        createdAt,
        namespace: generation.indexNamespace,
        ...(chunk.headingPath.length > 0
          ? {
              sectionTitle: chunk.headingPath.join(" › "),
              headingPath: [...chunk.headingPath],
            }
          : {}),
        chunkLength: chunk.length,
        ...(chunk.ordinal === 0
          ? {
              complete: true,
              partial: false,
              failedChunkCount: 0,
              chunkCount: indexed.chunks.length,
              sourceSha256: indexed.source.contentSha256,
            }
          : {}),
      },
    }));
    await this.storage.publishPath(revision.path, generation.indexNamespace, vectors);
  }

  /**
   * The note is read once. A later write changes its stat and re-queues a
   * newer work revision, so a second full read here would only repeat that.
   */
  private assertSourceCurrent(file: TFile, revision: EmbeddingSourceRevision): void {
    if (
      file.path !== revision.path
      || file.basename !== revision.basename
      || file.stat.mtime !== revision.mtime
    ) {
      throw new StaleEmbeddingSourceError();
    }
  }

  private failureDetail(
    error: unknown,
    managed: ManagedEmbeddingsError | null,
  ): FailedProcessingDetail {
    if (managed) {
      return {
        code: managed.code,
        message: managed.message,
        status: managed.status,
        requestId: managed.requestId ?? undefined,
      };
    }
    if (error instanceof StaleEmbeddingSourceError) {
      return {
        code: "source_changed",
        message: error.message,
        status: 0,
      };
    }
    return {
      code: "local_preparation_failed",
      message: "A note could not be prepared for managed embeddings.",
      status: 0,
    };
  }

  private captureSourceRevision(file: TFile): EmbeddingSourceRevision {
    return {
      path: file.path,
      basename: file.basename,
      mtime: typeof file.stat?.mtime === "number" ? file.stat.mtime : Date.now(),
    };
  }
}
