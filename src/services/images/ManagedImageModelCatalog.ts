import type { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";

export type ManagedImageSizeEstimate = Readonly<{ imageSize: string; estimatedCredits: number }>;

export type ManagedImageModel = Readonly<{
  id: string;
  name: string;
  provider: string;
  description: string;
  isDefault: boolean;
  /** The model accepts reference images for image-to-image work. */
  supportsImageInput: boolean;
  /** Reference images the model accepts per job; 0 for text-only models. */
  maxInputReferences: number;
  supportsSeed: boolean;
  estimatedCredits: number;
  reservationCredits?: number;
  maxImages: number;
  aspectRatios: readonly string[];
  imageSizes: readonly string[];
  qualities: readonly string[];
  /** Per-size prices for models with size tiers; providers charge more for larger images. */
  sizeEstimates: readonly ManagedImageSizeEstimate[];
  /** ISO day (YYYY-MM-DD) the model was published upstream, when known. */
  releasedAt: string | null;
  typicalDurationMs: number | null;
  inputModalities: readonly string[];
}>;

export type ManagedImageModelCatalogSnapshot = Readonly<{ defaultModelId: string; models: readonly ManagedImageModel[] }>;

const CACHE_TTL_MS = 5 * 60_000;
const MODEL_ID_PATTERN = /^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9./_:-]{0,159}$/;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid image model catalog.");
  return value as Record<string, unknown>;
};
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid image model catalog text.");
  return value;
}
function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid image model options.");
  return value.map(entry => text(entry, max));
}
function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error("Invalid image credit estimate.");
  return value as number;
}
function providerFromId(id: string): string {
  const prefix = id.split("/")[0] || "Provider";
  return prefix.split(/[-_]/g).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function releasedAt(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}
function typicalDuration(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 86_400_000 ? value as number : null;
}

/** The server's per-model input schema names the reference-image input and its cap. */
function referenceLimit(schema: Record<string, unknown> | undefined, supportsImageInput: boolean): number {
  const inputs = Array.isArray(schema?.inputs) ? schema.inputs : [];
  for (const raw of inputs) {
    const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const port = input?.port && typeof input.port === "object" ? input.port as Record<string, unknown> : null;
    if (input?.route !== "reference" || port?.id !== "reference_images") continue;
    const max = input.maxItems;
    return Number.isSafeInteger(max) && (max as number) >= 1 ? Math.min(16, max as number) : 4;
  }
  return supportsImageInput ? 4 : 0;
}

function parseModel(raw: unknown, ids: Set<string>, defaultModelId: string): ManagedImageModel {
  const model = record(raw);
  const id = text(model.id, 160);
  if (!id || !MODEL_ID_PATTERN.test(id) || ids.has(id)) throw new Error("Invalid image model identity.");
  ids.add(id);
  const schema = model.input_schema ? record(model.input_schema) : undefined;
  const inputs = schema?.inputs;
  if (inputs !== undefined && (!Array.isArray(inputs) || inputs.length > 96)) throw new Error("Invalid image input schema.");
  const quality = (Array.isArray(inputs) ? inputs : []).map(record).find(input => input.parameterKey === "quality");
  const qualityField = quality?.configField ? record(quality.configField) : undefined;
  const qualities = qualityField?.options;
  const maxImages = positiveInteger(model.max_images_per_job);
  if (maxImages > 4) throw new Error("Unsupported image batch size.");
  const supportsImageInput = model.supports_image_input === true;
  const sizeEstimates: ManagedImageSizeEstimate[] = [];
  for (const raw of Array.isArray(model.estimates) ? model.estimates.slice(0, 32) : []) {
    const row = record(raw);
    const credits = row.estimated_cost_per_image_credits;
    if (typeof row.image_size !== "string" || !Number.isFinite(credits) || (credits as number) < 0) continue;
    sizeEstimates.push(Object.freeze({ imageSize: row.image_size, estimatedCredits: credits as number }));
  }
  return Object.freeze({
    id,
    name: text(model.name),
    provider: typeof model.provider === "string" && model.provider ? text(model.provider, 200) : providerFromId(id),
    description: text(model.best_for),
    isDefault: model.is_default === true || id === defaultModelId,
    supportsImageInput,
    maxInputReferences: referenceLimit(schema, supportsImageInput),
    supportsSeed: model.supports_seed === true,
    estimatedCredits: positiveInteger(model.estimated_cost_per_image_credits),
    ...(model.reservation_credits_per_image === undefined ? {} : { reservationCredits: positiveInteger(model.reservation_credits_per_image) }),
    maxImages,
    aspectRatios: Object.freeze(strings(model.allowed_aspect_ratios)),
    imageSizes: Object.freeze(strings(model.allowed_image_sizes)),
    qualities: Object.freeze(qualities === undefined ? [] : strings((Array.isArray(qualities) ? qualities : []).map(value => record(value).value))),
    sizeEstimates: Object.freeze(sizeEstimates),
    releasedAt: releasedAt(model.released_at),
    typicalDurationMs: typicalDuration(model.typical_duration_ms),
    inputModalities: Object.freeze(Array.isArray(model.input_modalities) ? strings(model.input_modalities, 32) : ["text"]),
  });
}

/**
 * Server-owned discovery. Unknown additive fields are ignored. A model whose
 * entry does not parse is skipped rather than blanking the picker; only a
 * wrong contract or a duplicate identity rejects the catalog.
 */
export function parseManagedImageModelCatalog(value: unknown): ManagedImageModelCatalogSnapshot {
  const body = record(value);
  if (body.contract !== "systemsculpt-media-models-v1" || !Array.isArray(body.models) || body.models.length > 512) {
    throw new Error("The image model catalog is unavailable. Refresh and try again.");
  }
  const defaultModelId = text(body.default_model_id, 160);
  const ids = new Set<string>();
  const models: ManagedImageModel[] = [];
  for (const raw of body.models) {
    try {
      models.push(parseModel(raw, ids, defaultModelId));
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid image model identity.") throw error;
    }
  }
  return Object.freeze({ defaultModelId, models: Object.freeze(models) });
}

export class ManagedImageModelCatalog {
  private pending: Promise<ManagedImageModelCatalogSnapshot> | undefined;
  private cached: { value: ManagedImageModelCatalogSnapshot; expiresAt: number } | null = null;
  constructor(private readonly transport: Pick<HostedTransportAdapter, "request">, private readonly now: () => number = () => Date.now()) {}

  /** The last catalog loaded within the cache window, for synchronous card rendering. */
  peek(): ManagedImageModelCatalogSnapshot | null {
    return this.cached && this.cached.expiresAt > this.now() ? this.cached.value : null;
  }

  invalidate(): void {
    this.cached = null;
  }

  async load(): Promise<ManagedImageModelCatalogSnapshot> {
    const cached = this.peek();
    if (cached) return cached;
    // Deduplicate simultaneous pickers; prices stay fresh across the short window.
    if (this.pending) return this.pending;
    this.pending = this.read();
    try {
      const value = await this.pending;
      this.cached = { value, expiresAt: this.now() + CACHE_TTL_MS };
      return value;
    } finally {
      this.pending = undefined;
    }
  }

  private async read(): Promise<ManagedImageModelCatalogSnapshot> {
    const result = await this.transport.request({ path: "/api/plugin/images/models", method: "GET" });
    if (!result.response.ok) throw new Error(`Image models are unavailable (${result.response.status}). Check your license and connection.`);
    return parseManagedImageModelCatalog(await result.response.json());
  }
}
