import type { StudioJsonValue, StudioNodeDefinition, StudioNodeExecutionContext } from "../types";
import { isRecord } from "../utils";
import { getText, parseStructuredPromptInput } from "./shared";

const IMAGE_PROMPT_MAX_CHARS = 7_900;
const IMAGE_CONTEXT_MAX_CHARS = 3_600;
const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3-pro-image-preview";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";

function clampImagePromptLength(prompt: string, maxChars: number = IMAGE_PROMPT_MAX_CHARS): string {
  const trimmed = String(prompt || "").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars).trim();
}

function compactContextText(text: string, maxChars: number = IMAGE_CONTEXT_MAX_CHARS): string {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.max(0, maxChars - headChars - 7);
  const head = cleaned.slice(0, headChars).trim();
  const tail = cleaned.slice(Math.max(headChars, cleaned.length - tailChars)).trim();
  if (!tail) {
    return head;
  }
  return `${head} [...] ${tail}`;
}

function isStructuredPromptPayload(value: StudioJsonValue | undefined): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const payload = value as Record<string, StudioJsonValue>;
  return (
    typeof payload.systemPrompt === "string" ||
    typeof payload.system_prompt === "string" ||
    typeof payload.userMessage === "string" ||
    typeof payload.user_message === "string"
  );
}

async function resolveImagePrompt(context: StudioNodeExecutionContext): Promise<string> {
  const rawPromptInput = context.inputs.prompt;
  const structured = parseStructuredPromptInput(rawPromptInput);
  const systemPrompt = structured.systemPrompt.trim();
  const userPrompt = structured.prompt.trim();

  if (isStructuredPromptPayload(rawPromptInput) && systemPrompt && userPrompt) {
    const compactedUserPrompt = compactContextText(userPrompt, IMAGE_CONTEXT_MAX_CHARS);
    try {
      const materialized = await context.services.api.generateText({
        prompt: compactedUserPrompt,
        systemPrompt: `${systemPrompt}\n\nOutput constraints:\n- Return ONLY the final image prompt text.\n- Keep the final image prompt under ${IMAGE_PROMPT_MAX_CHARS} characters.`,
        runId: context.runId,
        nodeId: context.node.id,
        projectPath: context.projectPath,
      });
      const compiled = clampImagePromptLength(materialized.text, IMAGE_PROMPT_MAX_CHARS);
      if (compiled) {
        context.log(
          `[studio.image_generation] Materialized structured prompt (${compiled.length} chars) before image generation.`
        );
        return compiled;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log(
        `[studio.image_generation] Prompt materialization failed, falling back to compact prompt: ${message.slice(0, 240)}`
      );
    }

    return clampImagePromptLength(`${systemPrompt}\n\n${compactedUserPrompt}`, IMAGE_PROMPT_MAX_CHARS);
  }

  if (isRecord(rawPromptInput)) {
    return clampImagePromptLength(userPrompt || getText(rawPromptInput), IMAGE_PROMPT_MAX_CHARS);
  }

  return clampImagePromptLength(getText(rawPromptInput), IMAGE_PROMPT_MAX_CHARS);
}

export const imageGenerationNode: StudioNodeDefinition = {
  kind: "studio.image_generation",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "prompt", type: "text", required: true }],
  outputPorts: [{ id: "images", type: "json" }],
  configDefaults: {
    modelId: DEFAULT_IMAGE_MODEL_ID,
    count: 1,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  },
  configSchema: {
    fields: [
      {
        key: "modelId",
        label: "Image Model",
        type: "select",
        required: false,
        options: [
          { value: "google/gemini-3-pro-image-preview", label: "Gemini Nano Banana Pro" },
          { value: "bytedance-seed/seedream-4.5", label: "ByteDance Seedream 4.5" },
          { value: "google/nano-banana-pro", label: "Gemini Nano Banana Pro (legacy alias)" },
          { value: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
          { value: "openai/gpt-5-image-mini", label: "OpenAI GPT-5 Image Mini" },
          { value: "openai/gpt-5-image", label: "OpenAI GPT-5 Image" },
        ],
      },
      {
        key: "count",
        label: "Image Count",
        type: "number",
        required: true,
        min: 1,
        max: 8,
        integer: true,
      },
      {
        key: "aspectRatio",
        label: "Aspect Ratio",
        type: "select",
        required: false,
        options: [
          { value: "16:9", label: "16:9 (YouTube)" },
          { value: "1:1", label: "1:1" },
          { value: "9:16", label: "9:16" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "21:9", label: "21:9" },
        ],
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const prompt = await resolveImagePrompt(context);
    if (!prompt) {
      throw new Error(`Image generation node "${context.node.id}" requires a prompt input.`);
    }
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim() || undefined;
    const countRaw = Number(context.node.config.count as StudioJsonValue);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(8, Math.floor(countRaw)) : 1;
    const aspectRatio =
      getText(context.node.config.aspectRatio as StudioJsonValue).trim() || DEFAULT_IMAGE_ASPECT_RATIO;
    const result = await context.services.api.generateImage({
      prompt,
      modelId,
      count,
      aspectRatio,
      runId: context.runId,
      projectPath: context.projectPath,
    });
    return {
      outputs: {
        images: result.images as unknown as StudioJsonValue,
      },
      artifacts: result.images,
    };
  },
};
