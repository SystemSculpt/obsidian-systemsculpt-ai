import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { audioExtractNode } from "./nodes/audioExtractNode";
import { cliCommandNode } from "./nodes/cliCommandNode";
import { datasetNode } from "./nodes/datasetNode";
import { httpRequestNode } from "./nodes/httpRequestNode";
import { imageGenerationNode } from "./nodes/imageGenerationNode";
import { inputNode } from "./nodes/inputNode";
import { labelNode } from "./nodes/labelNode";
import { mediaIngestNode } from "./nodes/mediaIngestNode";
import { noteNode } from "./nodes/noteNode";
import { textNode } from "./nodes/textNode";
import { textGenerationNode } from "./nodes/textGenerationNode";
import { transcriptionNode } from "./nodes/transcriptionNode";

export function registerBuiltInStudioNodes(registry: StudioNodeRegistry): void {
  registry.register(inputNode);
  registry.register(labelNode);
  registry.register(noteNode);
  registry.register(textNode);
  registry.register(textGenerationNode);
  registry.register(imageGenerationNode);
  registry.register(mediaIngestNode);
  registry.register(audioExtractNode);
  registry.register(transcriptionNode);
  registry.register(datasetNode);
  registry.register(httpRequestNode);
  registry.register(cliCommandNode);
}
