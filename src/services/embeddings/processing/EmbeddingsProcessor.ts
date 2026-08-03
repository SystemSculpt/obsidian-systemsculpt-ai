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
} from "../LocalEmptyEmbeddingMarker";
import type {
  EmbeddingVector,
  FailedProcessingDetail,
  ProcessingProgress,
  ProcessingResult,
} from "../types";
import type { EmbeddingsStorage } from "../storage/EmbeddingsStorage";
import { buildVectorId } from "../utils/vectorId";

/** Stable source identity captured before remote inference begins. */
export interface EmbeddingSourceRevision {
  path: string;
  basename: string;
  mtime: number;
}

export interface EmbeddingsProcessingOptions {
  sourceRevisions?: ReadonlyMap<TFile, EmbeddingSourceRevision>;
}

type IndexGateway = Pick<ManagedEmbeddingsIndexAdapter, "index">;
type AtomicStorage = Pick<EmbeddingsStorage, "publishPath" | "replacePath">;

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
    const failedPaths: string[] = [];
    const failedDetails: Record<string, FailedProcessingDetail> = {};
    let generation: ManagedEmbeddingsIndexGeneration | undefined;

    for (const file of files) {
      if (this.cancelled) break;
      const revision = options.sourceRevisions?.get(file) ?? this.captureSourceRevision(file);
      onProgress?.({
        current: completedPaths.length,
        total: files.length,
        currentFile: revision.path,
      });

      try {
        const markdown = await app.vault.read(file);
        if (this.cancelled) break;
        const indexed = await this.gateway.index({
          prepare: () => ({ markdown }),
          signal: this.operationController.signal,
        });
        if (this.cancelled) break;
        await this.assertSourceCurrent(app, file, revision, markdown);
        if (this.cancelled) break;

        await this.publishResult(revision, markdown, indexed);
        if (indexed.generation) generation = indexed.generation;
        completedPaths.push(revision.path);
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
          break;
        }

        const detail = this.failureDetail(error, managed);
        failedPaths.push(revision.path);
        failedDetails[revision.path] = detail;
        errorLogger.warn("Failed to index note with managed embeddings", {
          source: "EmbeddingsProcessor",
          method: "processFiles",
          metadata: {
            path: revision.path,
            code: detail.code,
            status: detail.status ?? 0,
          },
        });
      }
    }

    return {
      completed: completedPaths.length,
      completedPaths,
      failed: failedPaths.length,
      failedPaths,
      cancelled: this.cancelled,
      fatalError: null,
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

  private async publishResult(
    revision: EmbeddingSourceRevision,
    markdown: string,
    indexed: ManagedEmbeddingsIndexResult,
  ): Promise<void> {
    if (indexed.empty) {
      await this.storage.replacePath(revision.path, [
        createLocalEmptyEmbeddingMarkerForRevision(revision, markdown),
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
            }
          : {}),
      },
    }));
    await this.storage.publishPath(revision.path, generation.indexNamespace, vectors);
  }

  private async assertSourceCurrent(
    app: App,
    file: TFile,
    revision: EmbeddingSourceRevision,
    indexedMarkdown: string,
  ): Promise<void> {
    if (
      file.path !== revision.path
      || file.basename !== revision.basename
      || file.stat.mtime !== revision.mtime
    ) {
      throw new StaleEmbeddingSourceError();
    }
    const current = await app.vault.read(file);
    if (current !== indexedMarkdown) throw new StaleEmbeddingSourceError();
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
