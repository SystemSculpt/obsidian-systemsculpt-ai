import { MANAGED_IMAGE_INPUT_MAX_COUNT } from "../../services/managed/ManagedTypes";
import type {
  StudioImageGenerationInput,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
} from "../types";
import {
  extractImageInputCandidates,
  getText,
  resolveStudioImageInput,
  parseStructuredPromptInput,
  type StudioImageInputCandidate,
} from "./shared";

const IMAGE_PROMPT_MAX_CHARS = 8_000;
const IMAGE_OUTPUT_MAX_COUNT = 4;
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
function validateImagePromptLength(prompt: string): string {
  const trimmed = String(prompt || "").trim();
  if (trimmed.length > IMAGE_PROMPT_MAX_CHARS) {
    throw new Error(`Image generation accepts prompts up to ${IMAGE_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters. Shorten the prompt before running it.`);
  }
  return trimmed;
}

function resolveImagePrompt(context: StudioNodeExecutionContext): {
  prompt: string;
  structuredInputImages: StudioImageInputCandidate[];
} {
  const rawPromptInput = context.inputs.prompt;
  const structured = parseStructuredPromptInput(rawPromptInput);
  const systemPrompt = structured.systemPrompt.trim();
  if (systemPrompt.length > 0) {
    context.log(
      `[studio.image_generation] Ignoring system prompt for node "${context.node.id}". Build prompt strategy upstream in a text-generation node.`
    );
  }
  const userPrompt = structured.prompt.trim();

  if (userPrompt) {
    return {
      prompt: validateImagePromptLength(userPrompt),
      structuredInputImages: structured.inputImages,
    };
  }

  // A wired prompt input wins; the node's own Prompt box is the fallback so
  // the node runs standalone without an upstream text node.
  const wiredPrompt = getText(rawPromptInput).trim();
  const configuredPrompt = getText(context.node.config.prompt).trim();
  return {
    prompt: validateImagePromptLength(wiredPrompt || configuredPrompt),
    structuredInputImages: structured.inputImages,
  };
}

async function resolveInputImages(
  context: StudioNodeExecutionContext,
  structuredInputImages: StudioImageInputCandidate[]
): Promise<StudioImageGenerationInput[]> {
  const merged = [...structuredInputImages, ...extractImageInputCandidates(context.inputs.images)];
  if (merged.length === 0) {
    return [];
  }

  const output: StudioImageGenerationInput[] = [];
  const seen = new Set<string>();
  for (const candidate of merged) {
    if (!String(candidate.path || "").trim()) continue;
    const input = await resolveStudioImageInput(context, candidate,
      `Image generation node "${context.node.id}" received unsupported input image`);
    if (seen.has(input.asset.hash)) continue;
    if (output.length >= MANAGED_IMAGE_INPUT_MAX_COUNT) {
      throw new Error(`Image generation accepts at most ${MANAGED_IMAGE_INPUT_MAX_COUNT} distinct reference images. Remove extra references or split them into separate generation nodes.`);
    }
    seen.add(input.asset.hash);
    output.push(input);
  }

  return output;
}

export const imageGenerationNode: StudioNodeDefinition = {
  kind: "studio.image_generation",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "api",
  cachePolicy: "never",
  inputPorts: [
    { id: "prompt", type: "text", required: false },
    { id: "images", type: "any", required: false },
  ],
  outputPorts: [{ id: "images", type: "json" }],
  configDefaults: {
    prompt: "",
    model: "",
    imageSize: "",
    quality: "",
    count: 1,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  },
  configSchema: {
    fields: [
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        required: false,
        placeholder: "Describe the image to generate — or how to edit the connected images. A wired prompt input overrides this.",
      },
      {
        key: "model", label: "Image model", type: "select", required: false,
        selectPresentation: "model_picker_modal", optionsSource: "image_models",
        description: "Choose an available model. Estimates include the SystemSculpt service fee; the final charge follows actual usage. Reference images can add cost.",
      },
      {
        key: "imageSize", label: "Image size", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "image_sizes",
      },
      {
        key: "quality", label: "Quality", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "image_qualities",
      },
      {
        key: "count",
        label: "Image count",
        type: "number",
        required: true,
        min: 1,
        max: IMAGE_OUTPUT_MAX_COUNT,
        integer: true,
      },
      {
        key: "aspectRatio",
        label: "Aspect ratio",
        type: "select",
        required: false,
        description: "Target output aspect ratio.",
        selectPresentation: "searchable_dropdown",
        optionsSource: "image_aspect_ratios",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const result = await context.services.api.generateImage({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      storeOutput: context.services.storeAsset,
      buildPayload: async () => {
        const { prompt, structuredInputImages } = resolveImagePrompt(context);
        if (!prompt) {
          throw new Error(
            `Image generation node "${context.node.id}" requires a prompt. Type one in the node's Prompt box or connect a text input.`
          );
        }
        const inputImages = await resolveInputImages(context, structuredInputImages);
        const countRaw = Number(context.node.config.count);
        const count =
          Number.isFinite(countRaw) && countRaw > 0
            ? Math.min(IMAGE_OUTPUT_MAX_COUNT, Math.floor(countRaw))
            : 1;
        const configuredAspectRatio = getText(context.node.config.aspectRatio).trim();
        const aspectRatio = configuredAspectRatio || undefined;
        return {
          prompt,
          model: getText(context.node.config.model).trim() || undefined,
          imageSize: getText(context.node.config.imageSize).trim() || undefined,
          quality: getText(context.node.config.quality).trim() || undefined,
          count,
          aspectRatio,
          inputImages,
        };
      },
    });
    return {
      outputs: {
        images: result.images,
      },
      artifacts: result.images,
      managedOperations: [result.operation],
    };
  },
};
