import { normalizePath, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { resolveSystemSculptApiBaseUrl } from "../utils/urlHelpers";
import {
  SystemSculptImageGenerationService,
  type SystemSculptImageInput,
} from "../services/canvasflow/SystemSculptImageGenerationService";
import type {
  StudioApiAdapter,
  StudioImageGenerationRequest,
  StudioImageGenerationResult,
  StudioProjectV1,
  StudioTextGenerationRequest,
  StudioTextGenerationResult,
  StudioTextReasoningEffort,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
} from "./types";
import { StudioAssetStore } from "./StudioAssetStore";
import { runStudioLocalPiTextGeneration } from "./StudioLocalTextModelCatalog";
import {
  assertPiTextExecutionReady,
  shouldUseLocalPiExecution,
} from "../services/pi-native/PiTextRuntime";

const API_NODE_KINDS = new Set(["studio.image_generation", "studio.transcription"]);
const STUDIO_MANAGED_IMAGE_MODEL_ID = "systemsculpt/managed-image";
const STUDIO_IMAGE_POLL_MAX_WAIT_MS = 8 * 60_000;
const STUDIO_IMAGE_RETRY_INITIAL_DELAY_MS = 2_000;
const STUDIO_IMAGE_RETRY_MAX_DELAY_MS = 60_000;
const STUDIO_IMAGE_RETRY_MAX_ATTEMPTS = 12;
const STUDIO_IMAGE_RETRY_MAX_ELAPSED_MS = 30 * 60_000;
const STUDIO_IMAGE_RETRYABLE_MESSAGE_MARKERS = [
  "(e003)",
  "high demand",
  "please try again later",
  "temporarily unavailable",
  "provider_unavailable",
  "request failed",
  "request timed out",
  "polling failed",
] as const;

function hashFnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeIdempotencyToken(value: string, maxLength: number): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return "na";
  }
  return normalized.slice(0, maxLength);
}

function buildStudioImageIdempotencyKey(
  request: StudioImageGenerationRequest,
  modelId: string,
  attempt: number = 1
): string {
  const runToken = sanitizeIdempotencyToken(request.runId, 24);
  const modelToken = sanitizeIdempotencyToken(modelId, 28);
  const attemptToken = Math.max(1, Math.floor(attempt || 1));
  const imageSignature = (request.inputImages || [])
    .map((asset) => `${String(asset.hash || "").toLowerCase()}:${Math.max(0, Number(asset.sizeBytes) || 0)}`)
    .join("|");
  const payloadSignature = hashFnv1aHex(
    `${String(request.prompt || "")}|${String(request.aspectRatio || "")}|${String(request.count || "")}|${imageSignature}`
  );
  return `studio-image-${runToken}-${modelToken}-r${attemptToken}-${payloadSignature}`;
}

function isRetryableStudioImageError(message: string): boolean {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return STUDIO_IMAGE_RETRYABLE_MESSAGE_MARKERS.some((marker) => normalized.includes(marker));
}

function computeStudioImageRetryDelayMs(retryIndex: number): number {
  const steps = Math.max(0, retryIndex - 1);
  const computed = STUDIO_IMAGE_RETRY_INITIAL_DELAY_MS * Math.pow(2, steps);
  return Math.min(STUDIO_IMAGE_RETRY_MAX_DELAY_MS, Math.max(STUDIO_IMAGE_RETRY_INITIAL_DELAY_MS, Math.floor(computed)));
}

function shouldRetryStudioImageError(options: {
  message: string;
  attempt: number;
  startedAtMs: number;
}): boolean {
  if (!isRetryableStudioImageError(options.message)) {
    return false;
  }
  if (options.attempt >= STUDIO_IMAGE_RETRY_MAX_ATTEMPTS) {
    return false;
  }
  return Date.now() - options.startedAtMs <= STUDIO_IMAGE_RETRY_MAX_ELAPSED_MS;
}

