import { App, Notice, TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { API_BASE_URL } from "../../constants/api";
import { resolveSystemSculptApiBaseUrl } from "../../utils/urlHelpers";
import {
  addEdge,
  addFileNode,
  addTextNode,
  type CanvasDocument,
  type CanvasNode,
  computeNextNodePosition,
  findIncomingImageFilesForNode,
  indexCanvas,
  isCanvasFileNode,
  parseCanvasDocument,
  serializeCanvasDocument,
} from "./CanvasFlowGraph";
import { parseCanvasFlowPromptNote } from "./PromptNote";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  getCuratedImageGenerationModel,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";
import {
  type SystemSculptGenerationJobResponse,
  type SystemSculptImageGenerationOutput,
} from "./SystemSculptImageGenerationService";
import {
  createDefaultCanvasFlowImageGenerationClient,
  type CanvasFlowImageGenerationClient,
  type CanvasFlowImageGenerationClientFactory,
} from "./CanvasFlowImageGenerationClient";
import {
  DEFAULT_CANVASFLOW_OUTPUT_DIR,
  resolveCanvasFlowOutputDirectory,
  resolveCanvasFlowSafeFileStem,
} from "./CanvasFlowStoragePaths";

type RunStatusUpdater = (status: string) => void;
const MAX_CANVASFLOW_INPUT_IMAGES = 8;

type CanvasFlowResolvedPromptRunContext = {
  baseUrl: string;
  canvasDoc: CanvasDocument;
  promptNode: CanvasNode & { file: string };
  promptFile: TFile;
  promptText: string;
  modelId: string;
  modelDisplayName: string;
  imageCount: number;
  aspectRatio?: string;
  seed: number | null;
};

type CanvasFlowCollectedInputImages = {
  inputImages: Array<{ type: "data_url"; data_url: string }>;
  inputImagePaths: string[];
  connectedImageCount: number;
  missingInputImageCount: number;
  ignoredInputImageCount: number;
};

type CanvasFlowSavedOutput = {
  output: SystemSculptImageGenerationOutput;
  imagePath: string;
};

type CanvasFlowGenerationRunResult = {
  jobId: string;
  pollUrl?: string;
  finalJob: SystemSculptGenerationJobResponse;
};

type CanvasFlowOutputSlot = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CanvasFlowGenerationPlaceholderSession = {
  canvasDoc: CanvasDocument;
  placeholderNodeIds: string[];
  outputSlots: CanvasFlowOutputSlot[];
  phase: string;
  startedAtMs: number;
  spinnerFrame: number;
  updateTimerId: ReturnType<typeof setInterval> | null;
  updateQueue: Promise<void>;
  stopped: boolean;
};

const CANVASFLOW_PLACEHOLDER_SPINNER_FRAMES = ["|", "/", "-", "\\", "|", "/", "-", "\\"];
const CANVASFLOW_PLACEHOLDER_TICK_MS = 1000;

function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function mimeFromExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "png") return "image/png";
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  return "application/octet-stream";
}

function extensionFromContentType(contentType: string | undefined): string | null {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return null;
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/jpeg")) return "jpg";
  if (ct.includes("image/webp")) return "webp";
  if (ct.includes("image/gif")) return "gif";
  return null;
}

function extensionFromMimeType(mimeType: string | undefined): string | null {
  return extensionFromContentType(mimeType);
}

function extensionFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname || "";
    const last = path.split("/").pop() || "";
    const ext = last.includes(".") ? last.split(".").pop() || "" : "";
    const clean = ext.toLowerCase();
    if (clean === "png" || clean === "jpg" || clean === "jpeg" || clean === "webp" || clean === "gif") {
      return clean === "jpeg" ? "jpg" : clean;
    }
    return null;
  } catch {
    return null;
  }
}

function isRetryableDownloadStatus(status: number): boolean {
  if (!Number.isFinite(status)) return false;
  return status === 404 || status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function nowStamp(): { iso: string; compact: string } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const compact = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { iso: d.toISOString(), compact };
}

function formatImageModelDisplayName(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): string {
  const id = String(modelId || "").trim();
  const entry = getCuratedImageGenerationModel(id, serverModels);
  return entry?.label || id || "OpenRouter";
}

function formatImageModelFileBase(
  modelId: string,
  serverModels?: readonly ImageGenerationServerCatalogModel[]
): string {
  const id = String(modelId || "").trim();
  const entry = getCuratedImageGenerationModel(id, serverModels);
  if (entry?.label) return entry.label;
  return id.replace(/[\\/]+/g, "-") || "generation";
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (!normalized) return;
  const exists = await app.vault.adapter.exists(normalized);
  if (exists) return;

  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const segmentExists = await app.vault.adapter.exists(current);
    if (segmentExists) continue;
    await app.vault.createFolder(current);
  }
}

