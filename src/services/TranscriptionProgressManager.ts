import { TFile } from "obsidian";
import { TranscriptionContext } from "./TranscriptionService";

/**
 * Unified manager for transcription progress reporting
 * This class handles progress reporting for both the AudioTranscriptionModal
 * and the FileContextManager interfaces
 */
export class TranscriptionProgressManager {
  private static instance: TranscriptionProgressManager;

  // Map of active transcriptions by file path
  private activeTranscriptions: Map<string, {
    startTime: number;
    lastProgress: number;
    lastStatus: string;
    detailedInfo: string | null;
    cleanupTimeout: NodeJS.Timeout | null;
  }> = new Map();

  // Private constructor for singleton pattern
  private constructor() {}

  /**
   * Get the singleton instance of TranscriptionProgressManager
   */
  public static getInstance(): TranscriptionProgressManager {
    if (!TranscriptionProgressManager.instance) {
      TranscriptionProgressManager.instance = new TranscriptionProgressManager();
    }
    return TranscriptionProgressManager.instance;
  }

  /**
   * Create a progress handler for a file
   * @param file The file being transcribed
   * @param onProgress The progress callback function
   * @returns A TranscriptionContext with progress handling
   */
  public createProgressHandler(
    file: TFile,
    onProgress?: (progress: number, status: string, icon?: string, details?: string) => void
  ): TranscriptionContext {
    const filePath = file.path;

    // Initialize tracking for this file
    this.activeTranscriptions.set(filePath, {
      startTime: Date.now(),
      lastProgress: 0,
      lastStatus: "Transcribing audio...",
      detailedInfo: null,
      cleanupTimeout: null
    });

    return {
      type: "note",
      onProgress: (progress: number, status: string) => {
        // Update tracking info
        const transcription = this.activeTranscriptions.get(filePath);
        if (transcription) {
          transcription.lastProgress = progress;
          transcription.lastStatus = status;

          // Clear any existing cleanup timeout
          if (transcription.cleanupTimeout) {
            clearTimeout(transcription.cleanupTimeout);
            transcription.cleanupTimeout = null;
          }

          // Determine icon based on status and progress
          let icon = "loader-2";
          let details: string | null = null;

          if (progress === 0 && status.includes("Error")) {
            icon = "x-circle";
          } else if (progress === 100) {
            icon = "check-circle";
          } else if (status.includes("Uploading")) {
            icon = "upload";
          } else if (status.includes("Chunk") || status.includes("chunk")) {
            icon = "scissors";
          } else if (status.includes("Transcribing")) {
            icon = "file-audio";
          } else if (status.includes("Process")) {
            icon = "cpu";
          }

          // We no longer generate detailed info for any status
          // This simplifies the UI by removing the persistent processing message

          // Call the progress callback
          onProgress?.(progress, status, icon, details || transcription.detailedInfo || undefined);

          // Set cleanup timeout for completed transcriptions
          if (progress === 100 || status.includes("Error") || status.includes("Complete")) {
            // For completion or error states, immediately clear detailed info
            transcription.detailedInfo = null;

            // For completion, remove the transcription after a short delay
            if (progress === 100) {
              transcription.cleanupTimeout = setTimeout(() => {
                this.activeTranscriptions.delete(filePath);
              }, 2000);
            }
          }
        }
      }
    };
  }

  /**
   * Handle completion of a transcription
   * @param filePath The path of the transcribed file
   * @param resultPath The path of the result file
   * @param onComplete Optional callback for completion handling
   */
  public handleCompletion(
    filePath: string,
    resultPath: string,
    onComplete?: (resultPath: string) => void
  ): void {
    const transcription = this.activeTranscriptions.get(filePath);
    if (transcription) {
      // Clear any existing cleanup timeout
      if (transcription.cleanupTimeout) {
        clearTimeout(transcription.cleanupTimeout);
      }

      // Set a shorter timeout to remove the transcription after completion
      transcription.cleanupTimeout = setTimeout(() => {
        this.activeTranscriptions.delete(filePath);
      }, 2000);

      // Call the completion callback
      onComplete?.(resultPath);
    }
  }

  /**
   * Clear progress information for a file
   * @param filePath The path of the file to clear
   */
  public clearProgress(filePath: string): void {
    const transcription = this.activeTranscriptions.get(filePath);
    if (transcription && transcription.cleanupTimeout) {
      clearTimeout(transcription.cleanupTimeout);
    }
    this.activeTranscriptions.delete(filePath);
  }
}
