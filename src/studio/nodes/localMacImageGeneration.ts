import { Platform } from "obsidian";
import type { StudioAssetRef, StudioNodeExecutionContext } from "../types";
import { isRecord } from "../utils";
import { inferMimeTypeFromPath } from "./shared";

export const LOCAL_MAC_IMAGE_DEFAULT_ASPECT_RATIO = "1:1";
const LOCAL_MAC_IMAGE_DEFAULT_MODEL_ID = "local/macos-imagegen";
const LOCAL_MAC_IMAGE_REQUEST_SCHEMA = "studio.local-image-generation.request.v1";
const LOCAL_MAC_IMAGE_RESPONSE_SCHEMA = "studio.local-image-generation.response.v1";
const LOCAL_MAC_IMAGE_TIMEOUT_MS = 8 * 60_000;
const LOCAL_MAC_IMAGE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LOCAL_MAC_IMAGE_COMMAND_CWD = "/";

export const STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT = "systemsculpt_ai" as const;
export const STUDIO_IMAGE_PROVIDER_LOCAL_MACOS = "local_macos_image_generation" as const;
export const STUDIO_LOCAL_MAC_IMAGE_COMMAND = "systemsculpt-local-imagegen";
export const LOCAL_MAC_IMAGE_SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;
export const LOCAL_MAC_IMAGE_SUPPORTED_QUALITY_PRESETS = ["fast", "balanced", "high"] as const;
export const LOCAL_MAC_IMAGE_SUPPORTED_REFERENCE_INFLUENCE = [
  "subtle",
  "balanced",
  "strong",
] as const;
export const LOCAL_MAC_IMAGE_DEFAULT_QUALITY_PRESET = "balanced";
export const LOCAL_MAC_IMAGE_DEFAULT_REFERENCE_INFLUENCE = "balanced";

export type StudioImageProviderId =
  | typeof STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT
  | typeof STUDIO_IMAGE_PROVIDER_LOCAL_MACOS;

type LocalMacImageGenerationRequest = {
  prompt: string;
  count: number;
  aspectRatio: string;
  runId: string;
  inputImages: StudioAssetRef[];
  qualityPreset?: string;
  referenceInfluence?: string;
};

type LocalMacImageInputPayload = {
  hash: string;
  mimeType: string;
  sizeBytes: number;
  stagedPath: string;
};

type LocalMacImageCommandRequest = {
  schema: typeof LOCAL_MAC_IMAGE_REQUEST_SCHEMA;
  prompt: string;
  count: number;
  aspectRatio: string;
  runId: string;
  inputImages: LocalMacImageInputPayload[];
  localOptions: {
    quality: string;
    referenceInfluence: string;
  };
};

type LocalMacImageCommandResult = {
  schema: string;
  modelId: string;
  images: StudioAssetRef[];
  warnings: string[];
};

