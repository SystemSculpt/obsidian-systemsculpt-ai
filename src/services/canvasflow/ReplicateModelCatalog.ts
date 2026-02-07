export const REPLICATE_PRICING_SNAPSHOT_DATE = "2026-02-07" as const;

export type ReplicateImageInputSpec =
  | { kind: "none" }
  | { kind: "single"; key: string }
  | { kind: "array"; key: string };

export type ReplicateModelPricing = {
  /**
   * Short, UI-friendly summary (e.g. "$0.039/img", "$0.015/run + $0.015/MP").
   * Snapshot from the Replicate model page, as of REPLICATE_PRICING_SNAPSHOT_DATE.
   */
  summary: string;
  /**
   * Detailed rows from the Replicate model page `#pricing` section.
   * This is intentionally not a parsed schema: the website can add tiers/criteria.
   */
  lines: string[];
};

export type ReplicateCuratedModel = {
  slug: string; // owner/name
  label: string; // human-friendly
  provider: string; // grouping label
  /**
   * Proxy for "release date": `latest_version.created_at` from Replicate API.
   */
  latestVersionCreatedAt: string; // ISO
  /**
   * Primary image input mapping used by CanvasFlow when a prompt node has an incoming image.
   * Notes can always override by setting `ss_replicate_image_key` and/or seeding `ss_replicate_input[key]=[]`.
   */
  imageInput: ReplicateImageInputSpec;
  pricing: ReplicateModelPricing;
};

/**
 * Curated image-generation and image-editing models for CanvasFlow.
 *
 * This list is intentionally hardcoded for UX quality and stability:
 * - Only "newest gen" models (no legacy versions) per product preference.
 * - Pricing is scraped from replicate.com model pages, because the public API does not expose billing.
 *
 * Update workflow: use the Codex skill `systemsculpt-replicate-catalog`.
 */
