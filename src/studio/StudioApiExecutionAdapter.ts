import type SystemSculptPlugin from "../main";
import { ManagedImageGenerationAdapter } from "../services/images/ManagedImageGenerationAdapter";
import { ManagedJobClient } from "../services/managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../services/managed/ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../services/managed/adapters/ObsidianManagedRecoveryAdapter";
import { ManagedTranscriptionAdapter } from "../services/transcription/ManagedTranscriptionAdapter";
import type {
  StudioApiAdapter,
  StudioImageGenerationRequest,
  StudioImageGenerationResult,
  StudioManagedOperationRef,
  StudioTextGenerationRequest,
  StudioTextGenerationResult,
  StudioTranscriptionRequest,
  StudioTranscriptionResult,
} from "./types";

function operationId(capability: "text" | "image" | "transcription", runId: string, nodeId: string): string {
  const value = `studio-${capability}-${runId}-${nodeId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Studio managed operation identity is invalid.");
  }
  return value;
}

export class StudioApiExecutionAdapter implements StudioApiAdapter {
  private readonly recovery: ManagedJobRecoveryStore;
  private readonly images: ManagedImageGenerationAdapter;
  private readonly transcription: ManagedTranscriptionAdapter;

  constructor(private readonly plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    const jobs = new ManagedJobClient(graph.transport);
    this.recovery = new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(plugin.app));
    this.images = new ManagedImageGenerationAdapter({
      admission: graph.admission,
      jobs: jobs.images,
      recovery: this.recovery,
    });
    this.transcription = new ManagedTranscriptionAdapter({
      admission: graph.admission,
      jobs: jobs.transcription,
      recovery: this.recovery,
    });
  }

  async generateText(request: StudioTextGenerationRequest): Promise<StudioTextGenerationResult> {
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
        return {
          prompt: payload.prompt,
          count: payload.count,
          aspectRatio: payload.aspectRatio,
          imageSize: payload.imageSize,
          seed: payload.seed,
          inputImages: (payload.inputImages || []).map(input => ({
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

  async transcribeAudio(request: StudioTranscriptionRequest): Promise<StudioTranscriptionResult> {
    const id = operationId("transcription", request.runId, request.nodeId);
    const result = await this.transcription.transcribe(request.source, {
      operationId: id,
      signal: request.signal,
    });
    return {
      text: result.text,
      operation: { capability: "transcription", operationId: result.operationId },
    };
  }

  async beginLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void> {
    for (const operation of operations) {
      if (operation.capability === "image_generation") {
        await this.images.beginLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "transcription") {
        await this.transcription.beginLocalCommit(operation.operationId, signal);
      }
    }
  }

  async completeLocalCommit(operations: readonly StudioManagedOperationRef[], signal?: AbortSignal): Promise<void> {
    for (const operation of operations) {
      if (operation.capability === "image_generation") {
        await this.images.completeLocalCommit(operation.operationId, signal);
      } else if (operation.capability === "transcription") {
        await this.transcription.completeLocalCommit(operation.operationId, signal);
      }
    }
  }
}
