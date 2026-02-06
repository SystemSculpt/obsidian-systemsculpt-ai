import { App, Notice, Platform, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { addFileNode, computeNewNodePositionNearRightEdge, parseCanvasDocument, serializeCanvasDocument } from "./CanvasFlowGraph";
import { sanitizeChatTitle } from "../../utils/titleUtils";

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
  const safeBase = sanitizeChatTitle(baseName).trim() || "CanvasFlow Prompt";
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

export async function createCanvasFlowPromptNodeInActiveCanvas(app: App, plugin: SystemSculptPlugin): Promise<void> {
  if (!Platform.isDesktopApp) {
    new Notice("CanvasFlow is desktop-only.");
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

  const modelSlug = String(plugin.settings.replicateDefaultModelSlug || "").trim();
  const modelLine = modelSlug ? `ss_replicate_model: ${modelSlug}\n` : "";

  const template = [
    "---",
    "ss_flow_kind: prompt",
    "ss_flow_backend: replicate",
    modelLine.trimEnd(),
    "ss_replicate_input: {}",
    "---",
    "",
    "Describe your prompt here.",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const notePath = await getAvailableNotePath(app, promptsDir, `CanvasFlow Prompt ${nowStamp()}`);
  const promptFile = await app.vault.create(notePath, template.endsWith("\n") ? template : `${template}\n`);

  const pos = computeNewNodePositionNearRightEdge(doc);
  const added = addFileNode(doc, { filePath: promptFile.path, x: pos.x, y: pos.y, width: 420, height: 260 });
  const updatedDoc = added.doc;
  await app.vault.modify(canvasFile, serializeCanvasDocument(updatedDoc));

  new Notice("CanvasFlow prompt node created.");
}

