import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText, renderTemplate, resolveTemplateVariables } from "./shared";

export const promptTemplateNode: StudioNodeDefinition = {
  kind: "studio.prompt_template",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [
    { id: "text", type: "text", required: false },
    { id: "json", type: "json", required: false },
  ],
  outputPorts: [{ id: "prompt", type: "text" }],
  configDefaults: {
    template: "{{text}}",
    variables: {},
  },
  configSchema: {
    fields: [
      {
        key: "template",
        label: "System Prompt Template",
        type: "textarea",
        required: true,
        placeholder: "Use {{variable}} placeholders. This becomes the system prompt.",
      },
      {
        key: "variables",
        label: "Variables",
        type: "json_object",
        required: false,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const template = getText(context.node.config.template as StudioJsonValue) || "{{text}}";
    const variables = resolveTemplateVariables(context);
    const systemPrompt = renderTemplate(template, variables).trim();
    const userMessage = getText(context.inputs.text).trim() || getText(variables.text).trim();
    if (!systemPrompt || !userMessage) {
      throw new Error(
        `Prompt template node "${context.node.id}" requires both a system prompt template result and a text input.`
      );
    }
    const prompt = {
      systemPrompt,
      userMessage,
      prompt: userMessage,
      text: userMessage,
    } as StudioJsonValue;
    return {
      outputs: {
        prompt,
      },
    };
  },
};