function waitForStudioImageRetry(ms: number): Promise<void> {
  const delay = Math.max(0, Math.floor(ms));
  if (delay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

function mimeExtension(mimeType: string): string {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mp4")) return "m4a";
  return "bin";
}

function pathExtension(path: string): string {
  const normalized = String(path || "").trim().toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot <= 0 || dot === normalized.length - 1) {
    return "";
  }
  return normalized.slice(dot + 1);
}

function normalizeInputImageMimeType(mimeType: string): "image/png" | "image/jpeg" | "image/webp" | null {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

type VaultBinaryAdapter = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  remove?: (path: string) => Promise<void>;
};

export class StudioApiExecutionAdapter implements StudioApiAdapter {
  private imageClient: SystemSculptImageGenerationService | null = null;
  private localPiTextTurnQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly assetStore: StudioAssetStore
  ) {}

  private apiBaseUrl(): string {
    return resolveSystemSculptApiBaseUrl(this.plugin.settings.serverUrl);
  }

  private readReasoningEffort(request: StudioTextGenerationRequest): StudioTextReasoningEffort | undefined {
    const normalized = String(request.reasoningEffort || "").trim().toLowerCase();
    if (
      normalized === "off" ||
      normalized === "minimal" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh"
    ) {
      return normalized;
    }
    return undefined;
  }

  private async resolveSelectedTextModel(request: StudioTextGenerationRequest) {
    const requestedModelId = String(request.modelId || "").trim();
    if (!requestedModelId) {
      throw new Error("Text generation node requires a Pi model selection before it can run.");
    }

    const model = await this.plugin.modelService.getModelById(requestedModelId);
    if (!model) {
      throw new Error(`Selected Pi model "${requestedModelId}" is unavailable. Refresh models and choose another.`);
    }
    return model;
  }

  private isLikelyMissingPiCli(message: string): boolean {
    const normalized = String(message || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized.includes("spawn pi enoent") ||
      normalized.includes("pi: command not found") ||
      normalized.includes("command not found: pi") ||
      normalized.includes("pi sdk package is unavailable") ||
      normalized.includes("pi runtime bootstrap") ||
      normalized.includes("bundled pi runtime") ||
      normalized.includes("unable to resolve a pi runtime") ||
      normalized.includes("no such file or directory") && normalized.includes("pi")
    );
  }

  private buildLocalPiInstallGuidanceMessage(options: {
    modelId: string;
    rawMessage: string;
  }): string {
    return [
      `Local (Pi) text generation failed for model "${options.modelId}": the bundled Pi runtime is unavailable.`,
      `Original error: ${options.rawMessage}`,
      "",
      "Recovery checklist:",
      "1) Keep Obsidian open for a few seconds, then retry so SystemSculpt can finish downloading the bundled Pi runtime.",
      "2) If this was a fresh install or update, reopen Obsidian and retry the Studio run.",
      "3) Open Setup -> Local Pi and rerun Verify Models to force a runtime check.",
      "4) If your network blocks GitHub release downloads, allow them and retry the bootstrap.",
    ].join("\n");
  }

  private extractProviderFromLocalPiModelId(modelId: string): string {
    const trimmed = String(modelId || "").trim();
    if (!trimmed) {
      return "";
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0) {
      return "";
    }
    return trimmed.slice(0, slash).trim().toLowerCase();
  }

  private buildLocalPiAuthGuidanceMessage(options: {
    modelId: string;
    rawMessage: string;
  }): string {
    const providerFromMessage =
      /no api key found for\s+([a-z0-9._-]+)/i.exec(options.rawMessage)?.[1]?.trim().toLowerCase() ||
      /authentication failed for\s+\"([a-z0-9._-]+)\"/i.exec(options.rawMessage)?.[1]?.trim().toLowerCase() ||
      "";
    const provider = providerFromMessage || this.extractProviderFromLocalPiModelId(options.modelId);
    const loginCommand = provider ? `pi /login ${provider}` : "pi /login <provider>";

    const lines = [
      `Local (Pi) text generation failed for model "${options.modelId}": provider authentication is missing or invalid.`,
      `Original error: ${options.rawMessage}`,
      "",
      "Fix checklist:",
      "1) Open SystemSculpt Setup and complete the provider login again.",
      "2) If you need the terminal fallback, launch it from the setup wizard so it uses the bundled Pi runtime.",
      `   Manual command: ${loginCommand}`,
      "3) Refresh the local Pi model catalog in Studio or retry the setup wizard's Verify Models step.",
      "4) Retry the Studio run.",
      "",
      "If you use API-key providers, you can also export the required provider API key env vars before launching Obsidian.",
    ];

    return lines.join("\n");
  }

  private modelRequiresSystemSculptCredits(model: Awaited<ReturnType<StudioApiExecutionAdapter["resolveSelectedTextModel"]>>): boolean {
    return String(model.provider || "").trim().toLowerCase() === "systemsculpt";
  }

  private buildLocalPiTokenTypeGuidanceMessage(options: {
    modelId: string;
    rawMessage: string;
  }): string {
    const provider = this.extractProviderFromLocalPiModelId(options.modelId) || "provider";
    return [
      `Local (Pi) text generation failed for model "${options.modelId}": the current ${provider} credentials are not accepted for this endpoint.`,
      `Original error: ${options.rawMessage}`,
      "",
      "Fix checklist:",
      "1) Re-authenticate from SystemSculpt Setup so the bundled Pi runtime is used.",
      `   Manual command: pi /login ${provider}`,
      "2) Refresh the local Pi model catalog in Studio or rerun the setup wizard verification step.",
      "3) Retry the Studio run.",
    ].join("\n");
  }

  private enrichLocalPiRuntimeErrorMessage(options: {
    modelId: string;
    rawMessage: string;
  }): string {
    const normalized = String(options.rawMessage || "").trim().toLowerCase();
    if (!normalized) {
      return options.rawMessage;
    }
    if (
      normalized.includes("no api key found for") ||
      normalized.includes("agent-session.js:556") ||
      normalized.includes("authentication failed for")
    ) {
      return this.buildLocalPiAuthGuidanceMessage(options);
    }
    if (normalized.includes("personal access tokens are not supported for this endpoint")) {
      return this.buildLocalPiTokenTypeGuidanceMessage(options);
    }
    return options.rawMessage;
  }

  private licenseKey(): string {
    const licenseKey = String(this.plugin.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new Error("SystemSculpt Studio requires a valid SystemSculpt license key.");
    }
    return licenseKey;
  }

  private ensureImageClient(): SystemSculptImageGenerationService {
    const baseUrl = this.apiBaseUrl();
    const licenseKey = this.licenseKey();
    if (!this.imageClient) {
      this.imageClient = new SystemSculptImageGenerationService({
        baseUrl,
        licenseKey,
        pluginVersion: this.plugin.manifest.version,
      });
      return this.imageClient;
    }

    this.imageClient = new SystemSculptImageGenerationService({
      baseUrl,
      licenseKey,
      pluginVersion: this.plugin.manifest.version,
    });
    return this.imageClient;
  }

  private async runLocalPiTextTurnExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.localPiTextTurnQueue.then(operation, operation);
    this.localPiTextTurnQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private get vaultAdapter(): VaultBinaryAdapter {
    return this.plugin.app.vault.adapter as unknown as VaultBinaryAdapter;
  }

  private async ensureDir(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        const exists = await this.vaultAdapter.exists(current);
        if (!exists) {
          await this.vaultAdapter.mkdir(current);
        }
      } catch {
        // Best effort directory creation to support nested vault adapters.
      }
    }
  }

  private async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
    if (typeof this.vaultAdapter.writeBinary !== "function") {
      throw new Error("Binary writes are unavailable for Studio transcription temp files.");
    }
    await this.vaultAdapter.writeBinary(path, bytes);
  }

  private async uploadInputImagesForStudioGeneration(
    imageClient: SystemSculptImageGenerationService,
    assets: StudioImageGenerationRequest["inputImages"]
  ): Promise<SystemSculptImageInput[]> {
    const inputAssets = Array.isArray(assets) ? assets : [];
    if (inputAssets.length === 0) {
      return [];
    }

    const normalizedAssets = inputAssets.map((asset, index) => {
      const hash = String(asset?.hash || "").trim().toLowerCase();
      const path = String(asset?.path || "").trim();
      const normalizedMime = normalizeInputImageMimeType(String(asset?.mimeType || ""));
      const sizeBytes = Number.isFinite(Number(asset?.sizeBytes)) ? Math.max(1, Math.floor(Number(asset?.sizeBytes))) : 0;
      if (!hash || !path || !normalizedMime || !sizeBytes) {
        throw new Error(
          `Image generation input #${index + 1} is invalid. Provide image assets with hash, path, sizeBytes, and PNG/JPEG/WEBP mimeType.`
        );
      }
      return {
        hash,
        path,
        mimeType: normalizedMime,
        sizeBytes,
      };
    });

    const preparedUploads = await imageClient.prepareInputImageUploads(
      normalizedAssets.map((asset) => ({
        mime_type: asset.mimeType,
        size_bytes: asset.sizeBytes,
        sha256: asset.hash,
      }))
    );
    const uploadByIndex = new Map(preparedUploads.input_uploads.map((item) => [item.index, item]));
    const uploadedInputRefs: Extract<SystemSculptImageInput, { type: "uploaded" }>[] = [];

    for (let idx = 0; idx < normalizedAssets.length; idx += 1) {
      const localAsset = normalizedAssets[idx];
      const upload = uploadByIndex.get(idx);
      if (!upload) {
        throw new Error(`Image generation input upload preparation failed for index ${idx}.`);
      }
      if (!upload.upload?.url || upload.upload?.method !== "PUT") {
        throw new Error(`Image generation input upload URL missing or invalid for index ${idx}.`);
      }
      if (!upload.input_image || upload.input_image.type !== "uploaded") {
        throw new Error(`Image generation input upload metadata missing for index ${idx}.`);
      }
      const remoteInput = upload.input_image;
      if (remoteInput.sha256 !== localAsset.hash) {
        throw new Error(`Image generation input digest mismatch for index ${idx}.`);
      }
      if (remoteInput.size_bytes !== localAsset.sizeBytes) {
        throw new Error(`Image generation input size mismatch for index ${idx}.`);
      }
      if (normalizeInputImageMimeType(remoteInput.mime_type) !== localAsset.mimeType) {
        throw new Error(`Image generation input mime type mismatch for index ${idx}.`);
      }

      const bytes = await this.assetStore.readArrayBuffer({
        hash: localAsset.hash,
        mimeType: localAsset.mimeType,
        sizeBytes: localAsset.sizeBytes,
        path: localAsset.path,
      });
      await imageClient.uploadPreparedInputImage({
        uploadUrl: upload.upload.url,
        mimeType: localAsset.mimeType,
        bytes,
        extraHeaders: upload.upload.headers,
      });
      uploadedInputRefs.push(remoteInput);
    }

    return uploadedInputRefs;
  }

  private async removeTempPath(path: string): Promise<void> {
    try {
      if (typeof this.vaultAdapter.remove === "function") {
        await this.vaultAdapter.remove(path);
        return;
      }
      const existing = this.plugin.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.plugin.app.vault.delete(existing);
      }
    } catch {
      // Best effort cleanup only.
    }
  }

  private nodeRequiresSystemSculptCredits(node: StudioProjectV1["graph"]["nodes"][number]): boolean {
    if (API_NODE_KINDS.has(node.kind)) {
      return true;
    }
    if (node.kind !== "studio.text_generation") {
      return false;
    }
    const requestedModelId = String((node.config as Record<string, unknown>)?.modelId || "").trim();
    if (!requestedModelId) {
      return true;
    }
    const models = this.plugin.modelService.getCachedModels();
    const model = models.find((candidate) => candidate.id === requestedModelId);
    if (!model) {
      return true;
    }
    return this.modelRequiresSystemSculptCredits(model) || !shouldUseLocalPiExecution(model);
  }

  async estimateRunCredits(project: StudioProjectV1): Promise<{ ok: boolean; reason?: string }> {
    const requiresSystemSculptCredits = project.graph.nodes.some((node) =>
      this.nodeRequiresSystemSculptCredits(node)
    );
    if (!requiresSystemSculptCredits) {
      return { ok: true };
    }

    try {
      const balance = await this.plugin.aiService.getCreditsBalance();
      if (balance.totalRemaining > 0) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: "Insufficient SystemSculpt credits for API-dependent Studio nodes.",
      };
    } catch (error: any) {
      return {
        ok: false,
        reason: error?.message || "Unable to verify SystemSculpt credits balance.",
      };
    }
  }

  async generateText(request: StudioTextGenerationRequest): Promise<StudioTextGenerationResult> {
    const reasoningEffort = this.readReasoningEffort(request);
    const systemPrompt = String(request.systemPrompt || "").trim();
    const selectedModel = await this.resolveSelectedTextModel(request);
    const executionPlan = await assertPiTextExecutionReady(selectedModel);

    try {
      const result = await this.runLocalPiTextTurnExclusive(() =>
        runStudioLocalPiTextGeneration({
          plugin: this.plugin,
          modelId: executionPlan.actualModelId,
          prompt: request.prompt,
          systemPrompt,
          reasoningEffort,
        })
      );
      return {
        text: result.text,
        modelId: selectedModel.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isLikelyMissingPiCli(message)) {
        throw new Error(
          this.buildLocalPiInstallGuidanceMessage({
            modelId: executionPlan.actualModelId,
            rawMessage: message,
          })
        );
      }
      const enrichedMessage = this.enrichLocalPiRuntimeErrorMessage({
        modelId: executionPlan.actualModelId,
        rawMessage: message,
      });
      throw new Error(`Local (Pi) text generation failed: ${enrichedMessage}`);
    }
  }

  async generateImage(request: StudioImageGenerationRequest): Promise<StudioImageGenerationResult> {
    const modelId = String(request.modelId || STUDIO_MANAGED_IMAGE_MODEL_ID).trim() || STUDIO_MANAGED_IMAGE_MODEL_ID;
    const imageClient = this.ensureImageClient();
    const uploadedInputImages = await this.uploadInputImagesForStudioGeneration(imageClient, request.inputImages);
    const startedAtMs = Date.now();

    for (let attempt = 1; attempt <= STUDIO_IMAGE_RETRY_MAX_ATTEMPTS; attempt += 1) {
      let create: Awaited<ReturnType<SystemSculptImageGenerationService["createGenerationJob"]>>;
      try {
        create = await imageClient.createGenerationJob(
          {
            prompt: request.prompt,
            input_images: uploadedInputImages,
            options: {
              count: request.count,
              aspect_ratio: request.aspectRatio,
            },
          },
          {
            idempotencyKey: buildStudioImageIdempotencyKey(request, modelId, attempt),
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fullMessage =
          `Image generation request failed (aspectRatio: "${String(request.aspectRatio || "").trim() || "default"}"): ${message}`;
        if (shouldRetryStudioImageError({ message: fullMessage, attempt, startedAtMs })) {
          const delayMs = computeStudioImageRetryDelayMs(attempt);
          await waitForStudioImageRetry(delayMs);
          continue;
        }
        throw new Error(fullMessage);
      }

      let completed: Awaited<ReturnType<SystemSculptImageGenerationService["waitForGenerationJob"]>>;
      try {
        completed = await imageClient.waitForGenerationJob(create.job.id, {
          pollUrl: create.poll_url,
          pollIntervalMs: 1_000,
          maxWaitMs: STUDIO_IMAGE_POLL_MAX_WAIT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fullMessage = `Image generation polling failed (job: "${create.job.id}"): ${message}`;
        if (shouldRetryStudioImageError({ message: fullMessage, attempt, startedAtMs })) {
          const delayMs = computeStudioImageRetryDelayMs(attempt);
          await waitForStudioImageRetry(delayMs);
          continue;
        }
        throw new Error(fullMessage);
      }

      if (!completed.outputs || completed.outputs.length === 0) {
        const fullMessage = "SystemSculpt image generation returned no outputs.";
        if (shouldRetryStudioImageError({ message: fullMessage, attempt, startedAtMs })) {
          const delayMs = computeStudioImageRetryDelayMs(attempt);
          await waitForStudioImageRetry(delayMs);
          continue;
        }
        throw new Error(fullMessage);
      }

      const images = [];
      for (const output of completed.outputs) {
        const downloaded = await imageClient.downloadImage(output.url);
        const asset = await this.assetStore.storeArrayBuffer(
          request.projectPath,
          downloaded.arrayBuffer,
          downloaded.contentType || output.mime_type
        );
        images.push(asset);
      }

      return {
        images,
        modelId,
      };
    }

    throw new Error("Image generation failed after repeated retries.");
  }

  private async writeTempAudioFile(
    request: StudioTranscriptionRequest
  ): Promise<{ path: string; file: TFile }> {
    const bytes = await this.assetStore.readArrayBuffer(request.audio);
    const extensionFromMime = mimeExtension(request.audio.mimeType);
    const extension =
      extensionFromMime === "bin"
        ? pathExtension(request.audio.path) || extensionFromMime
        : extensionFromMime;
    const dir = "SystemSculpt/Studio/.runtime-tmp-audio";
    const fileName = `${request.runId}-${request.audio.hash.slice(0, 12)}.${extension}`;
    const path = normalizePath(`${dir}/${fileName}`);

    await this.ensureDir(dir);
    await this.writeBinary(path, bytes);

    const now = Date.now();
    const basename = fileName.slice(0, fileName.length - (extension.length + 1));
    const fileShim = {
      path,
      name: fileName,
      basename,
      extension,
      stat: {
        size: bytes.byteLength,
        ctime: now,
        mtime: now,
      },
    } as unknown as TFile;

    return { path, file: fileShim };
  }

  async transcribeAudio(request: StudioTranscriptionRequest): Promise<StudioTranscriptionResult> {
    const temp = await this.writeTempAudioFile(request);
    try {
      const text = await this.plugin.getTranscriptionService().transcribeFile(temp.file, {
        suppressNotices: true,
        type: "note",
      });
      return { text: String(text || "") };
    } finally {
      await this.removeTempPath(temp.path);
    }
  }
}
