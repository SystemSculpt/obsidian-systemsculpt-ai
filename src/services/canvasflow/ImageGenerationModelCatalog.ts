export const DEFAULT_IMAGE_GENERATION_MODEL_ID = "openai/gpt-5-image-mini" as const;

export const COMMON_IMAGE_ASPECT_RATIOS = ["16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const RECOMMENDED_IMAGE_ASPECT_RATIOS = ["16:9", "1:1", "9:16"] as const;

export const IMAGE_GENERATION_BILLING_FORMULA_VERSION = "raw_usd_x_markup_x_credits_per_usd.ceil.v1" as const;
export const IMAGE_GENERATION_BILLING_MARKUP_MULTIPLIER = 1.5 as const;
export const IMAGE_GENERATION_BILLING_CREDITS_PER_USD = 800 as const;
export const IMAGE_GENERATION_EFFECTIVE_CREDITS_PER_USD =
  IMAGE_GENERATION_BILLING_MARKUP_MULTIPLIER * IMAGE_GENERATION_BILLING_CREDITS_PER_USD;

type ImagePricing = {
  summary: string;
  lines: string[];
  usdPerImageAverage: number | null;
  usdPerImageLow: number | null;
  usdPerImageHigh: number | null;
  creditsPerImageAverage: number | null;
  creditsPerImageLow: number | null;
  creditsPerImageHigh: number | null;
  source: string;
};

export type ImageGenerationCuratedModel = {
  id: string;
  label: string;
  provider: string;
  supportsGeneration: boolean;
  supportsImageInput: boolean;
  maxImagesPerJob: number;
  defaultAspectRatio: string;
  allowedAspectRatios: readonly string[];
  pricing: ImagePricing;
};

export type ImageGenerationServerCatalogModel = {
  id: string;
  name?: string;
  provider?: string;
  supports_generation?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_image_input?: boolean;
  max_images_per_job?: number;
  default_aspect_ratio?: string;
  allowed_aspect_ratios?: string[];
  estimated_cost_per_image_usd?: number;
  estimated_cost_per_image_low_usd?: number;
  estimated_cost_per_image_high_usd?: number;
  pricing_source?: string;
};

type CuratedImageGenerationModelSeed = {
  id: string;
  label: string;
  provider: string;
  supportsImageInput: boolean;
  maxImagesPerJob: number;
  defaultAspectRatio: string;
  allowedAspectRatios: readonly string[];
  fallbackUsdPerImage?: number;
};

const EXCLUDED_MODEL_IDS = new Set(["openrouter/auto"]);

const CURATED_IMAGE_GENERATION_MODELS_SEED: readonly CuratedImageGenerationModelSeed[] = [
  {
    id: "openai/gpt-5-image-mini",
    label: "OpenAI GPT-5 Image Mini",
    provider: "OpenAI",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    fallbackUsdPerImage: 0.02,
  },
  {
    id: "openai/gpt-5-image",
    label: "OpenAI GPT-5 Image",
    provider: "OpenAI",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    fallbackUsdPerImage: 0.04,
  },
  {
    id: "google/gemini-2.5-flash-image",
    label: "Google Gemini 2.5 Flash Image",
    provider: "Google",
    supportsImageInput: true,
    maxImagesPerJob: 4,
    defaultAspectRatio: "1:1",
    allowedAspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    fallbackUsdPerImage: 0.015,
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

function asFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeServerModels(models: readonly ImageGenerationServerCatalogModel[] | undefined): ImageGenerationServerCatalogModel[] {
  if (!Array.isArray(models)) return [];
  const out: ImageGenerationServerCatalogModel[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = String(model.id || "").trim();
    if (!id) continue;
    if (EXCLUDED_MODEL_IDS.has(id.toLowerCase())) continue;
    out.push({
      id,
      name: String(model.name || "").trim() || undefined,
      provider: String(model.provider || "").trim() || undefined,
      supports_generation: typeof model.supports_generation === "boolean" ? model.supports_generation : undefined,
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
      estimated_cost_per_image_usd: asFinitePositiveNumber(model.estimated_cost_per_image_usd) ?? undefined,
      estimated_cost_per_image_low_usd: asFinitePositiveNumber(model.estimated_cost_per_image_low_usd) ?? undefined,
      estimated_cost_per_image_high_usd: asFinitePositiveNumber(model.estimated_cost_per_image_high_usd) ?? undefined,
      pricing_source: String(model.pricing_source || "").trim() || undefined,
    });
  }
  return out;
}

function mergeStringArrays(preferred?: readonly string[], fallback?: readonly string[]): string[] | undefined {
  const merged = dedupeAspectRatios([...(preferred || []), ...(fallback || [])]);
  return merged.length > 0 ? merged : undefined;
}

function mergeServerCatalogModel(
  preferred: ImageGenerationServerCatalogModel,
  fallback: ImageGenerationServerCatalogModel
): ImageGenerationServerCatalogModel {
  const preferredMax =
    typeof preferred.max_images_per_job === "number" && Number.isFinite(preferred.max_images_per_job)
      ? Math.max(1, Math.floor(preferred.max_images_per_job))
      : undefined;
  const fallbackMax =
    typeof fallback.max_images_per_job === "number" && Number.isFinite(fallback.max_images_per_job)
      ? Math.max(1, Math.floor(fallback.max_images_per_job))
      : undefined;

  return {
    id: preferred.id,
    name: preferred.name || fallback.name,
    provider: preferred.provider || fallback.provider,
    supports_generation:
      typeof preferred.supports_generation === "boolean"
        ? preferred.supports_generation
        : typeof fallback.supports_generation === "boolean"
          ? fallback.supports_generation
          : undefined,
    input_modalities: mergeStringArrays(preferred.input_modalities, fallback.input_modalities),
    output_modalities: mergeStringArrays(preferred.output_modalities, fallback.output_modalities),
    supports_image_input:
      typeof preferred.supports_image_input === "boolean"
        ? preferred.supports_image_input
        : typeof fallback.supports_image_input === "boolean"
          ? fallback.supports_image_input
          : undefined,
    max_images_per_job: preferredMax ?? fallbackMax,
    default_aspect_ratio: preferred.default_aspect_ratio || fallback.default_aspect_ratio,
    allowed_aspect_ratios: mergeStringArrays(preferred.allowed_aspect_ratios, fallback.allowed_aspect_ratios),
    estimated_cost_per_image_usd:
      asFinitePositiveNumber(preferred.estimated_cost_per_image_usd) ??
      asFinitePositiveNumber(fallback.estimated_cost_per_image_usd) ??
      undefined,
    estimated_cost_per_image_low_usd:
      asFinitePositiveNumber(preferred.estimated_cost_per_image_low_usd) ??
      asFinitePositiveNumber(fallback.estimated_cost_per_image_low_usd) ??
      undefined,
    estimated_cost_per_image_high_usd:
      asFinitePositiveNumber(preferred.estimated_cost_per_image_high_usd) ??
      asFinitePositiveNumber(fallback.estimated_cost_per_image_high_usd) ??
      undefined,
    pricing_source: preferred.pricing_source || fallback.pricing_source,
  };
}

function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safe >= 1) return safe.toFixed(2);
  if (safe >= 0.1) return safe.toFixed(3);
  if (safe >= 0.01) return safe.toFixed(3);
  return safe.toFixed(4);
}

function formatCredits(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safe >= 100) return String(Math.round(safe));
  if (safe >= 10) return safe.toFixed(1).replace(/\.0$/, "");
  return safe.toFixed(2).replace(/\.?0+$/, "");
}

