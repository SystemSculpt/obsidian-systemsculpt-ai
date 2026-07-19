import type { App, TFile } from "obsidian";
import { isAudioFileExtension, normalizeFileExtension } from "../../constants/fileTypes";
import { desktopHost, hasNodeRuntime } from "../../platform/desktopOnly";
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
    sizeBytes: file.size,
    readSlice: async (start, end) => await file.slice(start, end).arrayBuffer(),
    release: () => undefined,
  };
}

export function canReadVaultAudioInParts(app: App): boolean {
  const adapter = app.vault.adapter as { getFullPath?: (path: string) => string };
  return hasNodeRuntime() && typeof adapter.getFullPath === "function";
}

export function createVaultAudioSource(
  app: App,
  file: TFile,
): AudioProcessorAudioSource {
  const sizeBytes = file.stat.size;
  const modifiedAt = file.stat.mtime;
  const extension = validateAudioMetadata(file.name, sizeBytes);
  const adapter = app.vault.adapter as { getFullPath?: (path: string) => string };
  if (canReadVaultAudioInParts(app)) {
    return createDesktopVaultAudioSource(
      adapter.getFullPath!(file.path),
      file,
      sizeBytes,
      modifiedAt,
      AUDIO_MIME_TYPES[extension],
    );
  }
  throw new Error(
    "On mobile, choose this recording from Device so it can upload in small parts.",
  );
}

function createDesktopVaultAudioSource(
  absolutePath: string,
  file: TFile,
  sizeBytes: number,
  modifiedAt: number,
  contentType: string,
): AudioProcessorAudioSource {
  const fs = desktopHost.fs();
  let handlePromise: ReturnType<typeof fs.open> | null = null;
  let released = false;
  const loadHandle = (): ReturnType<typeof fs.open> => {
    if (released) return Promise.reject(new Error("The selected vault audio was released."));
    handlePromise ??= fs.open(absolutePath, "r");
    return handlePromise;
  };

  return {
    filename: file.name,
    contentType,
    sizeBytes,
    resumeDescriptor: {
      kind: "vault",
      filePath: file.path,
      modifiedAt,
    },
    readSlice: async (start, end) => {
      const handle = await loadHandle();
      const stat = await handle.stat();
      if (
        stat.size !== sizeBytes
        || Math.abs(stat.mtimeMs - modifiedAt) > 2
        || file.stat.size !== sizeBytes
        || file.stat.mtime !== modifiedAt
      ) {
        throw new Error("The selected vault audio changed while it was being read.");
      }
      const bytes = new Uint8Array(end - start);
      let totalRead = 0;
      while (totalRead < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          totalRead,
          bytes.byteLength - totalRead,
          start + totalRead,
        );
        if (result.bytesRead <= 0) {
          throw new Error("The selected vault audio changed while it was being read.");
        }
        totalRead += result.bytesRead;
      }
      return bytes.buffer;
    },
    release: () => {
      released = true;
      const pending = handlePromise;
      handlePromise = null;
      if (pending) void pending.then((handle) => handle.close()).catch(() => undefined);
    },
  };
}
