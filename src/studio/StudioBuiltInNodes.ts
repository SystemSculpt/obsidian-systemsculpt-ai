import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { audioExtractNode } from "./nodes/audioExtractNode";
import { cliCommandNode } from "./nodes/cliCommandNode";
import { httpRequestNode } from "./nodes/httpRequestNode";
import { imageGenerationNode } from "./nodes/imageGenerationNode";
import { inputNode } from "./nodes/inputNode";
import { mediaIngestNode } from "./nodes/mediaIngestNode";
import { textNode } from "./nodes/textNode";
import { textGenerationNode } from "./nodes/textGenerationNode";
import { transcriptionNode } from "./nodes/transcriptionNode";

export function registerBuiltInStudioNodes(registry: StudioNodeRegistry): void {
  registry.register(inputNode);
  registry.register(textNode);
  registry.register(textGenerationNode);
  registry.register(imageGenerationNode);
  registry.register(mediaIngestNode);
  registry.register(audioExtractNode);
  registry.register(transcriptionNode);
  registry.register(httpRequestNode);
  registry.register(cliCommandNode);
}
