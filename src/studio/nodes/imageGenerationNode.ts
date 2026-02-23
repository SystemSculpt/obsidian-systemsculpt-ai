import type {
  StudioAssetRef,
  StudioJsonValue,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
} from "../types";
import {
  generateImageWithLocalMacProvider,
  LOCAL_MAC_IMAGE_DEFAULT_ASPECT_RATIO,
  LOCAL_MAC_IMAGE_DEFAULT_QUALITY_PRESET,
  LOCAL_MAC_IMAGE_DEFAULT_REFERENCE_INFLUENCE,
  LOCAL_MAC_IMAGE_SUPPORTED_ASPECT_RATIOS,
  LOCAL_MAC_IMAGE_SUPPORTED_QUALITY_PRESETS,
  LOCAL_MAC_IMAGE_SUPPORTED_REFERENCE_INFLUENCE,
  normalizeStudioImageProviderId,
  STUDIO_IMAGE_PROVIDER_LOCAL_MACOS,
  STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT,
} from "./localMacImageGeneration";
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
const DEFAULT_IMAGE_PROVIDER_ID = STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT;
const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3-pro-image-preview";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const DEFAULT_LOCAL_IMAGE_ASPECT_RATIO = LOCAL_MAC_IMAGE_DEFAULT_ASPECT_RATIO;
const DEFAULT_LOCAL_IMAGE_QUALITY_PRESET = LOCAL_MAC_IMAGE_DEFAULT_QUALITY_PRESET;
const DEFAULT_LOCAL_IMAGE_REFERENCE_INFLUENCE = LOCAL_MAC_IMAGE_DEFAULT_REFERENCE_INFLUENCE;

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

function normalizeAllowedString(
  value: string,
  allowed: readonly string[],
  fallback: string
): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return fallback;
  }
  return allowed.includes(trimmed) ? trimmed : fallback;
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
    provider: DEFAULT_IMAGE_PROVIDER_ID,
    systemPrompt: "",
    modelId: DEFAULT_IMAGE_MODEL_ID,
    count: 1,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
    localAspectRatio: DEFAULT_LOCAL_IMAGE_ASPECT_RATIO,
    localQuality: DEFAULT_LOCAL_IMAGE_QUALITY_PRESET,
    localReferenceInfluence: DEFAULT_LOCAL_IMAGE_REFERENCE_INFLUENCE,
  },
  configSchema: {
    fields: [
      {
        key: "provider",
        label: "Image Provider",
        description: "Choose SystemSculpt AI or local macOS image generation.",
        type: "select",
        required: true,
        selectPresentation: "button_group",
        options: [
          { value: STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT, label: "SystemSculpt AI" },
          { value: STUDIO_IMAGE_PROVIDER_LOCAL_MACOS, label: "Local macOS image generation" },
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
        label: "Image Model",
        description: "Used by the SystemSculpt AI provider.",
        type: "select",
        required: false,
        visibleWhen: {
          key: "provider",
          equals: STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT,
        },
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
        description: "Used by the SystemSculpt AI provider.",
        visibleWhen: {
          key: "provider",
          equals: STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT,
        },
        options: [
          { value: "16:9", label: "16:9 (YouTube)" },
          { value: "1:1", label: "1:1" },
          { value: "9:16", label: "9:16" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "21:9", label: "21:9" },
        ],
      },
      {
        key: "localAspectRatio",
        label: "Local Aspect Ratio",
        type: "select",
        required: false,
        description: "Native ratio preset for local macOS diffusion.",
        visibleWhen: {
          key: "provider",
          equals: STUDIO_IMAGE_PROVIDER_LOCAL_MACOS,
        },
        options: [
          { value: "1:1", label: "1:1" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
        ],
      },
      {
        key: "localQuality",
        label: "Local Quality",
        type: "select",
        required: false,
        description: "Layman quality preset for local macOS diffusion speed vs detail.",
        visibleWhen: {
          key: "provider",
          equals: STUDIO_IMAGE_PROVIDER_LOCAL_MACOS,
        },
        options: [
          { value: "fast", label: "Fast" },
          { value: "balanced", label: "Balanced" },
          { value: "high", label: "High Detail" },
        ],
      },
      {
        key: "localReferenceInfluence",
        label: "Reference Influence",
        type: "select",
        required: false,
        description: "How closely local generation should follow the first connected reference image.",
        visibleWhen: {
          key: "provider",
          equals: STUDIO_IMAGE_PROVIDER_LOCAL_MACOS,
        },
        options: [
          { value: "subtle", label: "Subtle" },
          { value: "balanced", label: "Balanced" },
          { value: "strong", label: "Strong" },
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
    const provider = normalizeStudioImageProviderId(providerRaw);
    if (!provider && providerRaw) {
      throw new Error(
        `Image generation node "${context.node.id}" has unsupported provider "${providerRaw}".`
      );
    }
    const resolvedProvider = provider || DEFAULT_IMAGE_PROVIDER_ID;
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim() || undefined;
    const countRaw = Number(context.node.config.count as StudioJsonValue);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(8, Math.floor(countRaw)) : 1;
    const configuredAspectRatio = getText(context.node.config.aspectRatio as StudioJsonValue).trim();
    const configuredLocalAspectRatio = getText(
      context.node.config.localAspectRatio as StudioJsonValue
    ).trim();
    const configuredLocalQuality = getText(context.node.config.localQuality as StudioJsonValue).trim();
    const configuredReferenceInfluence = getText(
      context.node.config.localReferenceInfluence as StudioJsonValue
    ).trim();
    const localAspectRatio = normalizeAllowedString(
      configuredLocalAspectRatio,
      LOCAL_MAC_IMAGE_SUPPORTED_ASPECT_RATIOS,
      DEFAULT_LOCAL_IMAGE_ASPECT_RATIO
    );
    const localQuality = normalizeAllowedString(
      configuredLocalQuality,
      LOCAL_MAC_IMAGE_SUPPORTED_QUALITY_PRESETS,
      DEFAULT_LOCAL_IMAGE_QUALITY_PRESET
    );
    const localReferenceInfluence = normalizeAllowedString(
      configuredReferenceInfluence,
      LOCAL_MAC_IMAGE_SUPPORTED_REFERENCE_INFLUENCE,
      DEFAULT_LOCAL_IMAGE_REFERENCE_INFLUENCE
    );
    const aspectRatio =
      resolvedProvider === STUDIO_IMAGE_PROVIDER_LOCAL_MACOS
        ? localAspectRatio
        : configuredAspectRatio || DEFAULT_IMAGE_ASPECT_RATIO;
    const result =
      resolvedProvider === STUDIO_IMAGE_PROVIDER_LOCAL_MACOS
        ? await generateImageWithLocalMacProvider(context, {
            prompt,
            count,
            aspectRatio,
            inputImages,
            runId: context.runId,
            qualityPreset: localQuality,
            referenceInfluence: localReferenceInfluence,
          })
        : await context.services.api.generateImage({
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
