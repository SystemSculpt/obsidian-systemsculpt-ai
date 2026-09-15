import type { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";

export type ManagedVideoModelEstimate = Readonly<{
  resolution: string;
  generateAudio: boolean;
  durationSeconds: number;
  estimatedCredits: number;
  /** Present when attaching a frame image changes the price. */
  estimatedCreditsWithFrameImage?: number;
}>;

export type ManagedVideoModel = Readonly<{
  id: string;
  name: string;
  provider: string;
  description: string;
  supportsSeed: boolean;
  supportsAudioToggle: boolean;
  defaultGenerateAudio: boolean;
  supportedFrameRoles: readonly ("first_frame" | "last_frame")[];
  defaultResolution: string;
  resolutions: readonly string[];
  defaultAspectRatio: string;
  aspectRatios: readonly string[];
  defaultDurationSeconds: number;
  durationsSeconds: readonly number[];
  estimates: readonly ManagedVideoModelEstimate[];
  typicalDurationMs: number | null;
  /** ISO day the model was published upstream, when the service knows it. */
  releasedAt?: string;
  inputModalities: readonly string[];
}>;

export type ManagedVideoModelCatalogSnapshot = Readonly<{ models: readonly ManagedVideoModel[] }>;

const MODEL_ID_PATTERN = /^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9./_:-]{0,159}$/;
const CATALOG_TTL_MS = 5 * 60_000;
function releasedAt(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : undefined;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid video model catalog.");
  return value as Record<string, unknown>;
};
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid video model catalog text.");
  return value;
}
function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid video model options.");
  return value.map(entry => text(entry, max));
}
function positiveInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error("Invalid video model number.");
  return value as number;
}
function credits(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid video credit estimate.");
  return value;
}
function estimate(value: unknown): ManagedVideoModelEstimate {
  const row = record(value);
  return Object.freeze({
    resolution: text(row.resolution, 16),
    generateAudio: row.generate_audio === true,
    durationSeconds: positiveInteger(row.duration_seconds, 3_600),
    estimatedCredits: credits(row.estimated_credits),
    ...(row.estimated_credits_with_frame_image === undefined ? {} : { estimatedCreditsWithFrameImage: credits(row.estimated_credits_with_frame_image) }),
  });
}

function parseModel(raw: unknown, ids: Set<string>): ManagedVideoModel | null {
  const model = record(raw);
  const id = text(model.id, 160);
  if (!id || !MODEL_ID_PATTERN.test(id) || ids.has(id)) throw new Error("Invalid video model identity.");
  ids.add(id);
  if (model.billing_supported === false) return null;
  const roles = strings(model.supported_frame_roles ?? [], 16);
  if (roles.some(role => role !== "first_frame" && role !== "last_frame")) throw new Error("Invalid video frame roles.");
  const durations = model.allowed_durations_seconds;
  if (!Array.isArray(durations) || durations.length > 128) throw new Error("Invalid video durations.");
  const estimates = model.estimates;
  if (!Array.isArray(estimates) || estimates.length < 1 || estimates.length > 4096) throw new Error("Invalid video estimates.");
  // A progress hint must never take a model off the menu: anything outside a
  // sane range degrades to "unknown" instead of failing the catalog.
  const typical = model.typical_duration_ms;
  const typicalDurationMs = Number.isSafeInteger(typical) && (typical as number) > 0 && (typical as number) <= 86_400_000 ? typical as number : null;
  const released = releasedAt(model.released_at);
  return Object.freeze({
    id,
    name: text(model.name, 200),
    provider: typeof model.provider === "string" ? text(model.provider, 200) : "",
    description: text(model.best_for, 512),
    supportsSeed: model.supports_seed === true,
    supportsAudioToggle: model.supports_audio_toggle === true,
    defaultGenerateAudio: model.default_generate_audio === true,
    supportedFrameRoles: Object.freeze(roles as ("first_frame" | "last_frame")[]),
    defaultResolution: text(model.default_resolution, 16),
    resolutions: Object.freeze(strings(model.allowed_resolutions, 16)),
    defaultAspectRatio: text(model.default_aspect_ratio, 32),
    aspectRatios: Object.freeze(strings(model.allowed_aspect_ratios, 32)),
    defaultDurationSeconds: positiveInteger(model.default_duration_seconds, 3_600),
    durationsSeconds: Object.freeze(durations.map(entry => positiveInteger(entry, 3_600))),
    estimates: Object.freeze(estimates.map(estimate)),
    typicalDurationMs,
    ...(released ? { releasedAt: released } : {}),
    inputModalities: Object.freeze(Array.isArray(model.input_modalities) ? strings(model.input_modalities, 32) : ["text"]),
  });
}

