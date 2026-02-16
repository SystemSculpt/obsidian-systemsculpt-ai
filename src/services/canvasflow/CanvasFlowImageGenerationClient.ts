import {
  SystemSculptImageGenerationService,
  type SystemSculptCreateGenerationJobRequest,
  type SystemSculptCreateGenerationJobResponse,
  type SystemSculptGenerationJobResponse,
} from "./SystemSculptImageGenerationService";

export type CanvasFlowImageGenerationClient = {
  createGenerationJob: (
    request: SystemSculptCreateGenerationJobRequest,
    options?: { idempotencyKey?: string }
  ) => Promise<SystemSculptCreateGenerationJobResponse>;
  waitForGenerationJob: (
    jobId: string,
    options?: {
      pollIntervalMs?: number;
      maxPollIntervalMs?: number;
      maxWaitMs?: number;
      pollUrl?: string;
      initialPollDelayMs?: number;
      signal?: AbortSignal;
      onUpdate?: (job: SystemSculptGenerationJobResponse) => void;
    }
  ) => Promise<SystemSculptGenerationJobResponse>;
  downloadImage: (url: string) => Promise<{ arrayBuffer: ArrayBuffer; contentType?: string }>;
};

export type CanvasFlowImageGenerationClientFactory = (options: {
  baseUrl: string;
  licenseKey: string;
  pluginVersion?: string;
}) => CanvasFlowImageGenerationClient;

export const createDefaultCanvasFlowImageGenerationClient: CanvasFlowImageGenerationClientFactory = (options) => {
  return new SystemSculptImageGenerationService(options);
};
