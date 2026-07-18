import type SystemSculptPlugin from "../../main";
import type { PendingAudioProcessorUpload } from "../../types";
import type { AudioProcessorAudioSource } from "./types";

type UploadedPart = Readonly<{ part_number: number; etag: string }>;

const MAX_PENDING_UPLOADS = 10;
const persistenceByPlugin = new WeakMap<SystemSculptPlugin, Promise<void>>();

export class AudioProcessorUploadRecovery {
  constructor(private readonly plugin: SystemSculptPlugin) {}

  async get(jobId: string): Promise<PendingAudioProcessorUpload | null> {
    const normalizedJobId = normalizeJobId(jobId);
    return this.currentEntries().find((entry) => entry.jobId === normalizedJobId) ?? null;
  }

  async rememberStarted(
    jobId: string,
    source: AudioProcessorAudioSource,
    upload: Readonly<{ partSizeBytes: number; totalParts: number }>,
  ): Promise<void> {
    const descriptor = source.resumeDescriptor;
    if (!descriptor) return;
    const entry: PendingAudioProcessorUpload = {
      jobId: normalizeJobId(jobId),
      filename: source.filename,
      contentType: source.contentType,
      sizeBytes: source.sizeBytes,
      source: descriptor,
      partSizeBytes: upload.partSizeBytes,
      totalParts: upload.totalParts,
      uploadedParts: [],
      updatedAt: Date.now(),
    };
    await this.mutate((current) => [
      ...current.filter((candidate) => candidate.jobId !== entry.jobId),
      entry,
    ]);
  }

  async rememberPart(jobId: string, part: UploadedPart): Promise<void> {
    const normalizedJobId = normalizeJobId(jobId);
    await this.mutate((current) => current.map((entry) => {
      if (entry.jobId !== normalizedJobId) return entry;
      const uploadedPartMap = new Map(entry.uploadedParts.map((candidate) => [
        candidate.partNumber,
        candidate,
      ]));
      uploadedPartMap.set(part.part_number, {
        partNumber: part.part_number,
        etag: part.etag,
      });
      return {
        ...entry,
        uploadedParts: [...uploadedPartMap.values()].sort(
          (left, right) => left.partNumber - right.partNumber,
        ),
        updatedAt: Date.now(),
      };
    }));
  }

  async rememberAuthoritativeState(
    jobId: string,
    upload: Readonly<{
      partSizeBytes: number;
      totalParts: number;
      parts: readonly UploadedPart[];
    }>,
  ): Promise<void> {
    const normalizedJobId = normalizeJobId(jobId);
    await this.mutate((current) => current.map((entry) => {
      if (entry.jobId !== normalizedJobId) return entry;
      return {
        ...entry,
        partSizeBytes: upload.partSizeBytes,
        totalParts: upload.totalParts,
        uploadedParts: [...upload.parts]
          .map((part) => ({ partNumber: part.part_number, etag: part.etag.trim() }))
          .sort((left, right) => left.partNumber - right.partNumber),
        updatedAt: Date.now(),
      };
    }));
  }

  async forget(jobId: string): Promise<void> {
    const normalizedJobId = normalizeJobId(jobId);
    await this.mutate((current) => current.filter((entry) => entry.jobId !== normalizedJobId));
  }

  private currentEntries(): PendingAudioProcessorUpload[] {
    return [...(this.plugin.settings.pendingAudioProcessorUploads ?? [])]
      .map((entry) => ({
        ...entry,
        uploadedParts: [...entry.uploadedParts],
      }));
  }

  private mutate(
    mutate: (current: PendingAudioProcessorUpload[]) => PendingAudioProcessorUpload[],
  ): Promise<void> {
    const currentPersistence = persistenceByPlugin.get(this.plugin) ?? Promise.resolve();
    const next = currentPersistence.then(async () => {
      const current = this.currentEntries();
      const pendingAudioProcessorUploads = mutate(current)
        .slice(-MAX_PENDING_UPLOADS);
      await this.plugin.getSettingsManager().updateSettings({ pendingAudioProcessorUploads });
    });
    persistenceByPlugin.set(this.plugin, next.catch(() => undefined));
    return next;
  }
}

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(normalized)) {
    throw new Error("The audio upload recovery job ID was invalid.");
  }
  return normalized;
}