function supportsImageInput(serverModel: ImageGenerationServerCatalogModel): boolean {
  if (typeof serverModel.supports_image_input === "boolean") {
    return serverModel.supports_image_input;
  }
  const modalities = Array.isArray(serverModel.input_modalities) ? serverModel.input_modalities : [];
  return modalities.some((value) => String(value || "").trim().toLowerCase() === "image");
}

function buildImagePricing(
  serverModel?: ImageGenerationServerCatalogModel,
  curatedFallbackUsdPerImage?: number
): ImagePricing {
  const lowUsd =
    asFinitePositiveNumber(serverModel?.estimated_cost_per_image_low_usd) ??
    asFinitePositiveNumber(serverModel?.estimated_cost_per_image_usd) ??
    asFinitePositiveNumber(curatedFallbackUsdPerImage);
  const highUsd =
    asFinitePositiveNumber(serverModel?.estimated_cost_per_image_high_usd) ??
    asFinitePositiveNumber(serverModel?.estimated_cost_per_image_usd) ??
    asFinitePositiveNumber(curatedFallbackUsdPerImage);
  if (lowUsd === null || highUsd === null) {
    return {
      summary: "Pricing unavailable",
      lines: ["Could not derive a per-image provider price from current catalog metadata."],
      usdPerImageAverage: null,
      usdPerImageLow: null,
      usdPerImageHigh: null,
      creditsPerImageAverage: null,
      creditsPerImageLow: null,
      creditsPerImageHigh: null,
      source: String(serverModel?.pricing_source || "missing_price_metadata"),
    };
  }

  const avgUsd = (lowUsd + highUsd) / 2;
  const lowCredits = lowUsd * IMAGE_GENERATION_EFFECTIVE_CREDITS_PER_USD;
  const highCredits = highUsd * IMAGE_GENERATION_EFFECTIVE_CREDITS_PER_USD;
  const avgCredits = avgUsd * IMAGE_GENERATION_EFFECTIVE_CREDITS_PER_USD;
  const isRange = Math.abs(highUsd - lowUsd) > 1e-12;
  const usdSummary = isRange
    ? `$${formatUsd(lowUsd)}-$${formatUsd(highUsd)}/img`
    : `$${formatUsd(avgUsd)}/img`;
  const creditsSummary = isRange
    ? `${formatCredits(lowCredits)}-${formatCredits(highCredits)} cr/img`
    : `${formatCredits(avgCredits)} cr/img`;
  const source = String(serverModel?.pricing_source || "curated_fallback").trim() || "curated_fallback";
  const rangeLine = isRange
    ? `Provider price range: $${formatUsd(lowUsd)}-$${formatUsd(highUsd)} per output image (avg $${formatUsd(avgUsd)}).`
    : `Provider price: $${formatUsd(avgUsd)} per output image.`;

  return {
    summary: `${usdSummary} • ${creditsSummary}`,
    lines: [
      rangeLine,
      `Estimated SystemSculpt credits: ${formatCredits(avgCredits)} credits/image on average.`,
      `Formula: raw_usd × ${IMAGE_GENERATION_BILLING_MARKUP_MULTIPLIER} × ${IMAGE_GENERATION_BILLING_CREDITS_PER_USD} (= ${IMAGE_GENERATION_EFFECTIVE_CREDITS_PER_USD} credits/USD).`,
      `Price source: ${source}.`,
    ],
    usdPerImageAverage: avgUsd,
    usdPerImageLow: lowUsd,
    usdPerImageHigh: highUsd,
    creditsPerImageAverage: avgCredits,
    creditsPerImageLow: lowCredits,
    creditsPerImageHigh: highCredits,
    source,
  };
}