/**
 * Server-owned discovery for `/api/plugin/videos/models`. Unknown additive
 * fields are ignored. Models the server marks unbillable are dropped, and a
 * model whose entry does not parse is skipped rather than blanking the whole
 * picker; only a wrong contract or a duplicate identity rejects the catalog.
 */
export function parseManagedVideoModelCatalog(value: unknown): ManagedVideoModelCatalogSnapshot {
  const body = record(value);
  if (body.contract !== "systemsculpt-media-models-v1" || !Array.isArray(body.models) || body.models.length > 512) {
    throw new Error("The video model catalog is unavailable. Refresh and try again.");
  }
  const ids = new Set<string>();
  const models: ManagedVideoModel[] = [];
  for (const raw of body.models) {
    let model: ManagedVideoModel | null;
    try {
      model = parseModel(raw, ids);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid video model identity.") throw error;
      continue;
    }
    if (model) models.push(model);
  }
  return Object.freeze({ models: Object.freeze(models) });
}

/** The published price for one selectable combination, or null when the model does not quote it. */
export function findManagedVideoEstimate(
  model: ManagedVideoModel,
  selection: { resolution: string; generateAudio: boolean; durationSeconds: number },
): ManagedVideoModelEstimate | null {
  return model.estimates.find(row =>
    row.resolution === selection.resolution
    && row.generateAudio === selection.generateAudio
    && row.durationSeconds === selection.durationSeconds,
  ) ?? null;
}

export type ManagedVideoRequestOptions = Readonly<{
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
}>;

/**
 * Saved Studio configs go stale when a model's allowed options change
 * server-side, and the server hard-rejects unsupported combinations. Snap
 * unsupported selections to the model's own defaults (durations to the
 * nearest allowed value) so old projects keep running.
 */
export function snapManagedVideoRequestToModel(model: ManagedVideoModel, options: ManagedVideoRequestOptions): ManagedVideoRequestOptions {
  const snapped: { -readonly [K in keyof ManagedVideoRequestOptions]: ManagedVideoRequestOptions[K] } = { ...options };
  if (snapped.resolution !== undefined && model.resolutions.length > 0 && !model.resolutions.includes(snapped.resolution)) {
    snapped.resolution = model.defaultResolution;
  }
  if (snapped.aspectRatio !== undefined && model.aspectRatios.length > 0 && !model.aspectRatios.includes(snapped.aspectRatio)) {
    snapped.aspectRatio = model.defaultAspectRatio;
  }
  const requested = snapped.durationSeconds;
  if (requested !== undefined && model.durationsSeconds.length > 0 && !model.durationsSeconds.includes(requested)) {
    snapped.durationSeconds = [...model.durationsSeconds]
      .sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested) || a - b)[0];
  }
  if (snapped.generateAudio !== undefined && !model.supportsAudioToggle) {
    snapped.generateAudio = model.defaultGenerateAudio;
  }
  return snapped;
}

export type ManagedVideoModelCatalogOptions = Readonly<{
  /** Cached snapshots belong to one license; a key change drops them. */
  licenseKey?: () => string;
  now?: () => number;
}>;

export class ManagedVideoModelCatalog {
  private pending: Promise<ManagedVideoModelCatalogSnapshot> | undefined;
  private cached: { value: ManagedVideoModelCatalogSnapshot; expiresAt: number; license: string } | null = null;
  constructor(private readonly transport: Pick<HostedTransportAdapter, "request">, private readonly options: ManagedVideoModelCatalogOptions = {}) {}

  /** The last loaded snapshot while it is fresh, without a request; null before the first load. */
  peek(): ManagedVideoModelCatalogSnapshot | null {
    const cached = this.cached;
    if (!cached || cached.expiresAt <= this.now() || cached.license !== this.license()) return null;
    return cached.value;
  }

  async load(): Promise<ManagedVideoModelCatalogSnapshot> {
    const fresh = this.peek();
    if (fresh) return fresh;
    // Deduplicate simultaneous pickers; a short cache keeps card rendering
    // synchronous without holding another license's catalog or a stale price.
    if (this.pending) return this.pending;
    this.pending = this.read();
    try {
      const value = await this.pending;
      this.cached = { value, expiresAt: this.now() + CATALOG_TTL_MS, license: this.license() };
      return value;
    } finally { this.pending = undefined; }
  }

  invalidate(): void { this.cached = null; }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private license(): string { return this.options.licenseKey?.() ?? ""; }

  private async read(): Promise<ManagedVideoModelCatalogSnapshot> {
    const result = await this.transport.request({ path: "/api/plugin/videos/models", method: "GET" });
    if (!result.response.ok) throw new Error(`Video models are unavailable (${result.response.status}). Check your license and connection.`);
    return parseManagedVideoModelCatalog(await result.response.json());
  }
}
