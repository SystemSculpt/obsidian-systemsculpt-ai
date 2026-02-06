import { App, Notice, TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
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
import { ReplicateImageService, type ReplicatePrediction } from "./ReplicateImageService";
import { sanitizeChatTitle } from "../../utils/titleUtils";

type RunStatusUpdater = (status: string) => void;

function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function findFirstUrl(output: unknown): string | null {
  if (typeof output === "string") {
    return isHttpUrl(output) ? output.trim() : null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === "object") {
    for (const value of Object.values(output as Record<string, unknown>)) {
      const found = findFirstUrl(value);
      if (found) return found;
    }
    return null;
  }
  return null;
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

function extensionFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname || "";
    const last = path.split("/").pop() || "";
    const ext = last.includes(".") ? last.split(".").pop() || "" : "";
    const clean = ext.toLowerCase();
    if (clean === "png" || clean === "jpg" || clean === "jpeg" || clean === "webp" || clean === "gif") return clean === "jpeg" ? "jpg" : clean;
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

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (!normalized) return;
  const exists = await app.vault.adapter.exists(normalized);
  if (exists) return;

  // Obsidian's createFolder doesn't always create intermediate segments; do it ourselves.
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
  // Desktop-only feature; Buffer should be available in Obsidian Desktop.
  const buf = Buffer.from(new Uint8Array(arrayBuffer));
  return buf.toString("base64");
}

export class CanvasFlowRunner {
  private readonly resolvedVersionCache = new Map<string, string>(); // modelSlug -> latestVersionId

  constructor(private readonly app: App, private readonly plugin: SystemSculptPlugin) {}

  async runPromptNode(options: {
    canvasFile: TFile;
    promptNodeId: string;
    status?: RunStatusUpdater;
    signal?: AbortSignal;
  }): Promise<void> {
    const setStatus = options.status || (() => {});

    const apiKey = String(this.plugin.settings.replicateApiKey || "").trim();
    if (!apiKey) {
      throw new Error("Replicate API key is not configured. Set it in Settings -> Image Generation.");
    }

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
          ? "This node's file is not a CanvasFlow prompt note. Add ss_flow_kind: prompt in frontmatter."
          : `Prompt note invalid: ${promptParsed.reason}`
      );
    }

    const promptText = String(promptParsed.body || "").trim();
    if (!promptText) {
      throw new Error("Prompt is empty.");
    }

    const modelSlug =
      String(promptParsed.config.replicateModelSlug || "").trim() ||
      String(this.plugin.settings.replicateDefaultModelSlug || "").trim();
    if (!modelSlug) {
      throw new Error("No Replicate model set. Choose a default model in Settings -> Image Generation, or set ss_replicate_model in the prompt note.");
    }

    const replicate = new ReplicateImageService(apiKey);

    const versionId = await this.resolveVersionId({
      replicate,
      modelSlug,
      promptOverrideVersion: promptParsed.config.replicateVersionId,
    });

    const input: Record<string, unknown> = { ...(promptParsed.config.replicateInput || {}) };
    input[promptParsed.config.replicatePromptKey] = promptText;

    const incomingImage = findIncomingImageFileForNode(doc, options.promptNodeId);
    if (incomingImage) {
      const imgAbs = this.app.vault.getAbstractFileByPath(incomingImage.imagePath);
      if (imgAbs instanceof TFile) {
        setStatus("Reading input image...");
        const imgBytes = await this.app.vault.readBinary(imgAbs);
        const ext = String(imgAbs.extension || "").toLowerCase();
        const mime = mimeFromExtension(ext);
        const b64 = base64FromArrayBuffer(imgBytes);
        const dataUrl = `data:${mime};base64,${b64}`;
        input[promptParsed.config.replicateImageKey] = dataUrl;
      } else {
        setStatus("Input image missing; running prompt without image.");
      }
    }

    setStatus("Creating Replicate prediction...");
    const prediction = await replicate.createPrediction({ version: versionId, input });
    const predictionId = String(prediction?.id || "").trim();
    if (!predictionId) {
      throw new Error("Replicate did not return a prediction id.");
    }

    setStatus("Waiting for Replicate...");
    const finalPrediction = await replicate.waitForPrediction(predictionId, {
      pollIntervalMs: this.plugin.settings.replicatePollIntervalMs ?? 1000,
      signal: options.signal,
      onUpdate: (p) => {
        if (p.status === "processing" || p.status === "starting") {
          setStatus(`Replicate: ${p.status}...`);
        }
      },
    });

    const outputUrl = findFirstUrl(finalPrediction.output);
    if (!outputUrl) {
      throw new Error("Replicate prediction completed, but no output URL was found.");
    }

    setStatus("Downloading generated image...");
    const download = await replicate.downloadOutput(outputUrl);
    const ext =
      extensionFromContentType(download.contentType) ||
      extensionFromUrl(outputUrl) ||
      "png";

    const outputDir = String(this.plugin.settings.replicateOutputDir || "").trim() || "SystemSculpt/Attachments/Generations";
    await ensureFolder(this.app, outputDir);

    const stamp = nowStamp();
    const baseName = sanitizeChatTitle(promptAbstract.basename || "generation");
    const imagePath = await getAvailableFilePath(this.app, outputDir, `${baseName}-${stamp.compact}`, ext);

    await this.app.vault.createBinary(imagePath, download.arrayBuffer);

    if (this.plugin.settings.replicateSaveMetadataSidecar !== false) {
      await this.writeSidecar({
        imagePath,
        stampIso: stamp.iso,
        promptFilePath: promptAbstract.path,
        promptText,
        modelSlug,
        versionId,
        prediction: finalPrediction,
        outputUrl,
        inputImagePath: incomingImage?.imagePath || null,
      });
    }

    setStatus("Updating canvas...");
    const placed = computeNextNodePosition(promptNode, { defaultWidth: 320, defaultHeight: 320 });
    let updatedDoc = doc;
    const added = addFileNode(updatedDoc, {
      filePath: imagePath,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    });
    updatedDoc = added.doc;
    updatedDoc = addEdge(updatedDoc, { fromNode: options.promptNodeId, toNode: added.nodeId }).doc;

    await this.app.vault.modify(options.canvasFile, serializeCanvasDocument(updatedDoc));

    setStatus("Done.");
    new Notice(`CanvasFlow: generated ${imagePath}`);
  }

  private async resolveVersionId(options: {
    replicate: ReplicateImageService;
    modelSlug: string;
    promptOverrideVersion: string | null;
  }): Promise<string> {
    const override = String(options.promptOverrideVersion || "").trim();
    if (override) return override;

    const settingsSlug = String(this.plugin.settings.replicateDefaultModelSlug || "").trim();
    const settingsVersion = String(this.plugin.settings.replicateResolvedVersion || "").trim();
    if (settingsVersion && settingsSlug && settingsSlug === options.modelSlug) {
      return settingsVersion;
    }

    const cached = this.resolvedVersionCache.get(options.modelSlug);
    if (cached) {
      return cached;
    }

    const details = await options.replicate.resolveLatestVersion(options.modelSlug);
    this.resolvedVersionCache.set(details.slug, details.latestVersionId);
    return details.latestVersionId;
  }

  private async writeSidecar(options: {
    imagePath: string;
    stampIso: string;
    promptFilePath: string;
    promptText: string;
    modelSlug: string;
    versionId: string;
    prediction: ReplicatePrediction;
    outputUrl: string;
    inputImagePath: string | null;
  }): Promise<void> {
    try {
      const sidecarPath = normalizePath(`${options.imagePath}.systemsculpt.json`);
      const payload = {
        kind: "canvasflow_generation",
        created_at: options.stampIso,
        prompt_file: options.promptFilePath,
        prompt: options.promptText,
        replicate: {
          model: options.modelSlug,
          version: options.versionId,
          prediction_id: options.prediction?.id,
          output_url: options.outputUrl,
          status: options.prediction?.status,
          error: options.prediction?.error ?? null,
        },
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
