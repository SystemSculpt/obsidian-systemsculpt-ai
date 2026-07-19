import type { PendingAudioProcessorUploadSource } from "../../types";

export const AUDIO_PROCESSOR_OUTPUT_DIRECTORY = "SystemSculpt/Audio Notes" as const;
export const AUDIO_PROCESSOR_MAX_AUDIO_BYTES = 1_000_000_000;

export type AudioProcessorResumableAudioSource = PendingAudioProcessorUploadSource;

export type AudioProcessorStatus =
  | "uploading"
  | "queued"
  | "awaiting_funds"
  | "processing"
  | "succeeded"
  | "failed"
  | "expired";

export type AudioProcessorStage =
  | "uploading"
  | "queued"
  | "awaiting_funds"
  | "transcribing"
  | "summarizing"
  | "rendering"
  | "complete";

export const AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION = "audio_processor_artifacts.v1" as const;

export interface AudioProcessorArtifactDescriptor {
  url: string;
  filename: string;
  sha256: string;
}

export interface AudioProcessorArtifactManifest {
  version: typeof AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION;
  note: AudioProcessorArtifactDescriptor;
  summary: AudioProcessorArtifactDescriptor;
  transcript: AudioProcessorArtifactDescriptor;
}

export interface AudioProcessorResult {
  artifactJobId: string;
  noteUrl: string;
  summaryUrl: string;
  transcriptUrl: string;
  urlExpiresInSeconds: number;
  filename: string;
  artifactManifest: AudioProcessorArtifactManifest | null;
}

export interface AudioProcessorTranscriptArtifact {
  artifactJobId: string;
  transcriptUrl: string;
  urlExpiresInSeconds: number;
  filename: string;
  sha256: string;
}

export interface AudioProcessorJob {
  id: string;
  status: AudioProcessorStatus;
  stage: AudioProcessorStage;
  progress: number;
  updatedAt: string;
  error: string | null;
  quotedCredits: number | null;
  chargedCredits: number;
  resumeRequired: boolean;
  result: AudioProcessorResult | null;
  transcriptArtifact: AudioProcessorTranscriptArtifact | null;
}

export interface AudioProcessorUpload {
  partSizeBytes: number;
  totalParts: number;
}

export interface AudioProcessorCreatedJob {
  job: AudioProcessorJob;
  upload: AudioProcessorUpload | null;
}

export interface AudioProcessorAudioSource {
  filename: string;
  contentType: string;
  sizeBytes: number;
  readSlice(start: number, end: number): Promise<ArrayBuffer>;
  release(): void;
  resumeDescriptor?: AudioProcessorResumableAudioSource;
}

export type AudioProcessorSource =
  | Readonly<{ type: "audio"; audio: AudioProcessorAudioSource }>
  | Readonly<{ type: "youtube"; url: string }>;

export interface AudioProcessorProgressEvent {
  stage: AudioProcessorStage | "preparing" | "saving";
  progress: number;
  message: string;
  serverOwned?: boolean;
  quotedCredits?: number | null;
  chargedCredits?: number;
  resumeRequired?: boolean;
  availableTranscript?: AudioProcessorAvailableTranscript;
}

export interface AudioProcessorAvailableTranscript {
  filename: string;
  save(): Promise<AudioProcessorSavedArtifact>;
}

export interface AudioProcessorCompletedNote {
  jobId: string;
  notePath: string;
  transcriptPath: string;
  summaryAvailable: boolean;
  open(): Promise<void>;
  saveArtifact(kind: AudioProcessorArtifactKind): Promise<AudioProcessorSavedArtifact>;
}

export type AudioProcessorArtifactKind = "summary" | "transcript";

export interface AudioProcessorSavedArtifact {
  notePath: string;
  open(): Promise<void>;
}