function toCuratedModel(
  seed: CuratedImageGenerationModelSeed,
  serverModel: ImageGenerationServerCatalogModel | undefined,
  catalogHasServerData: boolean
): ImageGenerationCuratedModel {
  const mergedAllowed = dedupeAspectRatios([
    ...(Array.isArray(serverModel?.allowed_aspect_ratios) ? serverModel!.allowed_aspect_ratios! : []),
    ...seed.allowedAspectRatios,
  ]);
  const defaultAspectCandidate = String(serverModel?.default_aspect_ratio || "").trim() || seed.defaultAspectRatio;
  const defaultAspectRatio = mergedAllowed.includes(defaultAspectCandidate) ? defaultAspectCandidate : seed.defaultAspectRatio;

  return {
    id: seed.id,
    label: seed.label,
    provider: String(serverModel?.provider || "").trim() || seed.provider,
    supportsGeneration: catalogHasServerData
      ? Boolean(serverModel && (serverModel.supports_generation !== false))
      : true,
    supportsImageInput: (serverModel ? supportsImageInput(serverModel) : false) || seed.supportsImageInput,
    maxImagesPerJob:
      typeof serverModel?.max_images_per_job === "number" && Number.isFinite(serverModel.max_images_per_job)
        ? Math.max(1, Math.floor(serverModel.max_images_per_job))
        : seed.maxImagesPerJob,
    defaultAspectRatio,
    allowedAspectRatios: mergedAllowed.length > 0 ? mergedAllowed : seed.allowedAspectRatios,
    pricing: buildImagePricing(serverModel, seed.fallbackUsdPerImage),
  };
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
    supportsGeneration: serverModel.supports_generation === true,
    supportsImageInput: supportsImageInput(serverModel),
    maxImagesPerJob: Math.max(1, Math.floor(serverModel.max_images_per_job || 1)),
    defaultAspectRatio,
    allowedAspectRatios: allowedAspectRatios.length > 0 ? allowedAspectRatios : [...COMMON_IMAGE_ASPECT_RATIOS],
    pricing: buildImagePricing(serverModel),
  };
}

