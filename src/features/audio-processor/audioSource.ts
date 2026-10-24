import type { App, TFile } from "obsidian";
import { isAudioFileExtension, normalizeFileExtension } from "../../constants/fileTypes";
import { canReadVaultFileInParts, createDeviceFileSource, createVaultFileSource } from "../../platform/fileSource";
import {
  AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
  type AudioProcessorAudioSource,
} from "./types";

const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
});

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : normalizeFileExtension(filename.slice(dot + 1));
}

function validateAudioMetadata(filename: string, sizeBytes: number): string {
  const extension = extensionOf(filename);
  if (!isAudioFileExtension(extension)) {
    throw new Error("Choose an MP3, WAV, M4A, MP4, OGG, WebM, or FLAC audio file.");
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("The selected audio file is empty.");
  }
  if (sizeBytes > AUDIO_PROCESSOR_MAX_AUDIO_BYTES) {
    throw new Error("Audio files can be up to 1 GB.");
  }
  return extension;
}

export function createDeviceAudioSource(file: File): AudioProcessorAudioSource {
  const extension = validateAudioMetadata(file.name, file.size);

  return {
    filename: file.name,
    contentType: AUDIO_MIME_TYPES[extension],
    ...createDeviceFileSource(file),
  };
}

export function canReadVaultAudioInParts(app: App): boolean {
  return canReadVaultFileInParts(app);
}

export function createVaultAudioSource(
  app: App,
  file: TFile,
): AudioProcessorAudioSource {
  const sizeBytes = file.stat.size;
  const modifiedAt = file.stat.mtime;
  const extension = validateAudioMetadata(file.name, sizeBytes);
  if (!canReadVaultAudioInParts(app)) {
    throw new Error("On mobile, choose this recording from Device so it can upload in small parts.");
  }
  return {
    ...createVaultFileSource(app, file),
    filename: file.name,
    contentType: AUDIO_MIME_TYPES[extension],
    resumeDescriptor: { kind: "vault", filePath: file.path, modifiedAt },
  };
}
