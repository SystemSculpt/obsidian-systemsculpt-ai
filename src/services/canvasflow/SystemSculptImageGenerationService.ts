import { Platform, requestUrl } from "obsidian";
import { API_BASE_URL, SYSTEMSCULPT_API_ENDPOINTS, SYSTEMSCULPT_API_HEADERS } from "../../constants/api";
import { resolveSystemSculptApiBaseUrl } from "../../utils/urlHelpers";
import { PlatformContext } from "../PlatformContext";

export type SystemSculptImageGenerationJobStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type SystemSculptImageGenerationModel = {
  id: string;
  name: string;
  provider: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_image_input?: boolean;
  max_images_per_job?: number;
  default_aspect_ratio?: string;
  allowed_aspect_ratios?: string[];
};

export type SystemSculptImageGenerationJob = {
  id: string;
  status: SystemSculptImageGenerationJobStatus;
  model: string;
  created_at: string;
  processing_started_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  attempt_count?: number;
};

export type SystemSculptImageGenerationOutput = {
  index: number;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  url: string;
  url_expires_in_seconds: number;
};

export type SystemSculptImageGenerationUsage = {
  provider: string;
  raw_usd: number | null;
  cost_source: string | null;
  estimated: boolean;
};

export type SystemSculptImageInput =
  | { type: "url"; url: string }
  | { type: "data_url"; data_url: string };

export type SystemSculptCreateGenerationJobRequest = {
  model?: string;
  prompt: string;
  input_images?: SystemSculptImageInput[];
  options?: {
    count?: number;
    aspect_ratio?: string;
    seed?: number;
  };
};

export type SystemSculptCreateGenerationJobResponse = {
  job: SystemSculptImageGenerationJob;
  poll_url?: string;
  idempotent_replay?: boolean;
};

export type SystemSculptGenerationJobResponse = {
  job: SystemSculptImageGenerationJob;
  outputs: SystemSculptImageGenerationOutput[];
  usage?: SystemSculptImageGenerationUsage;
};

type JsonRequestOptions = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type ArrayBufferRequestOptions = {
  method: "GET";
  headers?: Record<string, string>;
};

const SYSTEMSCULPT_IMAGE_REQUEST_TIMEOUT_MS = 60_000;

function safeJsonParse(text: string | undefined): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function preferredTransport(url: string): "fetch" | "requestUrl" {
  try {
    return PlatformContext.get().preferredTransport({ endpoint: url });
  } catch {
    return "requestUrl";
  }
}

function assertOk(status: number, body: any, fallbackMessage: string): void {
  if (status >= 200 && status < 300) {
    return;
  }

  const message =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : fallbackMessage;

  const error: any = new Error(message);
  error.status = status;
  error.data = body;
  throw error;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, Math.floor(ms));
  if (!delayMs) return;

  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeOutputs(raw: unknown): SystemSculptImageGenerationOutput[] {
  if (!Array.isArray(raw)) return [];
  const outputs: SystemSculptImageGenerationOutput[] = [];

  for (const item of raw) {
    const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!obj) continue;

    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    const mimeType = typeof obj.mime_type === "string" ? obj.mime_type.trim() : "";
    const index = typeof obj.index === "number" && Number.isFinite(obj.index) ? obj.index : outputs.length;
    const sizeBytes =
      typeof obj.size_bytes === "number" && Number.isFinite(obj.size_bytes) ? Math.max(0, Math.floor(obj.size_bytes)) : 0;
    const width = typeof obj.width === "number" && Number.isFinite(obj.width) ? Math.floor(obj.width) : null;
    const height = typeof obj.height === "number" && Number.isFinite(obj.height) ? Math.floor(obj.height) : null;
    const expires =
      typeof obj.url_expires_in_seconds === "number" && Number.isFinite(obj.url_expires_in_seconds)
        ? Math.max(0, Math.floor(obj.url_expires_in_seconds))
        : 0;

    if (!url) continue;
    outputs.push({
      index,
      mime_type: mimeType || "application/octet-stream",
      size_bytes: sizeBytes,
      width,
      height,
      url,
      url_expires_in_seconds: expires,
    });
  }

  return outputs.sort((a, b) => a.index - b.index);
}

export class SystemSculptImageGenerationService {
  private readonly baseUrl: string;
  private readonly licenseKey: string;

  constructor(options: { baseUrl?: string; licenseKey: string }) {
    this.baseUrl = resolveSystemSculptApiBaseUrl(options.baseUrl || API_BASE_URL);
    this.licenseKey = String(options.licenseKey || "").trim();
  }

