import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { ManagedLocalCommitReceipt } from "./managed/ManagedTypes";
import {
  TranscriptionCoordinator,
  type TranscriptionCommitResult,
  type TranscriptionContext,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./transcription/TranscriptionCoordinator";

export type { TranscriptionContext } from "./transcription/TranscriptionCoordinator";

export interface TranscriptionTask {
  readonly operationId: string;
  readonly promise: Promise<TranscriptionResult>;
  cancel(): void;
}

/**
 * Plugin-owned registry for active transcription work. Each task receives its
 * own coordinator, so unrelated recorder, context, and workflow jobs never
 * cancel one another.
 */
export class TranscriptionService {
  private static instance: TranscriptionService | null = null;
  private readonly active = new Set<TranscriptionCoordinator>();

  private constructor(private readonly plugin: SystemSculptPlugin) {}

  static getInstance(plugin: SystemSculptPlugin): TranscriptionService {
    if (this.instance && this.instance.plugin !== plugin) {
      this.instance.unload();
    }
    this.instance ??= new TranscriptionService(plugin);
    return this.instance;
  }

  static clearInstance(): void {
    this.instance?.unload();
    this.instance = null;
  }

  start(request: TranscriptionRequest): TranscriptionTask {
    const coordinator = this.createCoordinator();
    const promise = coordinator.start(request).finally(() => {
      this.active.delete(coordinator);
    });
    const operationId = coordinator.getActiveOperationId();
    if (!operationId) throw new Error("Transcription task did not establish an operation identity.");
    return {
      operationId,
      promise,
      cancel: () => coordinator.abort(),
    };
  }

  async transcribeFile<T>(
    file: TFile,
    context: TranscriptionContext & {
      recoverLocalCommit?: (
        receipt: ManagedLocalCommitReceipt,
        operationId: string,
      ) => Promise<T>;
    },
    commit: (
      text: string,
      operationId: string,
    ) => Promise<TranscriptionCommitResult<T>>,
  ): Promise<T> {
    const coordinator = this.createCoordinator();
    try {
      return await coordinator.transcribeFile(file, context, commit);
    } finally {
      this.active.delete(coordinator);
    }
  }

  async acknowledgeCompleted(operationId: string): Promise<void> {
    const coordinator = this.createCoordinator();
    try {
      await coordinator.acknowledgeCompleted(operationId);
    } finally {
      this.active.delete(coordinator);
    }
  }

  abort(): void {
    for (const coordinator of this.active) coordinator.abort();
  }

  unload(): void {
    this.abort();
    this.active.clear();
    if (TranscriptionService.instance === this) {
      TranscriptionService.instance = null;
    }
  }

  private createCoordinator(): TranscriptionCoordinator {
    const coordinator = new TranscriptionCoordinator(this.plugin.app, this.plugin);
    this.active.add(coordinator);
    return coordinator;
  }
}