export const REPLICATE_CURATED_IMAGE_MODELS: readonly ReplicateCuratedModel[] = [
  {
    slug: "google/imagen-4-fast",
    label: "Imagen 4 Fast",
    provider: "Google",
    latestVersionCreatedAt: "2026-01-30T23:32:16.090850Z",
    imageInput: { kind: "none" },
    pricing: {
      summary: "$0.02/img",
      lines: [
        "$0.02 per output image (output image) - or 50 images for $1",
      ],
    },
  },
  {
    slug: "google/imagen-4",
    label: "Imagen 4",
    provider: "Google",
    latestVersionCreatedAt: "2026-01-30T23:37:18.252523Z",
    imageInput: { kind: "none" },
    pricing: {
      summary: "$0.04/img",
      lines: [
        "$0.04 per output image (output image) - or 25 images for $1",
      ],
    },
  },
  {
    slug: "google/imagen-4-ultra",
    label: "Imagen 4 Ultra",
    provider: "Google",
    latestVersionCreatedAt: "2026-01-30T23:33:32.427505Z",
    imageInput: { kind: "none" },
    pricing: {
      summary: "$0.06/img",
      lines: [
        "$0.06 per output image (output image) - or around 16 images for $1",
      ],
    },
  },
  {
    slug: "google/gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "Google",
    latestVersionCreatedAt: "2026-01-30T22:18:21.426357Z",
    imageInput: { kind: "array", key: "image_input" },
    pricing: {
      summary: "$0.039/img",
      lines: [
        "$0.039 per output image (output image) - or around 25 images for $1",
      ],
    },
  },
  {
    slug: "google/nano-banana",
    label: "Nano Banana (Flash)",
    provider: "Google",
    latestVersionCreatedAt: "2026-02-06T04:33:54.610363Z",
    imageInput: { kind: "array", key: "image_input" },
    pricing: {
      summary: "$0.039/img",
      lines: [
        "$0.039 per output image (output image) - or around 25 images for $1",
      ],
    },
  },
  {
    slug: "google/nano-banana-pro",
    label: "Nano Banana Pro",
    provider: "Google",
    latestVersionCreatedAt: "2026-02-06T04:44:40.531384Z",
    imageInput: { kind: "array", key: "image_input" },
    pricing: {
      summary: "$0.15-$0.30/img",
      lines: [
        "$0.15 per output image (output image) - or around 66 images for $10",
        "$0.30 per output image (output image) - or around 33 images for $10",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-2-pro",
    label: "FLUX.2 Pro",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-11-26T13:51:43.495566Z",
    imageInput: { kind: "array", key: "input_images" },
    pricing: {
      summary: "$0.015/run + $0.015/MP",
      lines: [
        "$0.015 per run (run) - or around 66 runs for $1",
        "$0.015 per input image megapixel (input image megapixel) - or around 66 megapixels for $1",
        "$0.015 per output image megapixel (output image megapixel) - or around 66 megapixels for $1",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-2-dev",
    label: "FLUX.2 Dev",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-11-24T21:49:19.384496Z",
    imageInput: { kind: "array", key: "input_images" },
    pricing: {
      summary: "$0.012-$0.014/MP",
      lines: [
        "$0.012 per input image megapixel (input image megapixel) - or around 83 megapixels for $1",
        "$0.012 per output image megapixel (output image megapixel) - or around 83 megapixels for $1",
        "$0.014 per input image megapixel (input image megapixel) - or around 71 megapixels for $1",
        "$0.014 per output image megapixel (output image megapixel) - or around 71 megapixels for $1",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-kontext-pro",
    label: "FLUX Kontext Pro",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-11-12T16:36:40.739821Z",
    imageInput: { kind: "single", key: "input_image" },
    pricing: {
      summary: "$0.04/img",
      lines: [
        "$0.04 per output image (output image) - or 25 images for $1",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-fill-pro",
    label: "FLUX Fill Pro",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-11-07T16:25:22.632942Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.05/img",
      lines: [
        "$0.05 per output image (output image) - or 20 images for $1",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-canny-pro",
    label: "FLUX Canny Pro",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-10-31T18:10:30.741664Z",
    imageInput: { kind: "single", key: "control_image" },
    pricing: {
      summary: "$0.05/img",
      lines: [
        "$0.05 per output image (output image) - or 20 images for $1",
      ],
    },
  },
  {
    slug: "black-forest-labs/flux-depth-pro",
    label: "FLUX Depth Pro",
    provider: "Flux 2",
    latestVersionCreatedAt: "2025-10-31T18:09:31.486222Z",
    imageInput: { kind: "single", key: "control_image" },
    pricing: {
      summary: "$0.05/img",
      lines: [
        "$0.05 per output image (output image) - or 20 images for $1",
      ],
    },
  },
  {
    slug: "stability-ai/stable-diffusion-3.5-large-turbo",
    label: "Stable Diffusion 3.5 Large Turbo",
    provider: "Stability AI",
    latestVersionCreatedAt: "2025-11-07T13:39:46.523703Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.04/img",
      lines: [
        "$0.04 per output image (output image) - or 25 images for $1",
      ],
    },
  },
  {
    slug: "stability-ai/stable-diffusion-3.5-medium",
    label: "Stable Diffusion 3.5 Medium",
    provider: "Stability AI",
    latestVersionCreatedAt: "2025-11-07T13:45:37.534741Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.035/img",
      lines: [
        "$0.035 per output image (output image) - or around 28 images for $1",
      ],
    },
  },
  {
    slug: "stability-ai/stable-diffusion-3.5-large",
    label: "Stable Diffusion 3.5 Large",
    provider: "Stability AI",
    latestVersionCreatedAt: "2025-11-07T13:39:56.429614Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.065/img",
      lines: [
        "$0.065 per output image (output image) - or around 15 images for $1",
      ],
    },
  },
  {
    slug: "ideogram-ai/ideogram-v3-turbo",
    label: "Ideogram v3 Turbo",
    provider: "Ideogram",
    latestVersionCreatedAt: "2025-11-07T14:22:40.707404Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.03/img",
      lines: [
        "$0.03 per output image (output image) - or around 33 images for $1",
      ],
    },
  },
  {
    slug: "ideogram-ai/ideogram-v3-balanced",
    label: "Ideogram v3 Balanced",
    provider: "Ideogram",
    latestVersionCreatedAt: "2025-11-07T14:14:50.330589Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.06/img",
      lines: [
        "$0.06 per output image (output image) - or around 16 images for $1",
      ],
    },
  },
  {
    slug: "ideogram-ai/ideogram-v3-quality",
    label: "Ideogram v3 Quality",
    provider: "Ideogram",
    latestVersionCreatedAt: "2025-11-07T14:14:56.485854Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.09/img",
      lines: [
        "$0.09 per output image (output image) - or around 11 images for $1",
      ],
    },
  },
  {
    slug: "recraft-ai/recraft-v3",
    label: "Recraft v3",
    provider: "Recraft",
    latestVersionCreatedAt: "2025-11-07T14:35:30.077887Z",
    imageInput: { kind: "none" },
    pricing: {
      summary: "$0.04/img",
      lines: [
        "$0.04 per output image (output image) - or 25 images for $1",
      ],
    },
  },
  {
    slug: "bytedance/seedream-4.5",
    label: "Seedream 4.5",
    provider: "Seedream",
    latestVersionCreatedAt: "2025-12-04T14:47:32.322268Z",
    imageInput: { kind: "array", key: "image_input" },
    pricing: {
      summary: "$0.04/img",
      lines: [
        "$0.04 per output image (output image) - or 25 images for $1",
      ],
    },
  },
  {
    slug: "qwen/qwen-image",
    label: "Qwen Image",
    provider: "Qwen",
    latestVersionCreatedAt: "2026-01-20T16:48:29.924296Z",
    imageInput: { kind: "single", key: "image" },
    pricing: {
      summary: "$0.025/img",
      lines: [
        "$0.025 per output image (output image) - or 40 images for $1",
      ],
    },
  },
  {
    slug: "qwen/qwen-image-edit-plus",
    label: "Qwen Image Edit Plus",
    provider: "Qwen",
    latestVersionCreatedAt: "2025-09-23T17:17:06.212320Z",
    imageInput: { kind: "array", key: "image" },
    pricing: {
      summary: "$0.03/img",
      lines: [
        "$0.03 per output image (output image) - or around 33 images for $1",
      ],
    },
  },
  {
    slug: "xai/grok-2-image",
    label: "Grok 2 Image",
    provider: "xAI",
    latestVersionCreatedAt: "2025-10-14T21:42:31.036985Z",
    imageInput: { kind: "none" },
    pricing: {
      summary: "$0.07/img",
      lines: [
        "$0.07 per output image (output image) - or around 14 images for $1",
      ],
    },
  },
  {
    slug: "runwayml/gen4-image-turbo",
    label: "Runway Gen4 Image Turbo",
    provider: "Runway",
    latestVersionCreatedAt: "2025-11-07T13:38:20.658157Z",
    imageInput: { kind: "array", key: "reference_images" },
    pricing: {
      summary: "$0.03/img",
      lines: [
        "$0.03 per output image (output image) - or around 33 images for $1",
      ],
    },
  },
  {
    slug: "runwayml/gen4-image",
    label: "Runway Gen4 Image",
    provider: "Runway",
    latestVersionCreatedAt: "2025-11-07T13:26:22.465244Z",
    imageInput: { kind: "array", key: "reference_images" },
    pricing: {
      summary: "$0.05-$0.08/img",
      lines: [
        "$0.05 per output image (output image) - or 20 images for $1",
        "$0.08 per output image (output image) - or around 12 images for $1",
      ],
    },
  },
] as const;

export function getCuratedReplicateModel(slug: string): ReplicateCuratedModel | null {
  const key = String(slug || "").trim();
  if (!key) return null;
  return (REPLICATE_CURATED_IMAGE_MODELS as readonly ReplicateCuratedModel[]).find((m) => m.slug === key) || null;
}

export function getCuratedReplicateModelGroups(): { provider: string; models: ReplicateCuratedModel[] }[] {
  const byProvider = new Map<string, ReplicateCuratedModel[]>();
  for (const m of REPLICATE_CURATED_IMAGE_MODELS as readonly ReplicateCuratedModel[]) {
    const group = String(m.provider || "").trim() || "Other";
    const existing = byProvider.get(group) || [];
    existing.push(m);
    byProvider.set(group, existing);
  }

  const sortedProviders = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));
  return sortedProviders.map((provider) => ({
    provider,
    models: (byProvider.get(provider) || []).slice().sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

export function formatCuratedModelOptionText(model: ReplicateCuratedModel): string {
  const summary = String(model.pricing?.summary || "").trim();
  return summary ? `${model.label} (${model.slug})  ${summary}` : `${model.label} (${model.slug})`;
}

export function getEffectiveReplicateImageInputSpec(options: {
  modelSlug: string;
  replicateImageKey: string;
  hasExplicitImageKey: boolean;
  replicateInput: Record<string, unknown>;
}): ReplicateImageInputSpec {
  const modelSlug = String(options.modelSlug || "").trim();
  const configuredKey = String(options.replicateImageKey || "").trim() || "image";
  const entry = getCuratedReplicateModel(modelSlug);

  if (options.hasExplicitImageKey) {
    // If the explicit key matches the curated entry, keep the curated kind (array vs single vs none).
    if (entry && entry.imageInput.kind !== "none" && (entry.imageInput as any).key === configuredKey) {
      return entry.imageInput;
    }

    // If the user seeded an array in ss_replicate_input, treat it as an array input.
    if (Array.isArray((options.replicateInput as any)?.[configuredKey])) {
      return { kind: "array", key: configuredKey };
    }

    // Historical compatibility: `image_input` is array in official Google models.
    if (configuredKey === "image_input") {
      return { kind: "array", key: configuredKey };
    }

    return { kind: "single", key: configuredKey };
  }

  if (entry) {
    return entry.imageInput;
  }

  return { kind: "single", key: configuredKey };
}