async function getAvailableFilePath(app: App, folderPath: string, baseName: string, ext: string): Promise<string> {
  const safeBase = resolveCanvasFlowSafeFileStem(baseName);
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const candidate = normalizePath(`${folderPath}/${safeBase}${suffix}.${ext}`);
    if (!app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
  return normalizePath(`${folderPath}/${safeBase}-${Date.now().toString(16)}.${ext}`);
}

function base64FromArrayBuffer(arrayBuffer: ArrayBuffer): string {
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));
  return buffer.toString("base64");
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${stableSerialize(obj[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hashFnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseAspectRatioValue(aspectRatio: string | undefined): number | null {
  const raw = String(aspectRatio || "").trim().toLowerCase();
  if (!raw) return null;

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

function resolveOutputFrameForAspectRatio(aspectRatio: string | undefined): { width: number; height: number } {
  const ratio = parseAspectRatioValue(aspectRatio);
  const longSide = 320;
  if (!ratio) return { width: longSide, height: longSide };

  if (ratio >= 1) {
    return {
      width: longSide,
      height: Math.max(160, Math.round(longSide / ratio)),
    };
  }

  return {
    width: Math.max(160, Math.round(longSide * ratio)),
    height: longSide,
  };
}

function formatElapsedTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizePlaceholderPhase(phase: string): string {
  const compact = String(phase || "").replace(/\s+/g, " ").trim();
  if (!compact) return "Preparing generation...";

  const lower = compact.toLowerCase();
  if (lower.includes("reading input image")) return "Preparing input images...";
  if (lower.includes("submitting generation job")) return "Submitting generation job...";
  if (lower.includes("starting generation")) return "Queued for generation...";
  if (lower.includes("generating image")) return "Generating images...";
  if (lower.includes("refreshing output url")) return "Refreshing output links...";
  if (lower.includes("retrying download")) return "Retrying output download...";
  if (lower.includes("downloading generated image")) return "Downloading generated images...";
  if (lower.includes("updating canvas")) return "Placing images on canvas...";
  if (lower.includes("missing") && lower.includes("input image")) return "Some input images are missing.";

  if (compact.length <= 56) return compact;
  return `${compact.slice(0, 53)}...`;
}

function formatPlaceholderText(options: {
  imageIndex: number;
  imageCount: number;
  spinnerFrame: number;
  phase: string;
  elapsedMs: number;
}): string {
  const spinner =
    CANVASFLOW_PLACEHOLDER_SPINNER_FRAMES[
      Math.abs(options.spinnerFrame) % CANVASFLOW_PLACEHOLDER_SPINNER_FRAMES.length
    ] || "|";
  const imageLabel = options.imageCount > 1 ? `Image ${options.imageIndex} of ${options.imageCount}` : "Image 1 of 1";
  return `SystemSculpt CanvasFlow\n${imageLabel}  ${spinner}\n${normalizePlaceholderPhase(options.phase)}\nElapsed ${formatElapsedTimer(options.elapsedMs)}`;
}

export class CanvasFlowRunner {
  private readonly imageClientFactory: CanvasFlowImageGenerationClientFactory;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    options?: { imageClientFactory?: CanvasFlowImageGenerationClientFactory }
  ) {
    this.imageClientFactory = options?.imageClientFactory || createDefaultCanvasFlowImageGenerationClient;
  }

  private getCachedImageGenerationModels(): ImageGenerationServerCatalogModel[] {
    const raw = this.plugin.settings.imageGenerationModelCatalogCache?.models;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((model) => ({
        id: String((model as any)?.id || "").trim(),
        name: String((model as any)?.name || "").trim() || undefined,
        provider: String((model as any)?.provider || "").trim() || undefined,
        input_modalities: Array.isArray((model as any)?.input_modalities)
          ? (model as any).input_modalities.map((value: unknown) => String(value || ""))
          : undefined,
        output_modalities: Array.isArray((model as any)?.output_modalities)
          ? (model as any).output_modalities.map((value: unknown) => String(value || ""))
          : undefined,
        supports_image_input:
          typeof (model as any)?.supports_image_input === "boolean"
            ? (model as any).supports_image_input
            : undefined,
        max_images_per_job:
          typeof (model as any)?.max_images_per_job === "number" && Number.isFinite((model as any).max_images_per_job)
            ? Math.max(1, Math.floor((model as any).max_images_per_job))
            : undefined,
        default_aspect_ratio: String((model as any)?.default_aspect_ratio || "").trim() || undefined,
        allowed_aspect_ratios: Array.isArray((model as any)?.allowed_aspect_ratios)
          ? (model as any).allowed_aspect_ratios.map((value: unknown) => String(value || ""))
          : undefined,
      }))
      .filter((model) => model.id.length > 0);
  }

  private resolveMaxImagesPerJob(modelId: string): number {
    const curated = getCuratedImageGenerationModel(modelId, this.getCachedImageGenerationModels());
    const raw = Number(curated?.maxImagesPerJob);
    if (!Number.isFinite(raw)) return 1;
    return Math.max(1, Math.floor(raw));
  }

  async runPromptNode(options: {
    canvasFile: TFile;
    promptNodeId: string;
    status?: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<void> {
    const setStatus = options.status || (() => {});
    const licenseKey = String(this.plugin.settings.licenseKey || "").trim();
    if (!licenseKey) {
      throw new Error("License key is not configured. Validate your license in Settings -> Setup.");
    }

    const baseUrl = resolveSystemSculptApiBaseUrl(String(this.plugin.settings.serverUrl || API_BASE_URL));
    const context = await this.resolvePromptRunContext({
      canvasFile: options.canvasFile,
      promptNodeId: options.promptNodeId,
      baseUrl,
    });

    const client = this.imageClientFactory({
      baseUrl: context.baseUrl,
      licenseKey,
      pluginVersion: this.plugin.manifest?.version ?? "0.0.0",
    });

    let workingCanvasDoc = context.canvasDoc;
    let placeholderSession: CanvasFlowGenerationPlaceholderSession | null = null;

    const setStatusWithPlaceholders = (statusText: string): void => {
      setStatus(statusText);
      if (!placeholderSession || placeholderSession.stopped) return;
      placeholderSession.phase = String(statusText || "").trim() || placeholderSession.phase;
    };

    try {
      placeholderSession = await this.createGenerationPlaceholderSession({
        canvasFile: options.canvasFile,
        canvasDoc: workingCanvasDoc,
        promptNode: context.promptNode,
        promptNodeId: options.promptNodeId,
        imageCount: context.imageCount,
        aspectRatio: context.aspectRatio,
      });
      if (placeholderSession) {
        workingCanvasDoc = placeholderSession.canvasDoc;
        setStatusWithPlaceholders("Preparing generation...");
      }

      const collectedInputs = await this.collectInputImages({
        canvasDoc: workingCanvasDoc,
        promptNodeId: options.promptNodeId,
        status: setStatusWithPlaceholders,
        signal: options.signal,
      });

      if (collectedInputs.ignoredInputImageCount > 0) {
        new Notice(
          `SystemSculpt CanvasFlow: using ${collectedInputs.inputImages.length} input images (ignored ${collectedInputs.ignoredInputImageCount} beyond limit ${MAX_CANVASFLOW_INPUT_IMAGES}).`
        );
      }
      if (collectedInputs.connectedImageCount > 0 && collectedInputs.inputImages.length === 0) {
        setStatusWithPlaceholders("Input images missing; running prompt without image input.");
      } else if (collectedInputs.missingInputImageCount > 0) {
        setStatusWithPlaceholders(
          `Missing ${collectedInputs.missingInputImageCount} input image(s); continuing with ${collectedInputs.inputImages.length} image(s).`
        );
      }

      const desiredImageCount = Math.max(1, Math.min(4, Math.floor(context.imageCount || 1)));
      const maxPerJob = this.resolveMaxImagesPerJob(context.modelId);
      const savedOutputs: CanvasFlowSavedOutput[] = [];
      const maxBatchRuns = Math.max(3, desiredImageCount * 3);
      let batchRunCount = 0;

      if (desiredImageCount > maxPerJob) {
        const runs = Math.ceil(desiredImageCount / maxPerJob);
        setStatusWithPlaceholders(`Model limit is ${maxPerJob} image(s) per run; generating in ${runs} runs...`);
      }

      while (savedOutputs.length < desiredImageCount && batchRunCount < maxBatchRuns) {
        const remaining = desiredImageCount - savedOutputs.length;
        const batchCount = Math.max(1, Math.min(remaining, maxPerJob));
        const batchIndex = batchRunCount + 1;
        const batchSeed =
          context.seed !== null && Number.isFinite(context.seed) ? Math.max(0, Math.floor(context.seed + savedOutputs.length)) : null;

        if (batchRunCount > 0) {
          setStatusWithPlaceholders(
            desiredImageCount > 1
              ? `Generating remaining images (${savedOutputs.length + 1}-${savedOutputs.length + batchCount} of ${desiredImageCount})...`
              : "Generating image..."
          );
        }

        const generationRun = await this.submitAndAwaitGeneration({
          runScopeKey: `${options.canvasFile.path}::${options.promptNodeId}::batch-${batchIndex}`,
          client,
          modelId: context.modelId,
          promptText: context.promptText,
          inputImages: collectedInputs.inputImages,
          imageCount: batchCount,
          aspectRatio: context.aspectRatio,
          seed: batchSeed,
          status: setStatusWithPlaceholders,
          signal: options.signal,
        });
        batchRunCount += 1;

        const outputs = generationRun.finalJob.outputs.filter((output) => isHttpUrl(String(output.url || "")));
        if (outputs.length === 0) {
          if (savedOutputs.length === 0) {
            throw new Error("Image generation completed, but no output URLs were returned.");
          }
          break;
        }

        const outputsNeeded = outputs.slice(0, remaining);
        const savedBatch = await this.saveGeneratedOutputs({
          client,
          outputs: outputsNeeded,
          generationJobId: generationRun.jobId,
          pollUrl: generationRun.pollUrl,
          modelId: context.modelId,
          promptFile: context.promptFile,
          promptText: context.promptText,
          inputImagePaths: collectedInputs.inputImagePaths,
          job: generationRun.finalJob,
          status: setStatusWithPlaceholders,
          signal: options.signal,
        });
        savedOutputs.push(...savedBatch);

        if (savedOutputs.length < desiredImageCount) {
          const remainingAfterBatch = desiredImageCount - savedOutputs.length;
          setStatusWithPlaceholders(
            `Model returned ${savedOutputs.length}/${desiredImageCount} image(s); generating ${remainingAfterBatch} more...`
          );
        }
      }

      if (savedOutputs.length === 0) {
        throw new Error("Image generation completed, but no output URLs were returned.");
      }
      if (savedOutputs.length < desiredImageCount) {
        const missingCount = desiredImageCount - savedOutputs.length;
        new Notice(
          `SystemSculpt CanvasFlow: generated ${savedOutputs.length}/${desiredImageCount} image(s). ${missingCount} image(s) were not returned by the provider.`
        );
      }

      if (placeholderSession) {
        await this.stopGenerationPlaceholderSession(placeholderSession);
        workingCanvasDoc = await this.replacePlaceholderNodesWithOutputs({
          canvasFile: options.canvasFile,
          canvasDoc: placeholderSession.canvasDoc,
          promptNodeId: options.promptNodeId,
          placeholderNodeIds: placeholderSession.placeholderNodeIds,
          outputSlots: placeholderSession.outputSlots,
          savedOutputs,
          status: setStatusWithPlaceholders,
        });
      } else {
        await this.attachGeneratedOutputsToCanvas({
          canvasFile: options.canvasFile,
          canvasDoc: workingCanvasDoc,
          promptNode: context.promptNode,
          promptNodeId: options.promptNodeId,
          savedOutputs,
          aspectRatio: context.aspectRatio,
          status: setStatusWithPlaceholders,
        });
      }

      setStatus("Done.");
      if (savedOutputs.length === 1) {
        new Notice(`SystemSculpt: generated ${savedOutputs[0].imagePath} (${context.modelDisplayName})`);
      } else {
        new Notice(`SystemSculpt: generated ${savedOutputs.length} images (${context.modelDisplayName})`);
      }
    } catch (error) {
      if (placeholderSession) {
        try {
          await this.stopGenerationPlaceholderSession(placeholderSession);
          await this.removePlaceholderNodes({
            canvasFile: options.canvasFile,
            canvasDoc: placeholderSession.canvasDoc,
            placeholderNodeIds: placeholderSession.placeholderNodeIds,
          });
        } catch {
          // Placeholder cleanup is best-effort.
        }
      }
      throw error;
    }
  }

  private computeOutputSlots(options: {
    promptNode: CanvasNode;
    imageCount: number;
    aspectRatio?: string;
  }): CanvasFlowOutputSlot[] {
    const outputCount = Math.max(1, Math.floor(options.imageCount || 1));
    const frame = resolveOutputFrameForAspectRatio(options.aspectRatio);
    const placed = computeNextNodePosition(options.promptNode, {
      dx: 80,
      defaultWidth: frame.width,
      defaultHeight: frame.height,
    });
    const gapX = 80;
    const slots: CanvasFlowOutputSlot[] = [];
    for (let idx = 0; idx < outputCount; idx += 1) {
      slots.push({
        x: placed.x + idx * (placed.width + gapX),
        y: placed.y,
        width: placed.width,
        height: placed.height,
      });
    }
    return slots;
  }

  private async createGenerationPlaceholderSession(options: {
    canvasFile: TFile;
    canvasDoc: CanvasDocument;
    promptNode: CanvasNode;
    promptNodeId: string;
    imageCount: number;
    aspectRatio?: string;
  }): Promise<CanvasFlowGenerationPlaceholderSession | null> {
    try {
      const outputSlots = this.computeOutputSlots({
        promptNode: options.promptNode,
        imageCount: options.imageCount,
        aspectRatio: options.aspectRatio,
      });
      let updatedDoc = options.canvasDoc;
      const placeholderNodeIds: string[] = [];

      for (const [idx, slot] of outputSlots.entries()) {
        const added = addTextNode(updatedDoc, {
          text: formatPlaceholderText({
            imageIndex: idx + 1,
            imageCount: outputSlots.length,
            phase: "Preparing generation...",
            elapsedMs: 0,
            spinnerFrame: idx,
          }),
          x: slot.x,
          y: slot.y,
          width: slot.width,
          height: slot.height,
        });
        updatedDoc = added.doc;
        placeholderNodeIds.push(added.nodeId);
        updatedDoc = addEdge(updatedDoc, { fromNode: options.promptNodeId, toNode: added.nodeId }).doc;
      }

      await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));

      const session: CanvasFlowGenerationPlaceholderSession = {
        canvasDoc: updatedDoc,
        placeholderNodeIds,
        outputSlots,
        phase: "Preparing generation...",
        startedAtMs: Date.now(),
        spinnerFrame: 0,
        updateTimerId: null,
        updateQueue: Promise.resolve(),
        stopped: false,
      };

      this.enqueuePlaceholderRender({
        canvasFile: options.canvasFile,
        session,
      });
      session.updateTimerId = setInterval(() => {
        this.enqueuePlaceholderRender({
          canvasFile: options.canvasFile,
          session,
        });
      }, CANVASFLOW_PLACEHOLDER_TICK_MS);
      return session;
    } catch {
      return null;
    }
  }

  private enqueuePlaceholderRender(options: {
    canvasFile: TFile;
    session: CanvasFlowGenerationPlaceholderSession;
  }): void {
    const { session } = options;
    if (session.stopped) return;

    session.updateQueue = session.updateQueue
      .catch(() => {})
      .then(async () => {
        if (session.stopped) return;

        session.spinnerFrame += 1;
        const elapsedMs = Date.now() - session.startedAtMs;
        const nodesById = indexCanvas(session.canvasDoc).nodesById;

        for (const [idx, nodeId] of session.placeholderNodeIds.entries()) {
          const node = nodesById.get(nodeId);
          if (!node) continue;
          const slot = session.outputSlots[idx];
          if (!slot) continue;

          node.type = "text";
          node.x = slot.x;
          node.y = slot.y;
          node.width = slot.width;
          node.height = slot.height;
          node.text = formatPlaceholderText({
            imageIndex: idx + 1,
            imageCount: session.placeholderNodeIds.length,
            phase: session.phase,
            elapsedMs,
            spinnerFrame: session.spinnerFrame + idx,
          });
          delete (node as any).file;
          delete (node as any).label;
          delete (node as any).url;
        }

        await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(session.canvasDoc));
      });
  }

  private async stopGenerationPlaceholderSession(session: CanvasFlowGenerationPlaceholderSession): Promise<void> {
    if (session.stopped) return;
    session.stopped = true;
    if (session.updateTimerId !== null) {
      clearInterval(session.updateTimerId);
      session.updateTimerId = null;
    }
    await session.updateQueue.catch(() => {});
  }

  private async replacePlaceholderNodesWithOutputs(options: {
    canvasFile: TFile;
    canvasDoc: CanvasDocument;
    promptNodeId: string;
    placeholderNodeIds: string[];
    outputSlots: CanvasFlowOutputSlot[];
    savedOutputs: CanvasFlowSavedOutput[];
    status: RunStatusUpdater;
  }): Promise<CanvasDocument> {
    options.status("Updating canvas...");
    const placeholderSet = new Set(options.placeholderNodeIds);
    let updatedDoc: CanvasDocument = {
      ...options.canvasDoc,
      nodes: options.canvasDoc.nodes.filter((node) => !placeholderSet.has(node.id)),
      edges: options.canvasDoc.edges.filter(
        (edge) => !placeholderSet.has(edge.fromNode) && !placeholderSet.has(edge.toNode)
      ),
    };

    for (const [idx, saved] of options.savedOutputs.entries()) {
      const slot = options.outputSlots[idx];
      if (!slot) continue;
      const added = addFileNode(updatedDoc, {
        filePath: saved.imagePath,
        x: slot.x,
        y: slot.y,
        width: slot.width,
        height: slot.height,
      });
      updatedDoc = added.doc;
      updatedDoc = addEdge(updatedDoc, { fromNode: options.promptNodeId, toNode: added.nodeId }).doc;
    }

    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));
    return updatedDoc;
  }

  private async removePlaceholderNodes(options: {
    canvasFile: TFile;
    canvasDoc: CanvasDocument;
    placeholderNodeIds: string[];
  }): Promise<CanvasDocument> {
    const placeholderSet = new Set(options.placeholderNodeIds);
    const updatedDoc: CanvasDocument = {
      ...options.canvasDoc,
      nodes: options.canvasDoc.nodes.filter((node) => !placeholderSet.has(node.id)),
      edges: options.canvasDoc.edges.filter((edge) => !placeholderSet.has(edge.fromNode) && !placeholderSet.has(edge.toNode)),
    };
    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));
    return updatedDoc;
  }

  private async resolvePromptRunContext(options: {
    canvasFile: TFile;
    promptNodeId: string;
    baseUrl: string;
  }): Promise<CanvasFlowResolvedPromptRunContext> {
    const canvasRaw = await this.app.vault.read(options.canvasFile);
    const canvasDoc = parseCanvasDocument(canvasRaw);
    if (!canvasDoc) {
      throw new Error("Failed to parse .canvas JSON.");
    }

    const { nodesById } = indexCanvas(canvasDoc);
    const promptNode = nodesById.get(options.promptNodeId);
    if (!promptNode || !isCanvasFileNode(promptNode)) {
      throw new Error("Prompt node not found (or not a file node).");
    }

    const promptFilePath = promptNode.file;
    const promptAbstract = this.app.vault.getAbstractFileByPath(promptFilePath);
    if (!(promptAbstract instanceof TFile)) {
      throw new Error(`Prompt file not found: ${promptFilePath}`);
    }

    const promptMarkdown = await this.app.vault.read(promptAbstract);
    const promptParsed = parseCanvasFlowPromptNote(promptMarkdown);
    if (!promptParsed.ok) {
      throw new Error(
        promptParsed.reason === "not-canvasflow-prompt"
          ? "This node's file is not a SystemSculpt prompt note. Add ss_flow_kind: prompt in frontmatter."
          : `Prompt note invalid: ${promptParsed.reason}`
      );
    }

    const promptText = String(promptParsed.body || "").trim();
    if (!promptText) {
      throw new Error("Prompt is empty.");
    }

    const modelId =
      String(promptParsed.config.imageModelId || "").trim() ||
      String(this.plugin.settings.imageGenerationDefaultModelId || "").trim() ||
      DEFAULT_IMAGE_GENERATION_MODEL_ID;
    if (!modelId) {
      throw new Error(
        "No image model set. Choose a default model in Settings -> Image Generation, or set ss_image_model in the prompt note."
      );
    }

    const cachedServerModels = this.getCachedImageGenerationModels();
    return {
      baseUrl: options.baseUrl,
      canvasDoc,
      promptNode,
      promptFile: promptAbstract,
      promptText,
      modelId,
      modelDisplayName: formatImageModelDisplayName(modelId, cachedServerModels),
      imageCount: Math.max(1, Math.min(4, Math.floor(promptParsed.config.imageCount || 1))),
      aspectRatio: String(promptParsed.config.aspectRatio || "").trim() || undefined,
      seed: promptParsed.config.seed,
    };
  }

  private async collectInputImages(options: {
    canvasDoc: CanvasDocument;
    promptNodeId: string;
    status: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<CanvasFlowCollectedInputImages> {
    const connectedImages = findIncomingImageFilesForNode(options.canvasDoc, options.promptNodeId);
    const inputImages: Array<{ type: "data_url"; data_url: string }> = [];
    const inputImagePaths: string[] = [];
    let missingInputImageCount = 0;
    let ignoredInputImageCount = 0;

    for (const [idx, incomingImage] of connectedImages.entries()) {
      if (options.signal?.aborted) {
        throw new Error("Aborted");
      }

      options.status(
        connectedImages.length > 1
          ? `Reading input images (${idx + 1}/${connectedImages.length})...`
          : "Reading input image..."
      );

      const imageAbs = this.app.vault.getAbstractFileByPath(incomingImage.imagePath);
      if (!(imageAbs instanceof TFile)) {
        missingInputImageCount += 1;
        continue;
      }
      if (inputImages.length >= MAX_CANVASFLOW_INPUT_IMAGES) {
        ignoredInputImageCount += 1;
        continue;
      }

      const imgBytes = await this.app.vault.readBinary(imageAbs);
      const ext = String(imageAbs.extension || "").toLowerCase();
      const mime = mimeFromExtension(ext);
      const b64 = base64FromArrayBuffer(imgBytes);
      inputImages.push({
        type: "data_url",
        data_url: `data:${mime};base64,${b64}`,
      });
      inputImagePaths.push(incomingImage.imagePath);
    }

    return {
      inputImages,
      inputImagePaths,
      connectedImageCount: connectedImages.length,
      missingInputImageCount,
      ignoredInputImageCount,
    };
  }

  private async submitAndAwaitGeneration(options: {
    runScopeKey: string;
    client: CanvasFlowImageGenerationClient;
    modelId: string;
    promptText: string;
    inputImages: Array<{ type: "data_url"; data_url: string }>;
    imageCount: number;
    aspectRatio?: string;
    seed: number | null;
    status: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<CanvasFlowGenerationRunResult> {
    options.status("Submitting generation job...");
    const runAttemptId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const payloadSignature = stableSerialize({
      model: options.modelId,
      prompt: options.promptText,
      options: {
        count: options.imageCount,
        aspect_ratio: options.aspectRatio || null,
        seed: options.seed,
      },
      input_images: options.inputImages.map((input) => ({
        type: input.type,
        digest: hashFnv1a(input.data_url),
      })),
    });
    const idempotencyKey = `images-job:${hashFnv1a(options.runScopeKey)}:${hashFnv1a(payloadSignature)}:${runAttemptId}`;
    const job = await options.client.createGenerationJob({
      model: options.modelId,
      prompt: options.promptText,
      input_images: options.inputImages,
      options: {
        count: options.imageCount,
        ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
        ...(options.seed !== null && Number.isFinite(options.seed) ? { seed: options.seed } : {}),
      },
    }, { idempotencyKey });

    const jobId = String(job.job?.id || "").trim();
    if (!jobId) {
      throw new Error("Image generation API did not return a job id.");
    }

    const pollUrl = String(job.poll_url || "").trim() || undefined;
    options.status("Starting generation...");
    const finalJob = await options.client.waitForGenerationJob(jobId, {
      pollIntervalMs: this.plugin.settings.imageGenerationPollIntervalMs ?? 1000,
      pollUrl,
      initialPollDelayMs: 600,
      signal: options.signal,
      onUpdate: (status) => {
        const s = String(status.job?.status || "").trim();
        if (s === "queued") {
          options.status("Starting generation...");
        } else if (s === "processing") {
          options.status(options.imageCount > 1 ? "Generating images..." : "Generating image...");
        }
      },
    });

    return {
      jobId,
      pollUrl,
      finalJob,
    };
  }

  private async saveGeneratedOutputs(options: {
    client: CanvasFlowImageGenerationClient;
    outputs: SystemSculptImageGenerationOutput[];
    generationJobId: string;
    pollUrl?: string;
    modelId: string;
    promptFile: TFile;
    promptText: string;
    inputImagePaths: string[];
    job: SystemSculptGenerationJobResponse;
    status: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<CanvasFlowSavedOutput[]> {
    const configuredOutputDir =
      String(this.plugin.settings.imageGenerationOutputDir || "").trim() || DEFAULT_CANVASFLOW_OUTPUT_DIR;
    const outputDir = resolveCanvasFlowOutputDirectory(configuredOutputDir);
    if (normalizePath(configuredOutputDir) !== outputDir) {
      options.status(`Output directory adjusted to safe path: ${outputDir}`);
    }
    await ensureFolder(this.app, outputDir);

    const stamp = nowStamp();
    const generatorBaseName = formatImageModelFileBase(options.modelId, this.getCachedImageGenerationModels());
    const saved: CanvasFlowSavedOutput[] = [];

    for (const [idx, output] of options.outputs.entries()) {
      if (options.signal?.aborted) {
        throw new Error("Aborted");
      }

      const imageOrdinal = idx + 1;
      options.status(
        options.outputs.length > 1
          ? `Downloading generated image (${imageOrdinal}/${options.outputs.length})...`
          : "Downloading generated image..."
      );
      let outputToDownload = output;
      let download: { arrayBuffer: ArrayBuffer; contentType?: string } | null = null;
      let refreshedUrlTried = false;

      while (!download) {
        try {
          download = await options.client.downloadImage(outputToDownload.url);
        } catch (error: any) {
          const status = Number(error?.status);
          const canRefreshAndRetry =
            !refreshedUrlTried &&
            isRetryableDownloadStatus(status) &&
            String(options.generationJobId || "").trim().length > 0;

          if (!canRefreshAndRetry) {
            throw error;
          }

          refreshedUrlTried = true;
          options.status(
            options.outputs.length > 1
              ? `Refreshing output URL (${imageOrdinal}/${options.outputs.length})...`
              : "Refreshing output URL..."
          );
          const refreshedOutput = await this.refreshOutputUrlFromGenerationJob({
            client: options.client,
            generationJobId: options.generationJobId,
            pollUrl: options.pollUrl,
            originalOutput: output,
            outputOrdinal: imageOrdinal,
            status: options.status,
            signal: options.signal,
          });
          if (!refreshedOutput || !isHttpUrl(String(refreshedOutput.url || ""))) {
            throw error;
          }

          const previousUrl = String(outputToDownload.url || "").trim();
          const nextUrl = String(refreshedOutput.url || "").trim();
          if (!nextUrl || nextUrl === previousUrl) {
            throw error;
          }

          outputToDownload = refreshedOutput;
          options.status(
            options.outputs.length > 1
              ? `Retrying download (${imageOrdinal}/${options.outputs.length})...`
              : "Retrying download..."
          );
        }
      }
      if (!download) {
        throw new Error("Image download failed: empty result.");
      }

      const ext =
        extensionFromContentType(download.contentType) ||
        extensionFromMimeType(outputToDownload.mime_type) ||
        extensionFromUrl(outputToDownload.url) ||
        "png";

      const indexSuffix = options.outputs.length > 1 ? `-${String(imageOrdinal).padStart(2, "0")}` : "";
      const imagePath = await getAvailableFilePath(
        this.app,
        outputDir,
        `${generatorBaseName}-${stamp.compact}${indexSuffix}`,
        ext
      );
      await this.app.vault.createBinary(imagePath, download.arrayBuffer);
      saved.push({ output: outputToDownload, imagePath });

      if (this.plugin.settings.imageGenerationSaveMetadataSidecar !== false) {
        await this.writeSidecar({
          imagePath,
          stampIso: stamp.iso,
          promptFilePath: options.promptFile.path,
          promptText: options.promptText,
          modelId: options.modelId,
          job: options.job,
          output: outputToDownload,
          inputImagePaths: options.inputImagePaths,
        });
      }
    }

    return saved;
  }

  private async refreshOutputUrlFromGenerationJob(options: {
    client: CanvasFlowImageGenerationClient;
    generationJobId: string;
    pollUrl?: string;
    originalOutput: SystemSculptImageGenerationOutput;
    outputOrdinal: number;
    status: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<SystemSculptImageGenerationOutput | null> {
    const jobId = String(options.generationJobId || "").trim();
    if (!jobId) return null;

    const refreshed = await options.client.waitForGenerationJob(jobId, {
      pollUrl: options.pollUrl,
      pollIntervalMs: 600,
      maxPollIntervalMs: 1200,
      maxWaitMs: 20_000,
      initialPollDelayMs: 0,
      signal: options.signal,
      onUpdate: (job) => {
        const normalized = String(job.job?.status || "").trim().toLowerCase();
        if (normalized === "queued" || normalized === "processing") {
          options.status("Waiting for refreshed output URL...");
        }
      },
    });

    const outputs = refreshed.outputs.filter((item) => isHttpUrl(String(item.url || "")));
    if (!outputs.length) {
      return null;
    }

    const targetIndex = Number(options.originalOutput.index);
    if (Number.isFinite(targetIndex)) {
      const byIndex = outputs.find((item) => item.index === targetIndex);
      if (byIndex) return byIndex;
    }

    const fallback = outputs[options.outputOrdinal - 1];
    return fallback || outputs[0] || null;
  }

  private async attachGeneratedOutputsToCanvas(options: {
    canvasFile: TFile;
    canvasDoc: CanvasDocument;
    promptNode: CanvasNode;
    promptNodeId: string;
    savedOutputs: CanvasFlowSavedOutput[];
    aspectRatio?: string;
    status: RunStatusUpdater;
  }): Promise<void> {
    options.status("Updating canvas...");
    const slots = this.computeOutputSlots({
      promptNode: options.promptNode,
      imageCount: options.savedOutputs.length,
      aspectRatio: options.aspectRatio,
    });
    let updatedDoc = options.canvasDoc;

    for (const [idx, saved] of options.savedOutputs.entries()) {
      const slot = slots[idx] || slots[slots.length - 1];
      if (!slot) continue;
      const added = addFileNode(updatedDoc, {
        filePath: saved.imagePath,
        x: slot.x,
        y: slot.y,
        width: slot.width,
        height: slot.height,
      });
      updatedDoc = added.doc;
      updatedDoc = addEdge(updatedDoc, { fromNode: options.promptNodeId, toNode: added.nodeId }).doc;
    }

    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));
  }

  private async writeSidecar(options: {
    imagePath: string;
    stampIso: string;
    promptFilePath: string;
    promptText: string;
    modelId: string;
    job: SystemSculptGenerationJobResponse;
    output: SystemSculptImageGenerationOutput;
    inputImagePaths: string[];
  }): Promise<void> {
    try {
      const sidecarPath = normalizePath(`${options.imagePath}.systemsculpt.json`);
      const curated = getCuratedImageGenerationModel(options.modelId, this.getCachedImageGenerationModels());
      const payload = {
        kind: "canvasflow_generation",
        created_at: options.stampIso,
        prompt_file: options.promptFilePath,
        prompt: options.promptText,
        provider: "openrouter",
        model: {
          id: options.modelId,
          label: curated?.label ?? null,
          provider: curated?.provider ?? null,
        },
        job: {
          id: options.job.job.id,
          status: options.job.job.status,
          error_code: options.job.job.error_code ?? null,
          error_message: options.job.job.error_message ?? null,
          attempt_count: options.job.job.attempt_count ?? null,
          completed_at: options.job.job.completed_at ?? null,
        },
        output: {
          index: options.output.index,
          url: options.output.url,
          mime_type: options.output.mime_type,
          size_bytes: options.output.size_bytes,
          width: options.output.width,
          height: options.output.height,
        },
        usage: options.job.usage ?? null,
        input_images: options.inputImagePaths,
        input_images_count: options.inputImagePaths.length,
      };

      const json = JSON.stringify(payload, null, 2);
      const existing = this.app.vault.getAbstractFileByPath(sidecarPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, json);
        return;
      }
      await this.app.vault.create(sidecarPath, json);
    } catch {
      // Sidecars are best-effort.
    }
  }
}
