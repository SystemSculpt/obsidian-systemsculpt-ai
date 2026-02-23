import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText, parseStructuredPromptInput } from "./shared";

export const textGenerationNode: StudioNodeDefinition = {
  kind: "studio.text_generation",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "prompt", type: "text", required: true }],
  outputPorts: [
    { id: "text", type: "text" },
    { id: "model", type: "text" },
  ],
  configDefaults: {
    modelId: "",
  },
  configSchema: {
    fields: [
      {
        key: "modelId",
        label: "Model ID",
        type: "text",
        required: false,
        placeholder: "Leave empty for API default model.",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const structured = parseStructuredPromptInput(context.inputs.prompt);
    const prompt = structured.prompt.trim();
    const systemPrompt = structured.systemPrompt.trim();
    if (!prompt || !systemPrompt) {
      throw new Error(
        `Text generation node "${context.node.id}" requires prompt input with both systemPrompt and userMessage.`
      );
    }
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim() || undefined;
    const result = await context.services.api.generateText({
      prompt,
      systemPrompt,
      modelId,
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
    });
    return {
      outputs: {
        text: result.text,
        model: result.modelId,
      },
    };
  },
};