export function mergeImageGenerationServerCatalogModels(
  preferredModels?: readonly ImageGenerationServerCatalogModel[],
  supplementalModels?: readonly ImageGenerationServerCatalogModel[]
): ImageGenerationServerCatalogModel[] {
  const preferred = normalizeServerModels(preferredModels).map((model) => ({
    ...model,
    supports_generation: model.supports_generation !== false,
  }));
  const supplemental = normalizeServerModels(supplementalModels).map((model) => ({
    ...model,
    supports_generation: model.supports_generation === true,
  }));
  const byId = new Map<string, ImageGenerationServerCatalogModel>();

  for (const model of supplemental) {
    byId.set(model.id, model);
  }

  for (const model of preferred) {
    const existing = byId.get(model.id);
    if (!existing) {
      byId.set(model.id, model);
      continue;
    }
    byId.set(model.id, mergeServerCatalogModel(model, existing));
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aLabel = String(a.name || a.id);
    const bLabel = String(b.name || b.id);
    return aLabel.localeCompare(bLabel);
  });
}

export function resolveImageGenerationModelCatalog(
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): ImageGenerationCuratedModel[] {
  const normalizedServer = normalizeServerModels(serverModels);
  const hasServerData = normalizedServer.length > 0;
  const byServerId = new Map<string, ImageGenerationServerCatalogModel>();
  for (const model of normalizedServer) {
    byServerId.set(model.id, model);
  }

  const mergedCurated = CURATED_IMAGE_GENERATION_MODELS_SEED.map((seed) =>
    toCuratedModel(seed, byServerId.get(seed.id), hasServerData)
  );
  const curatedIds = new Set(mergedCurated.map((model) => model.id));
  const serverOnly = normalizedServer
    .filter((model) => !curatedIds.has(model.id))
    .map((model) => toServerOnlyModel(model))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...mergedCurated, ...serverOnly];
}

export const CURATED_IMAGE_GENERATION_MODELS: readonly ImageGenerationCuratedModel[] = resolveImageGenerationModelCatalog();

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
  return summary ? `${model.label}  ${summary}` : model.label;
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
