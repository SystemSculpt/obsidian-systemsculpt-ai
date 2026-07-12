import { getText, inferMimeTypeFromPath } from "./shared";
import type { StudioNodeDefinition } from "../types";
import { sha256HexFromArrayBuffer } from "../hash";

export const transcriptionNode: StudioNodeDefinition = {
  kind: "studio.transcription",
  version: "1.0.0",
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
    let loadedSource: Promise<Readonly<{
      filename: string;
      contentType: string;
      bytes: ArrayBuffer;
    }>> | undefined;
    const loadSource = () => {
      loadedSource ??= (async () => {
        const sourcePathInput = getText(context.inputs.path).trim();
        if (!sourcePathInput) {
          throw new Error(`Transcription node "${context.node.id}" requires a path input.`);
        }
        const sourcePath = context.services.resolveAbsolutePath(sourcePathInput);
        const mimeType = inferMimeTypeFromPath(sourcePath);
        if (!mimeType.startsWith("audio/")) {
          throw new Error(
            `Transcription node "${context.node.id}" only accepts audio paths. Received "${mimeType}".`
          );
        }
        const bytes = await context.services.readLocalFileBinary(sourcePath);
        const fileName = sourcePath.split(/[\\/]/).pop() || `studio-audio.${sourcePath.split(".").pop() || "bin"}`;
        return Object.freeze({ filename: fileName, contentType: mimeType, bytes });
      })();
      return loadedSource;
    };

    const transcription = await context.services.api.transcribeAudio({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      source: {
        identity: `studio:${context.projectPath}:${context.runId}:${context.node.id}`,
        fingerprint: async () => {
          const loaded = await loadSource();
          return `sha256:${await sha256HexFromArrayBuffer(loaded.bytes)}`;
        },
        load: loadSource,
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
