import { App, Notice, TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { API_BASE_URL } from "../../constants/api";
import { resolveSystemSculptApiBaseUrl } from "../../utils/urlHelpers";
import {
  addEdge,
  addFileNode,
  computeNextNodePosition,
  findIncomingImageFileForNode,
  indexCanvas,
  isCanvasFileNode,
  parseCanvasDocument,
  serializeCanvasDocument,
} from "./CanvasFlowGraph";
import { parseCanvasFlowPromptNote } from "./PromptNote";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  getCuratedImageGenerationModel,
} from "./ImageGenerationModelCatalog";
import {
  SystemSculptImageGenerationService,
  type SystemSculptGenerationJobResponse,
  type SystemSculptImageGenerationOutput,
} from "./SystemSculptImageGenerationService";
import { sanitizeChatTitle } from "../../utils/titleUtils";

type RunStatusUpdater = (status: string) => void;

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

function nowStamp(): { iso: string; compact: string } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const compact = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { iso: d.toISOString(), compact };
}

function formatImageModelDisplayName(modelId: string): string {
  const id = String(modelId || "").trim();
  const entry = getCuratedImageGenerationModel(id);
  return entry?.label || id || "OpenRouter";
}

function formatImageModelFileBase(modelId: string): string {
  const id = String(modelId || "").trim();
  const entry = getCuratedImageGenerationModel(id);
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
  const safeBase = sanitizeChatTitle(baseName).trim() || "generation";
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

export class CanvasFlowRunner {
  constructor(private readonly app: App, private readonly plugin: SystemSculptPlugin) {}

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

    const canvasRaw = await this.app.vault.read(options.canvasFile);
    const doc = parseCanvasDocument(canvasRaw);
    if (!doc) {
      throw new Error("Failed to parse .canvas JSON.");
    }

    const { nodesById } = indexCanvas(doc);
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
      throw new Error("No image model set. Choose a default model in Settings -> Image Generation, or set ss_image_model in the prompt note.");
    }

    const modelDisplayName = formatImageModelDisplayName(modelId);
    const imageCount = Math.max(1, Math.min(4, Math.floor(promptParsed.config.imageCount || 1)));
    const aspectRatio = String(promptParsed.config.aspectRatio || "").trim() || undefined;
    const seed = promptParsed.config.seed;

    const service = new SystemSculptImageGenerationService({
      baseUrl,
      licenseKey,
    });

    const inputImages: Array<{ type: "data_url"; data_url: string }> = [];
    const incomingImage = findIncomingImageFileForNode(doc, options.promptNodeId);
    if (incomingImage) {
      const imageAbs = this.app.vault.getAbstractFileByPath(incomingImage.imagePath);
      if (imageAbs instanceof TFile) {
        setStatus("Reading input image...");
        const imgBytes = await this.app.vault.readBinary(imageAbs);
        const ext = String(imageAbs.extension || "").toLowerCase();
        const mime = mimeFromExtension(ext);
        const b64 = base64FromArrayBuffer(imgBytes);
        inputImages.push({
          type: "data_url",
          data_url: `data:${mime};base64,${b64}`,
        });
      } else {
        setStatus("Input image missing; running prompt without image.");
      }
    }

    setStatus("Submitting generation job...");
    const job = await service.createGenerationJob({
      model: modelId,
      prompt: promptText,
      input_images: inputImages,
      options: {
        count: imageCount,
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(seed !== null && Number.isFinite(seed) ? { seed } : {}),
      },
    });

    const jobId = String(job.job?.id || "").trim();
    if (!jobId) {
      throw new Error("Image generation API did not return a job id.");
    }

    setStatus("Waiting for image generation...");
    const finalJob = await service.waitForGenerationJob(jobId, {
      pollIntervalMs: this.plugin.settings.imageGenerationPollIntervalMs ?? 1000,
      signal: options.signal,
      onUpdate: (status) => {
        const s = String(status.job?.status || "").trim();
        if (s === "queued" || s === "processing") {
          setStatus(imageCount > 1 ? `Generation (${s})...` : `Generation: ${s}...`);
        }
      },
    });

    const outputs = finalJob.outputs.filter((output) => isHttpUrl(String(output.url || "")));
    if (outputs.length === 0) {
      throw new Error("Image generation completed, but no output URLs were returned.");
    }

    const outputDir = String(this.plugin.settings.imageGenerationOutputDir || "").trim() || "SystemSculpt/Attachments/Generations";
    await ensureFolder(this.app, outputDir);

    const stamp = nowStamp();
    const generatorBaseName = formatImageModelFileBase(modelId);
    const generatedImagePaths: string[] = [];

    for (const [idx, output] of outputs.entries()) {
      if (options.signal?.aborted) {
        throw new Error("Aborted");
      }

      const imageOrdinal = idx + 1;
      setStatus(outputs.length > 1 ? `Downloading generated image (${imageOrdinal}/${outputs.length})...` : "Downloading generated image...");
      const download = await service.downloadImage(output.url);
      const ext = extensionFromContentType(download.contentType) || extensionFromMimeType(output.mime_type) || extensionFromUrl(output.url) || "png";

      const indexSuffix = outputs.length > 1 ? `-${String(imageOrdinal).padStart(2, "0")}` : "";
      const imagePath = await getAvailableFilePath(this.app, outputDir, `${generatorBaseName}-${stamp.compact}${indexSuffix}`, ext);
      await this.app.vault.createBinary(imagePath, download.arrayBuffer);
      generatedImagePaths.push(imagePath);

      if (this.plugin.settings.imageGenerationSaveMetadataSidecar !== false) {
        await this.writeSidecar({
          imagePath,
          stampIso: stamp.iso,
          promptFilePath: promptAbstract.path,
          promptText,
          modelId,
          job: finalJob,
          output,
          inputImagePath: incomingImage?.imagePath || null,
        });
      }
    }

    setStatus("Updating canvas...");
    const placed = computeNextNodePosition(promptNode, { dx: 80, defaultWidth: 320, defaultHeight: 320 });
    let updatedDoc = doc;
    const gapX = 80;
    for (const [idx, imagePath] of generatedImagePaths.entries()) {
      const x = placed.x + idx * (placed.width + gapX);
      const y = placed.y;
      const added = addFileNode(updatedDoc, {
        filePath: imagePath,
        x,
        y,
        width: placed.width,
        height: placed.height,
      });
      updatedDoc = added.doc;
      updatedDoc = addEdge(updatedDoc, { fromNode: options.promptNodeId, toNode: added.nodeId }).doc;
    }

    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));

    setStatus("Done.");
    if (generatedImagePaths.length === 1) {
      new Notice(`SystemSculpt: generated ${generatedImagePaths[0]} (${modelDisplayName})`);
    } else {
      new Notice(`SystemSculpt: generated ${generatedImagePaths.length} images (${modelDisplayName})`);
    }
  }

  private async writeSidecar(options: {
    imagePath: string;
    stampIso: string;
    promptFilePath: string;
    promptText: string;
    modelId: string;
    job: SystemSculptGenerationJobResponse;
    output: SystemSculptImageGenerationOutput;
    inputImagePath: string | null;
  }): Promise<void> {
    try {
      const sidecarPath = normalizePath(`${options.imagePath}.systemsculpt.json`);
      const curated = getCuratedImageGenerationModel(options.modelId);
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
        input_image: options.inputImagePath,
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
