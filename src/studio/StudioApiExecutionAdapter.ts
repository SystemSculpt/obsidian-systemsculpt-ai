import { StudioCodexRuns, codexRunKey } from "../services/codex/StudioCodexRuns";
import { answerCodexRequest } from "../services/codex/CodexRequestModal";
import { codexOptionsFromSettings, codexVaultDirectory, usesLocalCodex } from "../services/codex/CodexExecutionSettings";
import type SystemSculptPlugin from "../main";
import { ManagedImageGenerationAdapter } from "../services/images/ManagedImageGenerationAdapter";
import { ManagedJobClient } from "../services/managed/ManagedJobClient";
import { ManagedMediaJobClient } from "../services/managed/ManagedMediaJobClient";
import { ManagedJobRecoveryStore } from "../services/managed/ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../services/managed/adapters/ObsidianManagedRecoveryAdapter";
import { ManagedTranscriptionAdapter } from "../services/transcription/ManagedTranscriptionAdapter";
import { getTranscriptionMaxFileSize } from "../services/transcription/TranscriptionCoordinator";
import { ManagedVideoGenerationAdapter } from "../services/videos/ManagedVideoGenerationAdapter";
import { snapManagedVideoRequestToModel, type ManagedVideoModel } from "../services/videos/ManagedVideoModelCatalog";
import type { ManagedImageModel } from "../services/images/ManagedImageModelCatalog";
import { getVideoGenerationAvailability } from "../services/videos/VideoGenerationAvailability";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import type {
  StudioApiAdapter,
  StudioImageGenerationRequest,
  StudioImageGenerationResult,
  StudioManagedOperationRef,
  StudioTextGenerationRequest,
  StudioTextGenerationResult,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
  StudioVideoGenerationRequest,
  StudioVideoGenerationResult,
} from "./types";

