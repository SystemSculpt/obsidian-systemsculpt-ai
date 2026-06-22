/**
 * TranscriptionProvider - the contract every transcription backend implements,
 * the transcription twin of the embeddings `EmbeddingsProvider` interface.
 *
 * Today provider choice is two inline branches on
 * `settings.transcriptionProvider === "custom"` buried inside the 2k-line
 * `TranscriptionService`. This interface is the seam the #211 rework introduces:
 * the managed SystemSculpt backend and a self-hosted Whisper backend (PR-2) both
 * implement it, `TranscriptionService` becomes thin wiring, and the self-hosted
 * Whisper *contract* becomes a concrete `validateConfiguration()` instead of
 * undocumented tribal knowledge.
 *
 * Kept Node-free: the audio payload is described with web types
 * (Blob/ArrayBuffer/Uint8Array), never a Node Buffer or fs handle, so the whole
 * provider layer stays in the mobile bundle (bundle-load.no-node / .mobile).
 */

import type { TranscriptionResult } from "./transcriptionResponse";

export type { TranscriptionResult, TranscriptionSegment } from "./transcriptionResponse";

/** The audio to transcribe, as already-captured bytes plus naming metadata. */
export interface TranscriptionAudio {
  /** Raw audio bytes. A Blob on web; ArrayBuffer/Uint8Array when read directly. */
  data: Blob | ArrayBuffer | Uint8Array;
  /** File name with extension, e.g. "recording.m4a". */
  fileName: string;
  /** MIME type, e.g. "audio/mp4". */
  mimeType: string;
}

export interface TranscriptionRequest {
  audio: TranscriptionAudio;
  /** Optional language hint (ISO-639-1), when the user/endpoint supports it. */
  language?: string;
  /** Request timed segments (SRT/verbose output) rather than plain text. */
  timestamped?: boolean;
  /** Correlation id for progress/cancellation/server logs. */
  requestId?: string;
  /** Progress callback in [0,100] with an optional status message. */
  onProgress?: (percent: number, message?: string) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Result of `validateConfiguration()` — config-time compatibility check for a
 * provider (used to surface clear "your Whisper endpoint isn't compatible"
 * errors in settings before the user records anything). `ok` is true only when
 * `errors` is empty; `warnings` are non-fatal advisories.
 */
export interface TranscriptionConfigValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface TranscriptionProvider {
  /** Stable id, e.g. "systemsculpt" | "custom". */
  readonly id: string;
  /**
   * Validate the provider's current configuration without performing I/O
   * (URL/protocol/model presence checks). Cheap enough to call on settings
   * change.
   */
  validateConfiguration(): TranscriptionConfigValidation;
  /** Transcribe one audio payload, returning the normalized result. */
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Convenience constructor for a passing/with-warnings/failing validation. */
export function buildValidation(
  errors: string[] = [],
  warnings: string[] = [],
): TranscriptionConfigValidation {
  return { ok: errors.length === 0, errors, warnings };
}
