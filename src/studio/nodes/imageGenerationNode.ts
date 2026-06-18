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
  type StudioImageInputCandidate,
} from "./shared";

const IMAGE_PROMPT_MAX_CHARS = 7_900;
const IMAGE_INPUT_MAX_COUNT = 8;
const IMAGE_OUTPUT_MAX_COUNT = 4;
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Auto (model default)" },
  { value: "0.5K", label: "0.5K" },
  { value: "1K", label: "1K" },
  { value: "2K", label: "2K" },
  { value: "4K", label: "4K" },
];
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
  const merged = [...structuredInputImages, ...extractImageInputCandidates(context.inputs.images)];
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
    modelId: "",
    count: 1,
    aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
    imageSize: "",
  },
  configSchema: {
    fields: [
      {
        key: "modelId",
        label: "Model",
        type: "select",
        required: false,
        description: "Image model routed through SystemSculpt (OpenRouter). Leave on Default to let SystemSculpt choose.",
        selectPresentation: "searchable_dropdown",
        optionsSource: "studio.systemsculpt_image_models",
      },
      {
        key: "count",
        label: "Image Count",
        type: "number",
        required: true,
        min: 1,
        max: IMAGE_OUTPUT_MAX_COUNT,
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
          { value: "3:2", label: "3:2" },
          { value: "2:3", label: "2:3" },
        ],
      },
      {
        key: "imageSize",
        label: "Resolution",
        type: "select",
        required: false,
        description: "Output resolution hint. Applied only by models that support it; ignored otherwise.",
        options: IMAGE_SIZE_OPTIONS,
      },
      {
        key: "seed",
        label: "Seed",
        type: "number",
        required: false,
        min: 0,
        integer: true,
        placeholder: "Random",
        description: "Fix a seed for reproducible results. Leave blank for random.",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const { prompt, structuredInputImages } = resolveImagePrompt(context);
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
    const countRaw = Number(context.node.config.count as StudioJsonValue);
    const count =
      Number.isFinite(countRaw) && countRaw > 0
        ? Math.min(IMAGE_OUTPUT_MAX_COUNT, Math.floor(countRaw))
        : 1;
    const configuredAspectRatio = getText(context.node.config.aspectRatio as StudioJsonValue).trim();
    const aspectRatio = configuredAspectRatio || DEFAULT_IMAGE_ASPECT_RATIO;
    const modelId = getText(context.node.config.modelId as StudioJsonValue).trim();
    const imageSize = getText(context.node.config.imageSize as StudioJsonValue).trim();
    const seedConfig = context.node.config.seed;
    const seedText =
      typeof seedConfig === "number" ? String(seedConfig) : getText(seedConfig as StudioJsonValue).trim();
    const seedNum = seedText.length > 0 ? Number(seedText) : Number.NaN;
    const seed = Number.isFinite(seedNum) && seedNum >= 0 ? Math.floor(seedNum) : undefined;
    const result = await context.services.api.generateImage({
      prompt,
      modelId: modelId || undefined,
      count,
      aspectRatio,
      imageSize: imageSize || undefined,
      seed,
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