function operationId(capability: "text" | "image" | "video" | "transcription", runId: string, nodeId: string): string {
  const value = `studio-${capability}-${runId}-${nodeId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Studio managed operation identity is invalid.");
  }
  return value;
}

export class StudioApiExecutionAdapter implements StudioApiAdapter {
  private readonly codexRuns = new StudioCodexRuns();
  dispose(): void { this.codexRuns.dispose(); }
  private readonly recovery: ManagedJobRecoveryStore;
  private readonly images: ManagedImageGenerationAdapter;
  private readonly videos: ManagedVideoGenerationAdapter;
  private readonly transcription: ManagedTranscriptionAdapter;

  constructor(private readonly plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    const jobs = new ManagedJobClient(graph.transport);
    const mediaJobs = new ManagedMediaJobClient(graph.transport);
    this.recovery = new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(plugin.app));
    this.images = new ManagedImageGenerationAdapter({
      admission: graph.admission,
      jobs: jobs.images,
      recovery: this.recovery,
    });
    // Video rides the negotiated media contract: frame stills upload through
    // the image input prepare endpoint, admission is the plain license check.
    this.videos = new ManagedVideoGenerationAdapter({
      availability: signal => getVideoGenerationAvailability(plugin, {}, signal),
      admission: () => graph.transport.getAdmission(),
      jobs: mediaJobs.videos,
      prepareFrames: mediaJobs.images.prepareInputs,
      recovery: this.recovery,
    });
    this.transcription = new ManagedTranscriptionAdapter({
      admission: graph.admission,
      jobs: jobs.transcription,
      recovery: this.recovery,
    });
  }

  async generateText(request: StudioTextGenerationRequest): Promise<StudioTextGenerationResult> {
    if (usesLocalCodex(this.plugin.settings)) {
      const payload = await request.buildPayload();
      const result = await this.codexRuns.run(codexRunKey(request.projectId || request.projectPath, request.nodeId), { ...codexOptionsFromSettings(this.plugin.settings), prompt: [payload.systemPrompt, payload.prompt].filter(Boolean).join('\n\n'), workingDirectory: codexVaultDirectory(this.plugin.app) }, request.signal, {
        log: text => request.log?.(text), thread: () => {}, request: (method, params, signal) => answerCodexRequest(this.plugin.app, method, params, signal),
      });
      return { text: result.text };
    }
    const id = operationId("text", request.runId, request.nodeId);
    const result = await this.plugin.getManagedCapabilityClient().generateText({
      operationId: id,
      purpose: "workflow_automation",
      signal: request.signal,
      buildMessages: async () => {
        const payload = await request.buildPayload();
        const prompt = String(payload.prompt || "").trim();
        const systemPrompt = String(payload.systemPrompt || "").trim();
        return [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user" as const, content: prompt },
        ];
      },
    });
    return {
      text: result.text,
      operation: { capability: "text_generation", operationId: result.operationId },
    };
  }

  async generateImage(request: StudioImageGenerationRequest): Promise<StudioImageGenerationResult> {
    const id = operationId("image", request.runId, request.nodeId);
    const result = await this.images.generate({
      operationId: id,
      sourceIdentity: `studio:${request.projectPath}:${request.runId}:${request.nodeId}`,
      signal: request.signal,
      buildPayload: async () => {
        const payload = await request.buildPayload();
        const model = await this.findImageModel(payload.model);
        const references = payload.inputImages || [];
        // The catalog is the per-model truth for inputs; a job the service
        // would reject fails here with the reason instead of after a hold.
        if (model && references.length > 0 && !model.supportsImageInput) {
          throw new Error(`${model.name} is text-only and does not accept reference images. Disconnect the images input or choose a model with image input.`);
        }
        if (model && references.length > model.maxInputReferences) {
          throw new Error(`${model.name} accepts at most ${model.maxInputReferences} reference image${model.maxInputReferences === 1 ? "" : "s"}; ${references.length} are connected.`);
        }
        return {
          prompt: payload.prompt,
          model: payload.model,
          imageSize: payload.imageSize,
          quality: payload.quality,
          count: model && payload.count !== undefined ? Math.min(payload.count, model.maxImages) : payload.count,
          aspectRatio: payload.aspectRatio,
          inputImages: references.map(input => ({
            mimeType: input.asset.mimeType as "image/png" | "image/jpeg" | "image/webp",
            sizeBytes: input.asset.sizeBytes,
            sha256: input.asset.hash,
            load: input.load,
          })),
        };
      },
    });
    const images = [];
    for (const output of result.outputs) {
      images.push(await request.storeOutput(output.bytes, output.metadata.mime_type));
    }
    return {
      images,
      operation: { capability: "image_generation", operationId: result.operationId },
    };
  }

  async generateVideo(request: StudioVideoGenerationRequest): Promise<StudioVideoGenerationResult> {
    const id = operationId("video", request.runId, request.nodeId);
    const result = await this.videos.generate({
      operationId: id,
      sourceIdentity: `studio:${request.projectPath}:${request.runId}:${request.nodeId}`,
      signal: request.signal,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      buildPayload: async () => {
        const payload = await request.buildPayload();
        const model = await this.findVideoModel(payload.model);
        for (const frame of payload.frameImages || []) {
          if (model && !model.supportedFrameRoles.includes(frame.role)) {
            throw new Error(`${model.name} does not accept a ${frame.role === "first_frame" ? "first" : "last"} frame. Disconnect that input or choose a model that supports it.`);
          }
        }
        const options = model
          ? snapManagedVideoRequestToModel(model, {
              durationSeconds: payload.durationSeconds,
              resolution: payload.resolution,
              aspectRatio: payload.aspectRatio,
              generateAudio: payload.generateAudio,
            })
          : payload;
        return {
          model: payload.model,
          prompt: payload.prompt,
          durationSeconds: options.durationSeconds,
          resolution: options.resolution,
          aspectRatio: options.aspectRatio,
          generateAudio: options.generateAudio,
          frameImages: (payload.frameImages || []).map(frame => ({
            role: frame.role,
            mimeType: frame.asset.mimeType as "image/png" | "image/jpeg" | "image/webp",
            sizeBytes: frame.asset.sizeBytes,
            sha256: frame.asset.hash,
            load: frame.load,
          })),
        };
      },
    });
    const videos = [];
    for (const output of result.outputs) {
      videos.push(await request.storeOutput(output.bytes, output.metadata.mime_type));
    }
    return {
      videos,
      operation: { capability: "video_generation", operationId: result.operationId },
    };
  }

  /**
   * Returns null when the catalog is unreachable or the model is unknown;
   * the raw request then goes through and the server stays the validator.
   */
  private async findVideoModel(modelId: string): Promise<ManagedVideoModel | null> {
    try {
      return (await getStudioMediaCatalogs(this.plugin).videos.load()).models.find(model => model.id === modelId) ?? null;
    } catch {
      return null;
    }
  }

  /** Blank means the service default; its capabilities are the ones that apply. */
  private async findImageModel(modelId: string | undefined): Promise<ManagedImageModel | null> {
    try {
      const snapshot = await getStudioMediaCatalogs(this.plugin).images.load();
      const id = modelId || snapshot.defaultModelId;
      return snapshot.models.find(model => model.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async transcribeAudio(request: StudioTranscriptionRequest): Promise<StudioTranscriptionResult> {
    const id = operationId("transcription", request.runId, request.nodeId);
    const result = await this.transcription.transcribe(request.source, {
      operationId: id,
      signal: request.signal,
      maxAudioBytes: getTranscriptionMaxFileSize(),
    });
    if (result.kind !== "transcript") {
      throw new Error("Studio transcription cannot recover a local commit receipt.");
    }
    return {
      text: result.text,
      operation: { capability: "transcription", operationId: result.operationId },
    };
  }

  async beginLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void> {
    for (const operation of operations) {
      if (operation.capability === "image_generation") {
        await this.images.beginLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "video_generation") {
        await this.videos.beginLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "transcription") {
        await this.transcription.beginLocalCommit(operation.operationId, signal);
      }
    }
  }

  async completeLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void> {
    for (const operation of operations) {
      if (operation.capability === "image_generation") {
        await this.images.completeLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "video_generation") {
        // The runtime commits once the run's artifacts are persisted, so the
        // clip was displayed and written by now; the delivery receipt records
        // both before the server acknowledgment closes the record.
        await this.videos.markDisplayed(operation.operationId, signal);
        await this.videos.markVaultWriteCompleted(operation.operationId, signal);
        await this.videos.completeLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "transcription") {
        await this.transcription.finalizePublishedLocalCommit(operation.operationId, signal);
      }
    }
  }
}