  private endpoint(path: string): string {
    const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  private shouldAttachAuthHeaders(targetUrl: string): boolean {
    try {
      const target = new URL(targetUrl);
      const base = new URL(this.baseUrl);
      return target.origin === base.origin;
    } catch {
      return false;
    }
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey),
      ...(extra || {}),
    };
  }

  private async requestJson(url: string, options: JsonRequestOptions): Promise<{ status: number; json: any; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    const method = options.method;

    const viaFetch = async (): Promise<{ status: number; json: any; headers: Record<string, string> }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SYSTEMSCULPT_IMAGE_REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            ...headers,
            ...(options.body && !("Content-Type" in headers) ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body,
          signal: controller.signal,
        } as RequestInit);
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new Error(aborted ? "Image generation API request timed out." : "Image generation API request failed.");
      } finally {
        clearTimeout(timeout);
      }

      const text = await response.text();
      const json = safeJsonParse(text) ?? text;
      const headersOut: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersOut[key.toLowerCase()] = value;
      });

      assertOk(response.status, json, `Image generation API request failed: HTTP ${response.status}`);
      return { status: response.status, json, headers: headersOut };
    };

    const viaRequestUrl = async (): Promise<{ status: number; json: any; headers: Record<string, string> }> => {
      const response = await withTimeout(
        requestUrl({
          url,
          method,
          headers,
          body: options.body,
          throw: false,
        }),
        SYSTEMSCULPT_IMAGE_REQUEST_TIMEOUT_MS,
        "Image generation API request timed out."
      );

      const status = response.status || 0;
      const body = response.json ?? safeJsonParse(response.text) ?? response.text ?? null;
      const headersOut: Record<string, string> = {};
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") {
            headersOut[key.toLowerCase()] = value;
          }
        }
      }

      assertOk(status, body, `Image generation API request failed: HTTP ${status || 0}`);
      return { status, json: body, headers: headersOut };
    };

    const preferred = Platform.isMobileApp ? "requestUrl" : preferredTransport(url);
    if (preferred === "fetch") {
      try {
        return await viaFetch();
      } catch {
        return await viaRequestUrl();
      }
    }

    return await viaRequestUrl();
  }

  private async requestArrayBuffer(
    url: string,
    options: ArrayBufferRequestOptions
  ): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...(options.headers || {}) };

    const viaFetch = async (): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SYSTEMSCULPT_IMAGE_REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, { method: options.method, headers, signal: controller.signal } as RequestInit);
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new Error(aborted ? "Image download timed out." : "Image download request failed.");
      } finally {
        clearTimeout(timeout);
      }

      const arrayBuffer = await response.arrayBuffer();
      const headersOut: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersOut[key.toLowerCase()] = value;
      });

      if (!response.ok) {
        const error: any = new Error(`Image download failed: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return { status: response.status, arrayBuffer, headers: headersOut };
    };

    const viaRequestUrl = async (): Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> => {
      const response = await withTimeout(
        requestUrl({
          url,
          method: options.method,
          headers,
          throw: false,
        }),
        SYSTEMSCULPT_IMAGE_REQUEST_TIMEOUT_MS,
        "Image download timed out."
      );

      const status = response.status || 0;
      if (status < 200 || status >= 300) {
        const error: any = new Error(`Image download failed: HTTP ${status || 0}`);
        error.status = status;
        throw error;
      }

      const headersOut: Record<string, string> = {};
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") {
            headersOut[key.toLowerCase()] = value;
          }
        }
      }

      const buffer = response.arrayBuffer;
      if (buffer instanceof ArrayBuffer) {
        return { status, arrayBuffer: buffer, headers: headersOut };
      }

      if (typeof response.text === "string") {
        const encoded = new TextEncoder().encode(response.text);
        return { status, arrayBuffer: encoded.buffer, headers: headersOut };
      }

      throw new Error("Image download failed: empty body");
    };

    const preferred = Platform.isMobileApp ? "requestUrl" : preferredTransport(url);
    if (preferred === "fetch") {
      try {
        return await viaFetch();
      } catch {
        return await viaRequestUrl();
      }
    }

    return await viaRequestUrl();
  }

  async listModels(): Promise<{ contract?: string; provider?: string; models: SystemSculptImageGenerationModel[] }> {
    const url = this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.IMAGES.MODELS);
    const { json } = await this.requestJson(url, {
      method: "GET",
      headers: this.authHeaders(),
    });

    const modelsRaw = Array.isArray(json?.models) ? (json.models as unknown[]) : [];
    const models: SystemSculptImageGenerationModel[] = [];
    for (const item of modelsRaw) {
      const model = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      if (!model) continue;

      const id = typeof model.id === "string" ? model.id.trim() : "";
      const name = typeof model.name === "string" ? model.name.trim() : "";
      if (!id || !name) continue;

      models.push({
        id,
        name,
        provider: typeof model.provider === "string" ? model.provider : "openrouter",
        input_modalities: Array.isArray(model.input_modalities) ? model.input_modalities.map(String) : undefined,
        output_modalities: Array.isArray(model.output_modalities) ? model.output_modalities.map(String) : undefined,
        supports_image_input: typeof model.supports_image_input === "boolean" ? model.supports_image_input : undefined,
        max_images_per_job:
          typeof model.max_images_per_job === "number" && Number.isFinite(model.max_images_per_job)
            ? Math.max(1, Math.floor(model.max_images_per_job))
            : undefined,
        default_aspect_ratio: typeof model.default_aspect_ratio === "string" ? model.default_aspect_ratio : undefined,
        allowed_aspect_ratios: Array.isArray(model.allowed_aspect_ratios)
          ? model.allowed_aspect_ratios.map(String)
          : undefined,
      });
    }

    return {
      contract: typeof json?.contract === "string" ? json.contract : undefined,
      provider: typeof json?.provider === "string" ? json.provider : undefined,
      models,
    };
  }

  async createGenerationJob(
    request: SystemSculptCreateGenerationJobRequest,
    options?: { idempotencyKey?: string }
  ): Promise<SystemSculptCreateGenerationJobResponse> {
    const url = this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.IMAGES.GENERATION_JOBS);
    const headers: Record<string, string> = this.authHeaders();
    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      input_images: request.input_images || [],
    };

    if (request.model && String(request.model).trim()) {
      payload.model = String(request.model).trim();
    }

    if (request.options) {
      const optionsPayload: Record<string, unknown> = {};
      if (typeof request.options.count === "number" && Number.isFinite(request.options.count)) {
        optionsPayload.count = Math.max(1, Math.floor(request.options.count));
      }
      if (typeof request.options.aspect_ratio === "string" && request.options.aspect_ratio.trim()) {
        optionsPayload.aspect_ratio = request.options.aspect_ratio.trim();
      }
      if (typeof request.options.seed === "number" && Number.isFinite(request.options.seed)) {
        optionsPayload.seed = Math.max(0, Math.floor(request.options.seed));
      }
      if (Object.keys(optionsPayload).length > 0) {
        payload.options = optionsPayload;
      }
    }

    const { json } = await this.requestJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const job = json?.job as SystemSculptImageGenerationJob | undefined;
    if (!job || typeof job.id !== "string" || !job.id.trim()) {
      throw new Error("Image generation response did not include a valid job id.");
    }

    return {
      job,
      poll_url: typeof json?.poll_url === "string" ? json.poll_url : undefined,
      idempotent_replay: json?.idempotent_replay === true,
    };
  }

  async getGenerationJob(jobId: string): Promise<SystemSculptGenerationJobResponse> {
    const id = String(jobId || "").trim();
    if (!id) {
      throw new Error("Missing generation job id.");
    }

    const url = this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.IMAGES.GENERATION_JOB(id));
    const { json } = await this.requestJson(url, {
      method: "GET",
      headers: this.authHeaders(),
    });

    const job = json?.job as SystemSculptImageGenerationJob | undefined;
    if (!job || typeof job.id !== "string" || !job.id.trim()) {
      throw new Error("Image generation status response did not include a valid job payload.");
    }

    const usageRaw = json?.usage;
    const usage =
      usageRaw && typeof usageRaw === "object"
        ? ({
            provider: typeof (usageRaw as any).provider === "string" ? (usageRaw as any).provider : "openrouter",
            raw_usd:
              typeof (usageRaw as any).raw_usd === "number" && Number.isFinite((usageRaw as any).raw_usd)
                ? (usageRaw as any).raw_usd
                : null,
            cost_source: typeof (usageRaw as any).cost_source === "string" ? (usageRaw as any).cost_source : null,
            estimated: (usageRaw as any).estimated === true,
          } satisfies SystemSculptImageGenerationUsage)
        : undefined;

    return {
      job,
      outputs: normalizeOutputs(json?.outputs),
      usage,
    };
  }

  async waitForGenerationJob(
    jobId: string,
    options?: {
      pollIntervalMs?: number;
      signal?: AbortSignal;
      onUpdate?: (job: SystemSculptGenerationJobResponse) => void;
    }
  ): Promise<SystemSculptGenerationJobResponse> {
    const pollMs = Math.max(250, Math.floor(options?.pollIntervalMs ?? 1000));
    const signal = options?.signal;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const status = await this.getGenerationJob(jobId);
      options?.onUpdate?.(status);

      if (status.job.status === "succeeded") {
        return status;
      }

      if (status.job.status === "failed" || status.job.status === "canceled" || status.job.status === "expired") {
        const message = String(status.job.error_message || "").trim() || `Image generation ${status.job.status}`;
        throw new Error(message);
      }

      await sleep(pollMs, signal);
    }
  }

  async downloadImage(url: string): Promise<{ arrayBuffer: ArrayBuffer; contentType?: string }> {
    const rawTarget = String(url || "").trim();
    if (!rawTarget) {
      throw new Error("Missing image URL.");
    }

    const target = /^https?:\/\//i.test(rawTarget) ? rawTarget : this.endpoint(rawTarget);
    const headersIn = this.shouldAttachAuthHeaders(target) ? this.authHeaders() : {};

    const { arrayBuffer, headers } = await this.requestArrayBuffer(target, {
      method: "GET",
      headers: headersIn,
    });

    const contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : undefined;
    return { arrayBuffer, contentType };
  }
}
