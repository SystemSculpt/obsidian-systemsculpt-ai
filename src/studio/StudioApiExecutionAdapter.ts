import { StudioCodexRuns, codexRunKey } from "../services/codex/StudioCodexRuns";
import { answerCodexRequest } from "../services/codex/CodexRequestModal";
import { codexOptionsFromSettings, codexVaultDirectory, localTextAgent } from "../services/codex/CodexExecutionSettings";
import { claudeOptionsFromSettings, runLocalClaude } from "../services/claude/LocalClaudeClient";
import { answerClaudePermission } from "../services/claude/ClaudeRequestModal";
import type SystemSculptPlugin from "../main";
import { ManagedJobClient } from "../services/managed/ManagedJobClient";
import { ManagedMediaJobClient } from "../services/managed/ManagedMediaJobClient";
import type { ManagedJobRecoveryStore } from "../services/managed/ManagedJobRecoveryStore";
import { ManagedTranscriptionAdapter } from "../services/transcription/ManagedTranscriptionAdapter";
import { getTranscriptionMaxFileSize } from "../services/transcription/TranscriptionCoordinator";
import { ManagedVideoGenerationAdapter } from "../services/videos/ManagedVideoGenerationAdapter";
import { snapManagedVideoRequestToModel, type ManagedVideoModel } from "../services/videos/ManagedVideoModelCatalog";
import { getVideoGenerationAvailability } from "../services/videos/VideoGenerationAvailability";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import type {
  StudioApiAdapter,
  StudioManagedOperationRef,
  StudioTextGenerationRequest,
  StudioTextGenerationResult,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
  StudioVideoGenerationRequest,
  StudioVideoGenerationResult,
} from "./types";

function operationId(capability: "text" | "video" | "transcription", runId: string, nodeId: string): string {
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
  private readonly videos: ManagedVideoGenerationAdapter;
  private readonly transcription: ManagedTranscriptionAdapter;

  constructor(private readonly plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    const jobs = new ManagedJobClient(graph.transport);
    const mediaJobs = new ManagedMediaJobClient(graph.transport);
    this.recovery = graph.recovery;
    // Video rides the negotiated media contract: frame stills upload through
    // the image input prepare endpoint, admission is the plain license check,
    // through the shared admission cache.
    this.videos = new ManagedVideoGenerationAdapter({
      availability: signal => getVideoGenerationAvailability(plugin, {}, signal),
      admission: signal => graph.admission.checkLicense(signal),
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
    const localAgent = localTextAgent(this.plugin.settings);
    if (localAgent) {
      const payload = await request.buildPayload();
      const key = codexRunKey(request.projectId || request.projectPath, request.nodeId);
      const prompt = [payload.systemPrompt, payload.prompt].filter(Boolean).join('\n\n'), workingDirectory = codexVaultDirectory(this.plugin.app);
      const result = localAgent === 'claude'
        ? await this.codexRuns.track(key, 'claude', request.signal, (signal, thread) => runLocalClaude({ ...claudeOptionsFromSettings(this.plugin.settings), prompt, workingDirectory }, signal, {
          log: text => request.log?.(text), session: thread, permission: (permission, permissionSignal) => answerClaudePermission(this.plugin.app, permission, permissionSignal),
        }))
        : await this.codexRuns.run(key, { ...codexOptionsFromSettings(this.plugin.settings), prompt, workingDirectory }, request.signal, {
          log: text => request.log?.(text), thread: () => {}, request: (method, params, signal) => answerCodexRequest(this.plugin.app, method, params, signal),
        });
      return { text: result.text };
    }
    const id = operationId("text", request.runId, request.nodeId);
    const result = await this.plugin.getManagedCapabilityGraph().textGeneration.generate({
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

  async generateVideo(request: StudioVideoGenerationRequest): Promise<StudioVideoGenerationResult> {
    const id = operationId("video", request.runId, request.nodeId);
    const result = await this.videos.generate({
      operationId: id,
      sourceIdentity: `studio:${request.projectPath}:${request.runId}:${request.nodeId}`,
      signal: request.signal,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      buildPayload: async () => {
        const payload = await request.buildPayload();
        const model = await this.findVideoModel(payload.model, request.signal);
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
  private async findVideoModel(modelId: string, signal?: AbortSignal): Promise<ManagedVideoModel | null> {
    try {
      return (await getStudioMediaCatalogs(this.plugin).videos.load(signal)).models.find(model => model.id === modelId) ?? null;
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
      if (operation.capability === "video_generation") {
        await this.videos.beginLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "transcription") {
        await this.transcription.beginLocalCommit(operation.operationId, signal);
      }
    }
  }

  async completeLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void> {
    for (const operation of operations) {
      if (operation.capability === "video_generation") {
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
