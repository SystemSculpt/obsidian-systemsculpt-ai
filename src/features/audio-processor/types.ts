import type {
  AudioProcessorOutputPreset,
  PendingAudioProcessorUploadSource,
} from "../../types";

export type { AudioProcessorOutputPreset } from "../../types";

export const AUDIO_PROCESSOR_OUTPUT_DIRECTORY = "SystemSculpt/Audio Notes" as const;
export const AUDIO_PROCESSOR_MAX_AUDIO_BYTES = 1_000_000_000;
export const AUDIO_PROCESSOR_OUTPUT_PRESETS = [
  "detailed",
  "meeting_brief",
  "clean_transcript",
] as const satisfies readonly AudioProcessorOutputPreset[];

export function normalizeAudioProcessorOutputPreset(
  value: unknown,
): AudioProcessorOutputPreset {
  return AUDIO_PROCESSOR_OUTPUT_PRESETS.includes(value as AudioProcessorOutputPreset)
    ? value as AudioProcessorOutputPreset
    : "detailed";
}

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
export const AUDIO_PROCESSOR_PRESET_ARTIFACT_MANIFEST_VERSION = "audio_processor_artifacts.v2" as const;

export interface AudioProcessorArtifactDescriptor {
  url: string;
  filename: string;
  sha256: string;
}

export interface AudioProcessorDetailedArtifactManifest {
  version: typeof AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION;
  outputPreset: "detailed";
  note: AudioProcessorArtifactDescriptor;
  summary: AudioProcessorArtifactDescriptor;
  transcript: AudioProcessorArtifactDescriptor;
}

export interface AudioProcessorMeetingBriefArtifactManifest {
  version: typeof AUDIO_PROCESSOR_PRESET_ARTIFACT_MANIFEST_VERSION;
  outputPreset: "meeting_brief";
  note: AudioProcessorArtifactDescriptor;
  summary: AudioProcessorArtifactDescriptor;
  transcript: AudioProcessorArtifactDescriptor;
}

export interface AudioProcessorCleanTranscriptArtifactManifest {
  version: typeof AUDIO_PROCESSOR_PRESET_ARTIFACT_MANIFEST_VERSION;
  outputPreset: "clean_transcript";
  note: AudioProcessorArtifactDescriptor;
  summary: null;
  transcript: AudioProcessorArtifactDescriptor;
}

export type AudioProcessorArtifactManifest =
  | AudioProcessorDetailedArtifactManifest
  | AudioProcessorMeetingBriefArtifactManifest
  | AudioProcessorCleanTranscriptArtifactManifest;

interface AudioProcessorResultBase {
  artifactJobId: string;
  noteUrl: string;
  transcriptUrl: string;
  urlExpiresInSeconds: number;
  filename: string;
}

export type AudioProcessorResult =
  | (AudioProcessorResultBase & {
    outputPreset: "detailed";
    summaryUrl: string;
    artifactManifest: AudioProcessorDetailedArtifactManifest | null;
  })
  | (AudioProcessorResultBase & {
    outputPreset: "meeting_brief";
    summaryUrl: string;
    artifactManifest: AudioProcessorMeetingBriefArtifactManifest | null;
  })
  | (AudioProcessorResultBase & {
    outputPreset: "clean_transcript";
    summaryUrl: null;
    artifactManifest: AudioProcessorCleanTranscriptArtifactManifest | null;
  });

export interface AudioProcessorTranscriptArtifact {
  artifactJobId: string;
  outputPreset: AudioProcessorOutputPreset;
  transcriptUrl: string;
  urlExpiresInSeconds: number;
  filename: string;
  sha256: string;
}

export interface AudioProcessorJob {
  id: string;
  outputPreset: AudioProcessorOutputPreset;
  status: AudioProcessorStatus;
  stage: AudioProcessorStage;
  progress: number;
  updatedAt: string;
  error: string | null;
  quotedCredits: number | null;
  chargedCredits: number;
  resumeRequired: boolean;
  /** Server-authored cadence for the next read-only status observation. */
  pollAfterMs?: number;
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
  primaryNoteAvailable: boolean;
  open(): Promise<void>;
  saveArtifact(kind: AudioProcessorArtifactKind): Promise<AudioProcessorSavedArtifact>;
}

export type AudioProcessorArtifactKind = "summary" | "transcript";

export interface AudioProcessorSavedArtifact {
  notePath: string;
  open(): Promise<void>;
}
