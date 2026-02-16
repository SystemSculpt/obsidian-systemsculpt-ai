export const IMAGE_GENERATION_PRICING_SNAPSHOT_DATE = "2026-02-16" as const;

export const DEFAULT_IMAGE_GENERATION_MODEL_ID = "openai/gpt-5-image-mini" as const;

export const COMMON_IMAGE_ASPECT_RATIOS = ["16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const RECOMMENDED_IMAGE_ASPECT_RATIOS = ["16:9", "1:1", "9:16"] as const;

export type ImageGenerationCuratedModel = {
  id: string;
  label: string;
  provider: string;
  supportsImageInput: boolean;
  maxImagesPerJob: number;
  defaultAspectRatio: string;
  allowedAspectRatios: readonly string[];
  pricing: {
    summary: string;
    lines: string[];
  };
};

export type ImageGenerationServerCatalogModel = {
  id: string;
  name?: string;
  provider?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_image_input?: boolean;
  max_images_per_job?: number;
  default_aspect_ratio?: string;
  allowed_aspect_ratios?: string[];
};

export const CURATED_IMAGE_GENERATION_MODELS: readonly ImageGenerationCuratedModel[] = [
  {
    id: "openai/gpt-5-image-mini",
    label: "OpenAI GPT-5 Image Mini",
    provider: "OpenAI",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    pricing: {
      summary: "~$0.02/img",
      lines: ["Estimated provider cost from SystemSculpt API catalog: $0.02 per output image."],
    },
  },
  {
    id: "openai/gpt-5-image",
    label: "OpenAI GPT-5 Image",
    provider: "OpenAI",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    pricing: {
      summary: "~$0.04/img",
      lines: ["Estimated provider cost from SystemSculpt API catalog: $0.04 per output image."],
    },
  },
  {
    id: "google/gemini-2.5-flash-image",
    label: "Google Gemini 2.5 Flash Image",
    provider: "Google",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    pricing: {
      summary: "~$0.015/img",
      lines: ["Estimated provider cost from SystemSculpt API catalog: $0.015 per output image."],
    },
  },
] as const;

function dedupeAspectRatios(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const ratio = String(value || "").trim();
    if (!ratio) continue;
    if (seen.has(ratio)) continue;
    seen.add(ratio);
    out.push(ratio);
  }
  return out;
}

function normalizeServerModels(models: readonly ImageGenerationServerCatalogModel[] | undefined): ImageGenerationServerCatalogModel[] {
  if (!Array.isArray(models)) return [];
  const out: ImageGenerationServerCatalogModel[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = String(model.id || "").trim();
    if (!id) continue;
    out.push({
      id,
      name: String(model.name || "").trim() || undefined,
      provider: String(model.provider || "").trim() || undefined,
      input_modalities: Array.isArray(model.input_modalities)
        ? model.input_modalities.map((value: string) => String(value || "").trim()).filter(Boolean)
        : undefined,
      output_modalities: Array.isArray(model.output_modalities)
        ? model.output_modalities.map((value: string) => String(value || "").trim()).filter(Boolean)
        : undefined,
      supports_image_input: typeof model.supports_image_input === "boolean" ? model.supports_image_input : undefined,
      max_images_per_job:
        typeof model.max_images_per_job === "number" && Number.isFinite(model.max_images_per_job)
          ? Math.max(1, Math.floor(model.max_images_per_job))
          : undefined,
      default_aspect_ratio: String(model.default_aspect_ratio || "").trim() || undefined,
      allowed_aspect_ratios: Array.isArray(model.allowed_aspect_ratios)
        ? model.allowed_aspect_ratios.map((value: string) => String(value || "").trim()).filter(Boolean)
        : undefined,
    });
  }
  return out;
}

function supportsImageInput(serverModel: ImageGenerationServerCatalogModel): boolean {
  if (typeof serverModel.supports_image_input === "boolean") {
    return serverModel.supports_image_input;
  }
  const modalities = Array.isArray(serverModel.input_modalities) ? serverModel.input_modalities : [];
  return modalities.some((value) => String(value || "").trim().toLowerCase() === "image");
}

function toServerOnlyModel(serverModel: ImageGenerationServerCatalogModel): ImageGenerationCuratedModel {
  const provider = String(serverModel.provider || "").trim() || "OpenRouter";
  const allowedAspectRatios = dedupeAspectRatios(serverModel.allowed_aspect_ratios || COMMON_IMAGE_ASPECT_RATIOS);
  const defaultAspectRatio =
    String(serverModel.default_aspect_ratio || "").trim() || allowedAspectRatios[0] || "1:1";

  return {
    id: serverModel.id,
    label: String(serverModel.name || "").trim() || serverModel.id,
    provider,
    supportsImageInput: supportsImageInput(serverModel),
    maxImagesPerJob: Math.max(1, Math.floor(serverModel.max_images_per_job || 1)),
    defaultAspectRatio,
    allowedAspectRatios: allowedAspectRatios.length > 0 ? allowedAspectRatios : [...COMMON_IMAGE_ASPECT_RATIOS],
    pricing: {
      summary: "Server-priced",
      lines: ["Pricing is managed by the SystemSculpt API provider catalog."],
    },
  };
}

