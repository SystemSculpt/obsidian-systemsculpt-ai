import { getText, inferMimeTypeFromPath } from "./shared";
import type { StudioNodeDefinition } from "../types";

export const transcriptionNode: StudioNodeDefinition = {
  kind: "studio.transcription",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "path", type: "text", required: true }],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {},
  configSchema: {
    fields: [],
    allowUnknownKeys: true,
  },
  async execute(context) {
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
    const asset = await context.services.storeAsset(bytes, mimeType);

    const transcription = await context.services.api.transcribeAudio({
      audio: asset,
      runId: context.runId,
      projectPath: context.projectPath,
    });

    return {
      outputs: {
        text: transcription.text,
      },
    };
  },
};
