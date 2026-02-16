import { App, Notice, Platform, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { addFileNode, computeNewNodePositionNearRightEdge, parseCanvasDocument, serializeCanvasDocument } from "./CanvasFlowGraph";
import { sanitizeChatTitle } from "../../utils/titleUtils";
import { CANVASFLOW_PROMPT_NODE_HEIGHT_PX, CANVASFLOW_PROMPT_NODE_WIDTH_PX } from "./CanvasFlowUiConstants";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  getDefaultImageAspectRatio,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";

function isCanvasLeaf(leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf {
  if (!leaf) return false;
  const vt = (leaf.view as any)?.getViewType?.();
  return vt === "canvas";
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
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

async function getAvailableNotePath(app: App, folderPath: string, baseName: string): Promise<string> {
  const safeBase = sanitizeChatTitle(baseName).trim() || "SystemSculpt Prompt";
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const candidate = normalizePath(`${folderPath}/${safeBase}${suffix}.md`);
    if (!app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
  return normalizePath(`${folderPath}/${safeBase}-${Date.now().toString(16)}.md`);
}

function getCachedImageGenerationModels(plugin: SystemSculptPlugin): ImageGenerationServerCatalogModel[] {
  const raw = plugin.settings.imageGenerationModelCatalogCache?.models;
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

export async function createCanvasFlowPromptNodeInActiveCanvas(app: App, plugin: SystemSculptPlugin): Promise<void> {
  if (!Platform.isDesktopApp) {
    new Notice("SystemSculpt canvas tools are desktop-only.");
    return;
  }

  const leaf = app.workspace.activeLeaf;
  if (!isCanvasLeaf(leaf)) {
    new Notice("Open a Canvas file first.");
    return;
  }

  const canvasFile = ((leaf.view as any)?.file as TFile | undefined) || null;
  if (!canvasFile) {
    new Notice("Active Canvas has no backing file.");
    return;
  }

  const raw = await app.vault.read(canvasFile);
  const doc = parseCanvasDocument(raw);
  if (!doc) {
    new Notice("Failed to parse .canvas file.");
    return;
  }

  const promptsDir = "SystemSculpt/CanvasFlow/Prompts";
  await ensureFolder(app, promptsDir);

  const modelId = String(plugin.settings.imageGenerationDefaultModelId || "").trim() || DEFAULT_IMAGE_GENERATION_MODEL_ID;
  const modelLine = modelId ? `ss_image_model: ${modelId}\n` : "";
  const aspectRatio = getDefaultImageAspectRatio(modelId, getCachedImageGenerationModels(plugin));
  const aspectRatioLine = aspectRatio ? `ss_image_aspect_ratio: ${aspectRatio}\n` : "";

  const template = [
    "---",
    "ss_flow_kind: prompt",
    "ss_flow_backend: openrouter",
    modelLine.trimEnd(),
    aspectRatioLine.trimEnd(),
    "ss_image_count: 1",
    "---",
    "",
    "Describe your prompt here.",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const notePath = await getAvailableNotePath(app, promptsDir, `SystemSculpt Prompt ${nowStamp()}`);
  const promptFile = await app.vault.create(notePath, template.endsWith("\n") ? template : `${template}\n`);

  const pos = computeNewNodePositionNearRightEdge(doc);
  const added = addFileNode(doc, {
    filePath: promptFile.path,
    x: pos.x,
    y: pos.y,
    width: CANVASFLOW_PROMPT_NODE_WIDTH_PX,
    height: CANVASFLOW_PROMPT_NODE_HEIGHT_PX,
  });
  const updatedDoc = added.doc;
  await app.vault.modify(canvasFile, serializeCanvasDocument(updatedDoc));

  new Notice("SystemSculpt prompt node created.");
}