export function resolveImageGenerationModelCatalog(
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): ImageGenerationCuratedModel[] {
  const normalizedServer = normalizeServerModels(serverModels);
  const byServerId = new Map<string, ImageGenerationServerCatalogModel>();
  for (const model of normalizedServer) {
    byServerId.set(model.id, model);
  }

  const mergedCurated = CURATED_IMAGE_GENERATION_MODELS.map((curated) => {
    const server = byServerId.get(curated.id);
    if (!server) return curated;

    const mergedAllowed = dedupeAspectRatios([
      ...(Array.isArray(server.allowed_aspect_ratios) ? server.allowed_aspect_ratios : []),
      ...curated.allowedAspectRatios,
    ]);

    const defaultAspectCandidate = String(server.default_aspect_ratio || "").trim() || curated.defaultAspectRatio;
    const defaultAspectRatio = mergedAllowed.includes(defaultAspectCandidate)
      ? defaultAspectCandidate
      : curated.defaultAspectRatio;

    return {
      ...curated,
      provider: String(server.provider || "").trim() || curated.provider,
      supportsImageInput: supportsImageInput(server) || curated.supportsImageInput,
      maxImagesPerJob:
        typeof server.max_images_per_job === "number" && Number.isFinite(server.max_images_per_job)
          ? Math.max(1, Math.floor(server.max_images_per_job))
          : curated.maxImagesPerJob,
      defaultAspectRatio,
      allowedAspectRatios: mergedAllowed.length > 0 ? mergedAllowed : curated.allowedAspectRatios,
    } satisfies ImageGenerationCuratedModel;
  });

  const curatedIds = new Set(mergedCurated.map((model) => model.id));
  const serverOnly = normalizedServer
    .filter((model) => !curatedIds.has(model.id))
    .map((model) => toServerOnlyModel(model))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...mergedCurated, ...serverOnly];
}

export function getCuratedImageGenerationModel(
  id: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): ImageGenerationCuratedModel | null {
  const key = String(id || "").trim();
  if (!key) return null;
  return resolveImageGenerationModelCatalog(serverModels).find((model) => model.id === key) || null;
}

export function getCuratedImageGenerationModelGroups(
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): { provider: string; models: ImageGenerationCuratedModel[] }[] {
  const byProvider = new Map<string, ImageGenerationCuratedModel[]>();
  for (const model of resolveImageGenerationModelCatalog(serverModels)) {
    const provider = String(model.provider || "").trim() || "Other";
    const existing = byProvider.get(provider) || [];
    existing.push(model);
    byProvider.set(provider, existing);
  }

  const providers = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));
  return providers.map((provider) => ({
    provider,
    models: (byProvider.get(provider) || []).slice().sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

export function formatCuratedImageModelOptionText(model: ImageGenerationCuratedModel): string {
  const summary = String(model.pricing?.summary || "").trim();
  return summary ? `${model.label} (${model.id})  ${summary}` : `${model.label} (${model.id})`;
}

export function formatImageAspectRatioLabel(ratio: string): string {
  const value = String(ratio || "").trim();
  switch (value) {
    case "16:9":
      return "16:9 Landscape";
    case "9:16":
      return "9:16 Portrait";
    case "1:1":
      return "1:1 Square";
    case "4:3":
      return "4:3 Landscape";
    case "3:4":
      return "3:4 Portrait";
    case "3:2":
      return "3:2 Landscape";
    case "2:3":
      return "2:3 Portrait";
    default:
      return value || "Custom";
  }
}

export function getSupportedImageAspectRatios(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): string[] {
  const catalogModel = getCuratedImageGenerationModel(modelId, serverModels);
  const allowed = dedupeAspectRatios(catalogModel?.allowedAspectRatios || COMMON_IMAGE_ASPECT_RATIOS);
  const ordered = dedupeAspectRatios([...COMMON_IMAGE_ASPECT_RATIOS.filter((ratio) => allowed.includes(ratio)), ...allowed]);
  return ordered.length > 0 ? ordered : [...COMMON_IMAGE_ASPECT_RATIOS];
}

export function getRecommendedImageAspectRatios(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): string[] {
  const supported = getSupportedImageAspectRatios(modelId, serverModels);
  const preferred = RECOMMENDED_IMAGE_ASPECT_RATIOS.filter((ratio) => supported.includes(ratio));
  return preferred.length > 0 ? preferred : supported.slice(0, 3);
}

export function getDefaultImageAspectRatio(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): string {
  const catalogModel = getCuratedImageGenerationModel(modelId, serverModels);
  const supported = getSupportedImageAspectRatios(modelId, serverModels);
  const candidate = String(catalogModel?.defaultAspectRatio || "").trim() || "1:1";
  if (supported.includes(candidate)) return candidate;
  return supported[0] || "1:1";
}
