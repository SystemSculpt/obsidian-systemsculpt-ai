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
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    sourceMode: "systemsculpt",
    systemPrompt: "",
    modelId: "",
    localModelId: "",
  },
  configSchema: {
    fields: [
      {
        key: "sourceMode",
        label: "Text Source",
        type: "select",
        required: true,
        selectPresentation: "button_group",
        options: [
          { value: "systemsculpt", label: "SystemSculpt" },
          { value: "local_pi", label: "Local (Pi)" },
        ],
      },
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
        visibleWhen: {
          key: "sourceMode",
          equals: "systemsculpt",
        },
      },
      {
        key: "localModelId",
        label: "Model",
        type: "select",
        required: true,
        selectPresentation: "searchable_dropdown",
        optionsSource: "studio.local_text_models",
        visibleWhen: {
          key: "sourceMode",
          equals: "local_pi",
        },
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
    const sourceModeRaw = getText(context.node.config.sourceMode as StudioJsonValue).trim().toLowerCase();
    const sourceMode = sourceModeRaw === "local_pi" ? "local_pi" : "systemsculpt";
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim() || undefined;
    const localModelId = getText(context.node.config.localModelId as StudioJsonValue).trim() || undefined;
    const result = await context.services.api.generateText({
      prompt,
      systemPrompt,
      sourceMode,
      modelId,
      localModelId,
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
    });
    return {
      outputs: {
        text: result.text,
      },
    };
  },
};
