export type DocumentProcessingStage =
  | "queued"
  | "validating"
  | "uploading"
  | "processing"
  | "downloading"
  | "contextualizing"
  | "ready"
  | "error";

export type DocumentProcessingFlow = "document" | "audio" | "generic";

export interface DocumentProcessingProgressEvent {
  progress: number;
  stage: DocumentProcessingStage;
  label: string;
  icon: string;
  details?: string;
  flow?: DocumentProcessingFlow;
  documentId?: string;
  status?: string;
  error?: string;
  cached?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DocumentProcessingLogEntry
  extends DocumentProcessingProgressEvent {
  filePath?: string;
  fileName?: string;
  attempt?: number;
  durationMs?: number;
  source?: string;
  [key: string]: unknown;
}
