import { normalizePath, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { resolveSystemSculptApiBaseUrl } from "../utils/urlHelpers";
import { AgentSessionClient } from "../services/agent-v2/AgentSessionClient";
import { StreamingService } from "../services/StreamingService";
import { SystemSculptImageGenerationService } from "../services/canvasflow/SystemSculptImageGenerationService";
import type {
  StudioApiAdapter,
  StudioImageGenerationRequest,
  StudioImageGenerationResult,
  StudioProjectV1,
  StudioTextGenerationRequest,
  StudioTextGenerationResult,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
} from "./types";
import { StudioAssetStore } from "./StudioAssetStore";

const API_NODE_KINDS = new Set([
  "studio.text_generation",
  "studio.image_generation",
  "studio.transcription",
]);
const STUDIO_IMAGE_MODEL_ALIASES: Record<string, string> = {
  "google/nano-banana-pro": "google/gemini-3-pro-image-preview",
  "google/nano-banana": "google/gemini-3-pro-image-preview",
};

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

function buildStudioImageIdempotencyKey(request: StudioImageGenerationRequest, modelId: string): string {
  const runToken = sanitizeIdempotencyToken(request.runId, 24);
  const modelToken = sanitizeIdempotencyToken(modelId, 28);
  const payloadSignature = hashFnv1aHex(
    `${String(request.prompt || "")}|${String(request.aspectRatio || "")}|${String(request.count || "")}`
  );
  return `studio-image-${runToken}-${modelToken}-${payloadSignature}`;
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

type VaultBinaryAdapter = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  remove?: (path: string) => Promise<void>;
};

export class StudioSystemSculptApiAdapter implements StudioApiAdapter {
  private readonly streamer = new StreamingService();
  private readonly sessionClient: AgentSessionClient;
  private imageClient: SystemSculptImageGenerationService | null = null;
  private textTurnQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly assetStore: StudioAssetStore
  ) {
    this.sessionClient = new AgentSessionClient({
      baseUrl: this.apiBaseUrl(),
      licenseKey: this.licenseKey(),
      request: (input) => this.plugin.aiService.requestAgentSession(input),
    });
  }

  private apiBaseUrl(): string {
    return resolveSystemSculptApiBaseUrl(this.plugin.settings.serverUrl);
  }

  private normalizeStudioModelId(raw: string): string {
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed.includes("@@")) {
      const [providerIdRaw, upstreamModelRaw] = trimmed.split("@@", 2);
      const providerId = providerIdRaw.trim().toLowerCase();
      const upstreamModel = upstreamModelRaw.trim();
      if (providerId !== "systemsculpt") {
        throw new Error(
          `Studio is SystemSculpt API-only. Model "${trimmed}" belongs to non-SystemSculpt provider "${providerIdRaw}".`
        );
      }
      return upstreamModel;
    }

    return trimmed;
  }

  private normalizeStudioImageModelId(raw: string): string {
    const normalized = this.normalizeStudioModelId(raw);
    if (!normalized) {
      return "";
    }
    const alias = STUDIO_IMAGE_MODEL_ALIASES[normalized.toLowerCase()];
    return alias || normalized;
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

  async estimateRunCredits(project: StudioProjectV1): Promise<{ ok: boolean; reason?: string }> {
    const requiresApi = project.graph.nodes.some((node) => API_NODE_KINDS.has(node.kind));
    if (!requiresApi) {
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
    this.refreshSessionConfig();
    const modelId = this.normalizeStudioModelId(
      String(request.modelId || this.plugin.settings.selectedModelId || "")
    );
    if (!modelId) {
      throw new Error("Text generation requires a model ID.");
    }

    const systemPrompt = String(request.systemPrompt || "").trim();
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: "system" as const, content: systemPrompt });
    }
    messages.push({ role: "user" as const, content: request.prompt });

    // API turn locking is account-scoped server-side, so serialize Studio text turns locally.
    return this.runTextTurnExclusive(async () => {
      const response = await this.sessionClient.startOrContinueTurn({
        chatId: `studio:${request.runId}:${request.nodeId}`,
        modelId,
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
    const modelId =
      this.normalizeStudioImageModelId(
        String(request.modelId || this.plugin.settings.imageGenerationDefaultModelId || "")
      ) || "openai/gpt-5-image-mini";
    const imageClient = this.ensureImageClient();
    let create: Awaited<ReturnType<SystemSculptImageGenerationService["createGenerationJob"]>>;
    try {
      create = await imageClient.createGenerationJob(
        {
          model: modelId,
          prompt: request.prompt,
          options: {
            count: request.count,
            aspect_ratio: request.aspectRatio,
          },
        },
        {
          idempotencyKey: buildStudioImageIdempotencyKey(request, modelId),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Image generation request failed for model "${modelId}" (aspectRatio: "${String(request.aspectRatio || "").trim() || "default"}"): ${message}`
      );
    }

    let completed: Awaited<ReturnType<SystemSculptImageGenerationService["waitForGenerationJob"]>>;
    try {
      completed = await imageClient.waitForGenerationJob(create.job.id, {
        pollUrl: create.poll_url,
        pollIntervalMs: 1_000,
        maxWaitMs: 8 * 60_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Image generation polling failed for model "${modelId}" (job: "${create.job.id}"): ${message}`
      );
    }

    if (!completed.outputs || completed.outputs.length === 0) {
      throw new Error("SystemSculpt image generation returned no outputs.");
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