function encodeUtf8(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function imageFileExtensionForMimeType(mimeType: string): string {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  return "bin";
}

function normalizeOutputMimeType(mimeType: string): "image/png" | "image/jpeg" | "image/webp" | null {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

function normalizeAspectRatio(raw: string): string {
  const compact = String(raw || "").trim().replace(/\s+/g, "");
  if (!compact) {
    return LOCAL_MAC_IMAGE_DEFAULT_ASPECT_RATIO;
  }
  return LOCAL_MAC_IMAGE_SUPPORTED_ASPECT_RATIOS.includes(
    compact as (typeof LOCAL_MAC_IMAGE_SUPPORTED_ASPECT_RATIOS)[number]
  )
    ? compact
    : LOCAL_MAC_IMAGE_DEFAULT_ASPECT_RATIO;
}

function normalizeQualityPreset(raw: string): string {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (normalized === "fast" || normalized === "draft") {
    return "fast";
  }
  if (normalized === "high" || normalized === "highdetail" || normalized === "detail") {
    return "high";
  }
  return LOCAL_MAC_IMAGE_DEFAULT_QUALITY_PRESET;
}

function normalizeReferenceInfluence(raw: string): string {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (normalized === "subtle" || normalized === "low") {
    return "subtle";
  }
  if (normalized === "strong" || normalized === "high") {
    return "strong";
  }
  return LOCAL_MAC_IMAGE_DEFAULT_REFERENCE_INFLUENCE;
}

function decodeBase64ImageBytes(raw: string): ArrayBuffer {
  const compact = String(raw || "").replace(/\s+/g, "");
  if (!compact) {
    throw new Error("Local provider returned an empty base64 image payload.");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.byteLength === 0) {
    throw new Error("Local provider returned an invalid base64 image payload.");
  }
  return toArrayBuffer(decoded);
}

async function stageInputImages(
  context: StudioNodeExecutionContext,
  inputImages: StudioAssetRef[],
  tempPaths: string[]
): Promise<LocalMacImageInputPayload[]> {
  const staged: LocalMacImageInputPayload[] = [];
  for (let index = 0; index < inputImages.length; index += 1) {
    const image = inputImages[index];
    const bytes = await context.services.readAsset(image);
    const stagedPath = await context.services.writeTempFile(bytes, {
      prefix: `studio-local-image-input-${index + 1}`,
      extension: imageFileExtensionForMimeType(image.mimeType),
    });
    tempPaths.push(stagedPath);
    staged.push({
      hash: image.hash,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      stagedPath,
    });
  }
  return staged;
}

async function cleanupTempPaths(context: StudioNodeExecutionContext, tempPaths: string[]): Promise<void> {
  for (const path of tempPaths) {
    await context.services.deleteLocalFile(path);
  }
}

async function parseLocalCommandImages(
  context: StudioNodeExecutionContext,
  stdout: string
): Promise<LocalMacImageCommandResult> {
  const raw = String(stdout || "").trim();
  if (!raw) {
    throw new Error("Local provider command returned no stdout payload.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local provider command returned invalid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Local provider command must return a JSON object.");
  }

  const payload = parsed as Record<string, unknown>;
  const schema = String(payload.schema || "").trim() || LOCAL_MAC_IMAGE_RESPONSE_SCHEMA;
  const modelId =
    String(payload.modelId || payload.model_id || "").trim() || LOCAL_MAC_IMAGE_DEFAULT_MODEL_ID;
  const imagesRaw = payload.images;
  const upstreamError = String(payload.error || "").trim();
  const warningsRaw = payload.warnings;

  if (!Array.isArray(imagesRaw) || imagesRaw.length === 0) {
    throw new Error(upstreamError || "Local provider command returned no images.");
  }

  const images: StudioAssetRef[] = [];
  for (let index = 0; index < imagesRaw.length; index += 1) {
    const entry = imagesRaw[index];
    if (!isRecord(entry)) {
      throw new Error(`Local provider image output at index ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const outputPath = String(record.path || "").trim();
    const base64 = String(record.base64 || "").trim();
    const mimeTypeHint = String(record.mimeType || record.mime_type || "").trim();

    if (!outputPath && !base64) {
      throw new Error(
        `Local provider image output at index ${index} must include either "path" or "base64".`
      );
    }

    const normalizedMime =
      normalizeOutputMimeType(mimeTypeHint) ||
      normalizeOutputMimeType(inferMimeTypeFromPath(outputPath)) ||
      (base64 ? "image/png" : null);
    if (!normalizedMime) {
      throw new Error(
        `Local provider image output at index ${index} has unsupported mime type "${mimeTypeHint || inferMimeTypeFromPath(outputPath)}".`
      );
    }

    let bytes: ArrayBuffer;
    if (outputPath) {
      context.services.assertFilesystemPath(outputPath);
      bytes = await context.services.readLocalFileBinary(outputPath);
    } else {
      bytes = decodeBase64ImageBytes(base64);
    }
    const stored = await context.services.storeAsset(bytes, normalizedMime);
    images.push(stored);
  }

  const warnings: string[] = [];
  if (Array.isArray(warningsRaw)) {
    for (const entry of warningsRaw) {
      const warning = String(entry || "").trim();
      if (warning) {
        warnings.push(warning);
      }
    }
  }

  return {
    schema,
    modelId,
    images,
    warnings,
  };
}

export function normalizeStudioImageProviderId(rawProvider: string): StudioImageProviderId | null {
  const normalized = String(rawProvider || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized === STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT ||
    normalized === "systemsculpt" ||
    normalized === "systemsculpt_api"
  ) {
    return STUDIO_IMAGE_PROVIDER_SYSTEMSCULPT;
  }
  if (
    normalized === STUDIO_IMAGE_PROVIDER_LOCAL_MACOS ||
    normalized === "local_macos" ||
    normalized === "local_macos_image"
  ) {
    return STUDIO_IMAGE_PROVIDER_LOCAL_MACOS;
  }
  return null;
}

export async function generateImageWithLocalMacProvider(
  context: StudioNodeExecutionContext,
  request: LocalMacImageGenerationRequest
): Promise<{ images: StudioAssetRef[]; modelId: string }> {
  if (!Platform.isDesktopApp) {
    throw new Error("Local macOS image generation is desktop-only.");
  }

  const prompt = String(request.prompt || "").trim();
  if (!prompt) {
    throw new Error("Local macOS image generation requires a non-empty prompt.");
  }

  const countRaw = Number(request.count);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(8, Math.floor(countRaw)) : 1;
  const aspectRatio = normalizeAspectRatio(String(request.aspectRatio || ""));
  const qualityPreset = normalizeQualityPreset(String(request.qualityPreset || ""));
  const referenceInfluence = normalizeReferenceInfluence(String(request.referenceInfluence || ""));
  const tempPaths: string[] = [];

  try {
    const inputImages = Array.isArray(request.inputImages) ? request.inputImages : [];
    if (inputImages.length > 1) {
      context.log(
        `[studio.local_image_generation] Received ${inputImages.length} reference images. Using only the first image for local macOS generation.`
      );
    }
    const stagedInputImages = await stageInputImages(
      context,
      inputImages.slice(0, 1),
      tempPaths
    );

    const commandRequest: LocalMacImageCommandRequest = {
      schema: LOCAL_MAC_IMAGE_REQUEST_SCHEMA,
      prompt,
      count,
      aspectRatio,
      runId: String(request.runId || "").trim(),
      inputImages: stagedInputImages,
      localOptions: {
        quality: qualityPreset,
        referenceInfluence,
      },
    };
    const requestPath = await context.services.writeTempFile(encodeUtf8(JSON.stringify(commandRequest)), {
      prefix: "studio-local-image-request",
      extension: "json",
    });
    tempPaths.push(requestPath);

    let cliResult: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };
    try {
      cliResult = await context.services.runCli({
        command: STUDIO_LOCAL_MAC_IMAGE_COMMAND,
        args: ["--request", requestPath],
        cwd: LOCAL_MAC_IMAGE_COMMAND_CWD,
        timeoutMs: LOCAL_MAC_IMAGE_TIMEOUT_MS,
        maxOutputBytes: LOCAL_MAC_IMAGE_MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("enoent") || lower.includes("not found")) {
        throw new Error(
          `Local macOS image generation command "${STUDIO_LOCAL_MAC_IMAGE_COMMAND}" is not installed or not on PATH. Run "node scripts/install-local-macos-diffusion-backend.mjs", then retry.`
        );
      }
      if (lower.includes("cli permission denied")) {
        throw new Error(
          `Local macOS image generation command "${STUDIO_LOCAL_MAC_IMAGE_COMMAND}" is blocked by Studio CLI policy. Re-open the Studio project once so default grants refresh, then retry.`
        );
      }
      throw new Error(
        `Local macOS image generation failed to start "${STUDIO_LOCAL_MAC_IMAGE_COMMAND}". ${message}`
      );
    }

    if (cliResult.timedOut) {
      throw new Error(
        `Local macOS image generation timed out after ${LOCAL_MAC_IMAGE_TIMEOUT_MS}ms.`
      );
    }
    if (cliResult.exitCode !== 0) {
      const details = String(cliResult.stderr || cliResult.stdout || "")
        .trim()
        .slice(0, 420);
      throw new Error(
        `Local macOS image generation exited with code ${cliResult.exitCode}.${details ? ` ${details}` : ""}`
      );
    }

    const parsed = await parseLocalCommandImages(context, cliResult.stdout);
    if (parsed.warnings.length > 0) {
      for (const warning of parsed.warnings) {
        context.log(`[studio.local_image_generation] ${warning}`);
      }
    }
    return {
      images: parsed.images,
      modelId: parsed.modelId,
    };
  } finally {
    await cleanupTempPaths(context, tempPaths);
  }
}
