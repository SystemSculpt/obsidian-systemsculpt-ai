import { getText, inferMimeTypeFromPath, isLikelyAbsolutePath } from "./shared";
import type { StudioNodeDefinition } from "../types";
import { sha256HexFromArrayBuffer, sha256HexFromBytesPortable } from "../hash";
import { getHostDeviceType } from "../../platform/hostCapabilities";
import { getTranscriptionMaxFileSize } from "../../services/transcription/TranscriptionCoordinator";
import { formatFileSize } from "../../utils/FileValidator";

const UTF8 = new TextEncoder();

function buildStudioSourceIdentity(projectPath: string, nodeId: string, sourcePath: string): string {
  const descriptor = JSON.stringify({
    schema: "transcription-source-v1",
    callerScope: "studio/transcription-node",
    projectHash: sha256HexFromBytesPortable(UTF8.encode(projectPath)),
    nodeId,
    logicalSourceHash: sha256HexFromBytesPortable(UTF8.encode(sourcePath)),
  });
  return `transcription:${sha256HexFromBytesPortable(UTF8.encode(descriptor))}`;
}

export const transcriptionNode: StudioNodeDefinition = {
  kind: "studio.transcription",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "api",
  cachePolicy: "never",
  inputPorts: [{ id: "path", type: "text", required: true }],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    textDisplayMode: "rendered",
  },
  configSchema: {
    fields: [],
    allowUnknownKeys: true,
  },
  async execute(context) {
    let sourceDescriptor: Readonly<{
      sourcePath: string;
      mimeType: string;
      filename: string;
    }> | undefined;
    let sourceSizePromise: Promise<number> | undefined;
    let loadedSource: Promise<Readonly<{
      filename: string;
      contentType: string;
      bytes: ArrayBuffer;
    }>> | undefined;
    const resolveSourcePath = (): string => {
      const sourcePathInput = getText(context.inputs.path).trim();
      if (!sourcePathInput) {
        throw new Error(`Transcription node "${context.node.id}" requires a path input.`);
      }
      return sourcePathInput;
    };
    const resolveSourceDescriptor = () => {
      sourceDescriptor ??= (() => {
        const sourcePath = resolveSourcePath();
        const mimeType = inferMimeTypeFromPath(sourcePath);
        if (!mimeType.startsWith("audio/")) {
          throw new Error(
            `Transcription node "${context.node.id}" only accepts audio paths. Received "${mimeType}".`
          );
        }
        const filename = sourcePath.split(/[\\/]/).pop() || `studio-audio.${sourcePath.split(".").pop() || "bin"}`;
        return Object.freeze({ sourcePath, mimeType, filename });
      })();
      return sourceDescriptor;
    };
    const ensureSourceWithinLimit = () => {
      sourceSizePromise ??= (async () => {
        const { sourcePath } = resolveSourceDescriptor();
        const size = isLikelyAbsolutePath(sourcePath)
          ? await context.services.statLocalFileSize(sourcePath)
          : await context.services.statVaultFileSize(sourcePath);
        const maxAudioBytes = getTranscriptionMaxFileSize();
        if (!Number.isFinite(size) || size <= 0) {
          throw new Error("Audio file is empty.");
        }
        if (size > maxAudioBytes) {
          const mobilePrefix = getHostDeviceType() === "Mobile" ? "mobile " : "";
          throw new Error(
            `Audio file is too large (${formatFileSize(size)}). The ${mobilePrefix}transcription limit is ${formatFileSize(maxAudioBytes)}.`,
          );
        }
        return size;
      })();
      return sourceSizePromise;
    };
    const loadSource = () => {
      loadedSource ??= (async () => {
        const { sourcePath, mimeType, filename } = resolveSourceDescriptor();
        await ensureSourceWithinLimit();
        const bytes = isLikelyAbsolutePath(sourcePath)
          ? await context.services.readLocalFileBinary(sourcePath)
          : await context.services.readVaultBinary(sourcePath);
        return Object.freeze({ filename, contentType: mimeType, bytes });
      })();
      return loadedSource;
    };

    const transcription = await context.services.api.transcribeAudio({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      source: {
        get identity() {
          return buildStudioSourceIdentity(
            context.projectPath,
            context.node.id,
            resolveSourcePath(),
          );
        },
        fingerprint: async () => {
          const loaded = await loadSource();
          return `sha256:${await sha256HexFromArrayBuffer(loaded.bytes)}`;
        },
        load: loadSource,
        release: () => {
          sourceSizePromise = undefined;
          loadedSource = undefined;
        },
      },
    });

    return {
      outputs: {
        text: transcription.text,
      },
      managedOperations: [transcription.operation],
    };
  },
};
