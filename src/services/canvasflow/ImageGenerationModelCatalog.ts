export const IMAGE_GENERATION_PRICING_SNAPSHOT_DATE = "2026-02-16" as const;

export const DEFAULT_IMAGE_GENERATION_MODEL_ID = "openai/gpt-5-image-mini" as const;

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

export function getCuratedImageGenerationModel(id: string): ImageGenerationCuratedModel | null {
  const key = String(id || "").trim();
  if (!key) return null;
  return (CURATED_IMAGE_GENERATION_MODELS as readonly ImageGenerationCuratedModel[]).find((model) => model.id === key) || null;
}

export function getCuratedImageGenerationModelGroups(): { provider: string; models: ImageGenerationCuratedModel[] }[] {
  const byProvider = new Map<string, ImageGenerationCuratedModel[]>();
  for (const model of CURATED_IMAGE_GENERATION_MODELS as readonly ImageGenerationCuratedModel[]) {
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
