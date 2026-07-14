import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  TranscriptionCoordinator,
  type TranscriptionContext,
} from "./transcription/TranscriptionCoordinator";

export type { TranscriptionContext } from "./transcription/TranscriptionCoordinator";

/**
 * Compatibility facade for callers that only need raw transcript text.
 * Remote work is owned exclusively by TranscriptionCoordinator and its
 * ManagedTranscriptionAdapter.
 */
export class TranscriptionService {
  private static instance: TranscriptionService | null = null;
  private readonly coordinator: TranscriptionCoordinator;

  private constructor(plugin: SystemSculptPlugin) {
    this.coordinator = new TranscriptionCoordinator(plugin.app, plugin);
  }

  static getInstance(plugin: SystemSculptPlugin): TranscriptionService {
    if (!this.instance) this.instance = new TranscriptionService(plugin);
    return this.instance;
  }

  static clearInstance(): void {
    this.instance?.abort();
    this.instance = null;
  }

  transcribeFile(file: TFile, context: TranscriptionContext): Promise<string> {
    return this.coordinator.transcribeFile(file, context);
  }

  abort(): void {
    this.coordinator.abort();
  }

  unload(): void {
    this.abort();
  }
}
