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
    modelId: "",
    localModelId: "",
    reasoningEffort: "medium",
    systemPrompt: "",
    textDisplayMode: "rendered",
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
        key: "modelId",
        label: "Model",
        type: "select",
        required: false,
        selectPresentation: "searchable_dropdown",
        optionsSource: "studio.systemsculpt_text_models",
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
      {
        key: "reasoningEffort",
        label: "Reasoning Level",
        type: "select",
        required: false,
        selectPresentation: "searchable_dropdown",
        options: [
          { value: "off", label: "Off" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "XHigh" },
        ],
      },
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
    const reasoningEffortRaw = getText(context.node.config.reasoningEffort as StudioJsonValue).trim().toLowerCase();
    const reasoningEffort =
      reasoningEffortRaw === "off" ||
      reasoningEffortRaw === "minimal" ||
      reasoningEffortRaw === "low" ||
      reasoningEffortRaw === "medium" ||
      reasoningEffortRaw === "high" ||
      reasoningEffortRaw === "xhigh"
        ? reasoningEffortRaw
        : undefined;
    const result = await context.services.api.generateText({
      prompt,
      systemPrompt,
      sourceMode,
      modelId,
      localModelId,
      reasoningEffort,
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
