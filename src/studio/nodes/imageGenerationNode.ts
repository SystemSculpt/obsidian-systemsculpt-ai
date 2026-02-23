import type {
  StudioAssetRef,
  StudioJsonValue,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
} from "../types";
import {
  extractImageInputCandidates,
  getText,
  inferMimeTypeFromPath,
  isLikelyAbsolutePath,
  parseStructuredPromptInput,
  renderTemplate,
  resolveTemplateVariables,
  type StudioImageInputCandidate,
} from "./shared";

const IMAGE_PROMPT_MAX_CHARS = 7_900;
const IMAGE_CONTEXT_MAX_CHARS = 3_600;
const IMAGE_INPUT_MAX_COUNT = 8;
const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3-pro-image-preview";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const LEGACY_LOCAL_PROVIDER_IDS = new Set([
  "local_macos_image_generation",
  "local_macos",
  "local_macos_image",
]);

function normalizeInputMimeType(mimeType: string): "image/png" | "image/jpeg" | "image/webp" | null {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

function asExistingAssetRef(candidate: StudioImageInputCandidate): StudioAssetRef | null {
  const hash = String(candidate.hash || "").trim().toLowerCase();
  const path = String(candidate.path || "").trim();
  const sizeRaw = Number(candidate.sizeBytes);
  const sizeBytes = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
  const normalizedMime = normalizeInputMimeType(String(candidate.mimeType || ""));
  if (!hash || !path || !sizeBytes || !normalizedMime) {
    return null;
  }
  return {
    hash,
    mimeType: normalizedMime,
    sizeBytes,
    path,
  };
}

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

async function resolveImagePrompt(context: StudioNodeExecutionContext): Promise<{
  prompt: string;
  structuredInputImages: StudioImageInputCandidate[];
}> {
  const rawPromptInput = context.inputs.prompt;
  const structured = parseStructuredPromptInput(rawPromptInput);
  const configuredSystemPrompt = renderTemplate(
    getText(context.node.config.systemPrompt as StudioJsonValue),
    resolveTemplateVariables(context)
  ).trim();
  const systemPrompt = configuredSystemPrompt || structured.systemPrompt.trim();
  const userPrompt = structured.prompt.trim();

  if (systemPrompt && userPrompt) {
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
        return {
          prompt: compiled,
          structuredInputImages: structured.inputImages,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log(
        `[studio.image_generation] Prompt materialization failed, falling back to compact prompt: ${message.slice(0, 240)}`
      );
    }

    return {
      prompt: clampImagePromptLength(`${systemPrompt}\n\n${compactedUserPrompt}`, IMAGE_PROMPT_MAX_CHARS),
      structuredInputImages: structured.inputImages,
    };
  }

  if (userPrompt) {
    return {
      prompt: clampImagePromptLength(userPrompt, IMAGE_PROMPT_MAX_CHARS),
      structuredInputImages: structured.inputImages,
    };
  }

  return {
    prompt: clampImagePromptLength(getText(rawPromptInput), IMAGE_PROMPT_MAX_CHARS),
    structuredInputImages: structured.inputImages,
  };
}

async function resolveInputImages(
  context: StudioNodeExecutionContext,
  structuredInputImages: StudioImageInputCandidate[]
): Promise<StudioAssetRef[]> {
  const merged = [
    ...structuredInputImages,
    ...extractImageInputCandidates(context.inputs.images),
  ];
  if (merged.length === 0) {
    return [];
  }

  const output: StudioAssetRef[] = [];
  const seen = new Set<string>();
  let ignoredOverflow = 0;
  for (const candidate of merged) {
    if (output.length >= IMAGE_INPUT_MAX_COUNT) {
      ignoredOverflow += 1;
      continue;
    }
    const sourcePath = String(candidate.path || "").trim();
    if (!sourcePath) {
      continue;
    }

    const existing = asExistingAssetRef(candidate);
    if (existing) {
      if (!seen.has(existing.hash)) {
        seen.add(existing.hash);
        output.push(existing);
      }
      continue;
    }

    const mimeHint =
      normalizeInputMimeType(String(candidate.mimeType || "")) ||
      normalizeInputMimeType(inferMimeTypeFromPath(sourcePath));
    if (!mimeHint) {
      throw new Error(
        `Image generation node "${context.node.id}" received unsupported input image format "${sourcePath}". Use PNG, JPEG, or WEBP.`
      );
    }

    let bytes: ArrayBuffer;
    if (isLikelyAbsolutePath(sourcePath)) {
      context.services.assertFilesystemPath(sourcePath);
      bytes = await context.services.readLocalFileBinary(sourcePath);
    } else {
      bytes = await context.services.readVaultBinary(sourcePath);
    }
    const stored = await context.services.storeAsset(bytes, mimeHint);
    if (!seen.has(stored.hash)) {
      seen.add(stored.hash);
      output.push(stored);
    }
  }

  if (ignoredOverflow > 0) {
    context.log(
      `[studio.image_generation] Ignored ${ignoredOverflow} input image(s) beyond limit ${IMAGE_INPUT_MAX_COUNT}.`
    );
  }

  return output;
}

export const imageGenerationNode: StudioNodeDefinition = {
  kind: "studio.image_generation",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "by_inputs",
  inputPorts: [
    { id: "prompt", type: "text", required: true },
    { id: "images", type: "any", required: false },
  ],
  outputPorts: [{ id: "images", type: "json" }],
  configDefaults: {
    systemPrompt: "",
    modelId: DEFAULT_IMAGE_MODEL_ID,
    count: 1,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
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
        label: "Image Model",
        description: "Image model used for SystemSculpt API generation.",
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
        description: "Target output aspect ratio.",
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
    const { prompt, structuredInputImages } = await resolveImagePrompt(context);
    if (!prompt) {
      throw new Error(`Image generation node "${context.node.id}" requires a prompt input.`);
    }
    const inputImages = await resolveInputImages(context, structuredInputImages);
    const providerRaw = getText(context.node.config.provider as StudioJsonValue).trim();
    if (LEGACY_LOCAL_PROVIDER_IDS.has(providerRaw.toLowerCase())) {
      throw new Error(
        `Image generation node "${context.node.id}" is configured for removed provider "${providerRaw}". Switch this node to SystemSculpt AI and rerun.`
      );
    }
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim() || undefined;
    const countRaw = Number(context.node.config.count as StudioJsonValue);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(8, Math.floor(countRaw)) : 1;
    const configuredAspectRatio = getText(context.node.config.aspectRatio as StudioJsonValue).trim();
    const aspectRatio = configuredAspectRatio || DEFAULT_IMAGE_ASPECT_RATIO;
    const result = await context.services.api.generateImage({
      prompt,
      modelId,
      count,
      aspectRatio,
      inputImages,
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
