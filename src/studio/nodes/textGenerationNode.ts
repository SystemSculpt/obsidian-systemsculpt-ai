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
  requiredHostCapabilities: [],
  capabilityClass: "api",
  cachePolicy: "never",
  inputPorts: [{ id: "prompt", type: "text", required: true }],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    systemPrompt: "",
    textDisplayMode: "rendered",
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
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const lockOutput = context.node.config.lockOutput === true;
    if (lockOutput) {
      return {
        outputs: {
          text: getText(context.node.config.value as StudioJsonValue),
        },
      };
    }

    const result = await context.services.api.generateText({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      buildPayload: () => {
        const structured = parseStructuredPromptInput(context.inputs.prompt);
        const prompt = structured.prompt.trim();
        if (!prompt) {
          throw new Error(`Text generation node "${context.node.id}" requires a prompt input.`);
        }
        const configuredTemplate = getText(context.node.config.systemPrompt as StudioJsonValue);
        const templateVariables = resolveTemplateVariables(context);
        const configuredSystemPrompt = renderTemplate(configuredTemplate, templateVariables).trim();
        const systemPrompt = configuredSystemPrompt || structured.systemPrompt.trim() || undefined;
        return { prompt, systemPrompt };
      },
    });
    return {
      outputs: {
        text: result.text,
      },
      managedOperations: [result.operation],
    };
  },
};
