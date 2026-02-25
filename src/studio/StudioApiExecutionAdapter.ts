import { normalizePath, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { resolveSystemSculptApiBaseUrl } from "../utils/urlHelpers";
import { AgentSessionClient } from "../services/agent-v2/AgentSessionClient";
import { StreamingService } from "../services/StreamingService";
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
  StudioTextProviderMode,
  StudioTextReasoningEffort,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
} from "./types";
import { StudioAssetStore } from "./StudioAssetStore";
import {
  normalizeStudioLocalPiModelId,
  runStudioLocalPiTextGeneration,
} from "./StudioLocalTextModelCatalog";
import { randomId } from "./utils";

const API_NODE_KINDS = new Set(["studio.image_generation", "studio.transcription"]);
const STUDIO_MANAGED_IMAGE_MODEL_ID = "systemsculpt/managed-image";
const STUDIO_MANAGED_TEXT_MODEL_ID = "systemsculpt/managed";
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
  private readonly streamer = new StreamingService();
  private readonly sessionClient: AgentSessionClient;
  private imageClient: SystemSculptImageGenerationService | null = null;
  private textTurnQueue: Promise<void> = Promise.resolve();
  private localPiTextTurnQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly assetStore: StudioAssetStore
  ) {
    this.sessionClient = new AgentSessionClient({
      baseUrl: this.apiBaseUrl(),
      licenseKey: this.licenseKey(),
      request: (input) => this.plugin.aiService.requestAgentSession(input),
      defaultHeaders: {
        "x-systemsculpt-surface": "studio",
      },
      managedInference: true,
    });
  }

  private apiBaseUrl(): string {
    return resolveSystemSculptApiBaseUrl(this.plugin.settings.serverUrl);
  }

  private readTextProviderMode(request: StudioTextGenerationRequest): StudioTextProviderMode {
    const normalized = String(request.sourceMode || "systemsculpt").trim().toLowerCase();
    return normalized === "local_pi" ? "local_pi" : "systemsculpt";
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

  private async resolveLocalTextModelId(request: StudioTextGenerationRequest): Promise<string> {
    const rawLocalModelId = String(request.localModelId || "").trim();
    if (!rawLocalModelId) {
      throw new Error(
        'Text generation node is set to Local (Pi), but no model is selected. Choose a Local model and rerun.'
      );
    }
    return normalizeStudioLocalPiModelId(rawLocalModelId);
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

  private refreshSessionConfig(): void {
    this.sessionClient.updateConfig({
      baseUrl: this.apiBaseUrl(),
      licenseKey: this.licenseKey(),
    });
  }

  private async runTextTurnExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.textTurnQueue.then(operation, operation);
    this.textTurnQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
    const sourceMode = String((node.config as Record<string, unknown>)?.sourceMode || "systemsculpt")
      .trim()
      .toLowerCase();
    return sourceMode !== "local_pi";
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
    const sourceMode = this.readTextProviderMode(request);
    const reasoningEffort = this.readReasoningEffort(request);
    const systemPrompt = String(request.systemPrompt || "").trim();
    const messages: Array<{ role: "system" | "user"; content: string; message_id: string }> = [];
    if (systemPrompt) {
      messages.push({
        role: "system" as const,
        content: systemPrompt,
        message_id: randomId("msg"),
      });
    }
    messages.push({
      role: "user" as const,
      content: request.prompt,
      message_id: randomId("msg"),
    });

    if (sourceMode === "local_pi") {
      const localModelId = await this.resolveLocalTextModelId(request);
      try {
        // Pi CLI uses a shared startup/settings lock, so concurrent invocations can fail
        // transiently with lock/auth initialization races.
        const result = await this.runLocalPiTextTurnExclusive(() => runStudioLocalPiTextGeneration({
          plugin: this.plugin,
          modelId: localModelId,
          prompt: request.prompt,
          systemPrompt,
          reasoningEffort,
        }));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Local (Pi) text generation failed: ${message}`);
      }
    }

    this.refreshSessionConfig();
    const modelId = STUDIO_MANAGED_TEXT_MODEL_ID;

    // API turn locking is account-scoped server-side, so serialize Studio text turns locally.
    return this.runTextTurnExclusive(async () => {
      const response = await this.sessionClient.startOrContinueTurn({
        chatId: `studio:${request.runId}:${request.nodeId}`,
        messages,
        pluginVersion: this.plugin.manifest.version,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 409) {
          let conflictCode = "";
          let lockUntil = "";
          try {
            const parsed = JSON.parse(body) as {
              error?: { code?: string; lock_until?: string; message?: string } | string;
              message?: string;
            };
            const errorObject = parsed?.error && typeof parsed.error === "object"
              ? parsed.error
              : null;
            conflictCode = String(errorObject?.code || parsed?.error || "").trim().toLowerCase();
            lockUntil = String(errorObject?.lock_until || "").trim();
          } catch {
            // Fall through to generic error with raw response snippet.
          }
          if (conflictCode === "turn_in_flight") {
            const suffix = lockUntil ? ` lock_until=${lockUntil}` : "";
            throw new Error(
              `SystemSculpt text generation failed (409 turn_in_flight): another turn is already running for this account.${suffix}`
            );
          }
        }
        throw new Error(
          `SystemSculpt text generation failed (${response.status}): ${body.slice(0, 240)}`
        );
      }

      let text = "";
      const events = this.streamer.streamResponse(response, {
        model: modelId,
        isCustomProvider: false,
      });

      for await (const event of events) {
        if (event.type === "content") {
          text += event.text;
        }
      }

      return {
        text: text.trim(),
        modelId,
      };
    });
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
