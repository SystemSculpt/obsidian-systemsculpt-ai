import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import {
  getText,
  parseStructuredPromptInput,
  renderTemplate,
  resolveTemplateVariables,
} from "./shared";

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
    systemPrompt: "",
    modelId: "",
  },
  configSchema: {
    fields: [
      {
        key: "systemPrompt",
        label: "System Prompt",
        type: "textarea",
        required: false,
        placeholder: "Optional system instructions. Supports {{prompt}} placeholder.",
      },
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
    if (!prompt) {
      throw new Error(`Text generation node "${context.node.id}" requires a prompt input.`);
    }
    const configuredTemplate = getText(context.node.config.systemPrompt as StudioJsonValue);
    const templateVariables = resolveTemplateVariables(context);
    const configuredSystemPrompt = renderTemplate(configuredTemplate, templateVariables).trim();
    const systemPrompt = configuredSystemPrompt || structured.systemPrompt.trim() || undefined;
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
