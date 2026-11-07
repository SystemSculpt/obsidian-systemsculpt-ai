import { TFile, normalizePath, type App } from "obsidian";
import type { ManagedImageGenerationAdapter } from "../../services/images/ManagedImageGenerationAdapter";
import type { ManagedVideoGenerationAdapter } from "../../services/videos/ManagedVideoGenerationAdapter";
import { snapManagedVideoRequestToModel, type ManagedVideoModel } from "../../services/videos/ManagedVideoModelCatalog";
import type { StudioService } from "../../studio/StudioService";
import type { StudioDocumentEdit } from "../../studio/document/StudioProjectDocument";
import { STUDIO_AGENT_DOCS_PATH } from "../../studio/types";
import { ensureVaultFolder } from "../../utils/vaultFolders";
import { toSafeVaultFileName } from "../../utils/vaultFileName";
import { sha256HexFromArrayBuffer } from "../../utils/sha256";
import {
  SYSTEMSCULPT_TOOLS,
  systemSculptToolName,
  type SystemSculptMedia,
  type SystemSculptToolResult,
  type SystemSculptToolset,
} from "./SystemSculptTools";

/** The chat shows generated files under the reply; an embed in the reply would show them twice. */
/** The chat shows the link as its own line; the reply repeating it would say it twice. */
const LINK_SHOWN = "The chat already shows the person this line and its link under your reply. Don't restate it, explain it or mention subscribing or credits; at most say in a few words that nothing was made.";
const SHOWN_IN_CHAT = "The chat already shows generated files right after your reply, so don't embed them or say where they appear.";

const GENERATED_IMAGES_FOLDER = "SystemSculpt/Images";
const GENERATED_VIDEOS_FOLDER = "SystemSculpt/Videos";

type StudioTarget = Pick<StudioService,
  | "listProjects" | "createProjectFile" | "readAgentDocument" | "editAgentDocument"
  | "runProject" | "runProjectFromNode" | "getProjectNodeCache" | "getRecentRuns" | "ensureAgentReference">;

/** The narrow plugin surface the tools need; tests supply fakes. */
export type SystemSculptToolHost = Readonly<{
  app: App;
  hasLicenseKey: () => boolean;
  checkLicense: (signal: AbortSignal) => Promise<{ outcome: string }>;
  images: Pick<ManagedImageGenerationAdapter, "generate" | "beginLocalCommit" | "completeLocalCommit">;
  videos: Pick<ManagedVideoGenerationAdapter, "generate" | "beginLocalCommit" | "markDisplayed" | "markVaultWriteCompleted" | "completeLocalCommit">;
  videoModels: (signal: AbortSignal) => Promise<readonly ManagedVideoModel[]>;
  studio: () => StudioTarget;
  /** Opens a vault file in a new tab; inactive keeps the chat in front. */
  openFile: (path: string, active: boolean) => Promise<void>;
  links: Readonly<{ subscribe: string; credits: string }>;
  now?: () => Date;
  randomId?: () => string;
}>;

const IMAGE_TYPES: Readonly<Record<string, "image/png" | "image/jpeg" | "image/webp">> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

class ToolInputError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function optionalString(args: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new ToolInputError(`${key} must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}
function requiredString(args: Record<string, unknown>, key: string, max: number): string {
  const value = optionalString(args, key, max);
  if (!value) throw new ToolInputError(`${key} is required.`);
  return value;
}
function optionalInteger(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new ToolInputError(`${key} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The action could not be completed.";
}
function errorCode(error: unknown): string {
  const value = record(error).code;
  return typeof value === "string" ? value : "";
}

/** Executes SystemSculpt tools for every chat backend. Never throws: failures return a readable result. */
export class SystemSculptToolService {
  constructor(private readonly host: SystemSculptToolHost) {}

  toolset(): SystemSculptToolset {
    return { definitions: SYSTEMSCULPT_TOOLS, call: (name, args, signal, callId) => this.call(name, args, signal, callId) };
  }

  /**
   * callId: the agent's stable ID for this tool call. Generation keys its job
   * on it, so a call replayed after a reload attaches to the same job instead
   * of buying a second one.
   */
  async call(nativeName: string, rawArgs: unknown, signal: AbortSignal, callId?: string): Promise<SystemSculptToolResult> {
    const name = systemSculptToolName(nativeName);
    if (!name) return { ok: false, message: `Unknown SystemSculpt tool: ${String(nativeName).slice(0, 80)}.` };
    const args = record(rawArgs);
    try {
      // Every tool is a subscriber feature; Studio's share one line.
      if (name.startsWith("studio_")) {
        const denied = await this.admit("SystemSculpt Studio", signal);
        if (denied) return denied;
      }
      switch (name) {
        case "generate_image": return await this.generateImage(args, signal, callId);
        case "generate_video": return await this.generateVideo(args, signal, callId);
        case "studio_list_workflows": return await this.listWorkflows();
        case "studio_create_workflow": return await this.createWorkflow(args);
        case "studio_open_workflow": return await this.openWorkflow(args);
        case "studio_edit_workflow": return await this.editWorkflow(args);
        case "studio_run_workflow": return await this.runWorkflow(args, signal);
        case "studio_list_outputs": return await this.listOutputs(args);
      }
    } catch (error) {
      if (signal.aborted) return { ok: false, message: "Stopped." };
      return this.failure(error);
    }
  }

  private subscribe(feature: string): SystemSculptToolResult {
    return {
      ok: false,
      message: `${feature} comes with a SystemSculpt subscription. Subscribe: ${this.host.links.subscribe} ${LINK_SHOWN}`,
      link: { label: "Subscribe", url: this.host.links.subscribe },
    };
  }

  private failure(error: unknown): SystemSculptToolResult {
    const code = errorCode(error), message = errorText(error);
    if (code === "payment_required" || /insufficient_credits|not enough credits/i.test(message)) {
      return { ok: false, message: `Not enough SystemSculpt credits for this. Buy credits: ${this.host.links.credits} ${LINK_SHOWN}`, link: { label: "Buy credits", url: this.host.links.credits } };
    }
    if (/Operation already exists/.test(message)) {
      return { ok: false, message: "This request already generated, or is generating, its result; it is not run twice. Look in SystemSculpt/Images or SystemSculpt/Videos." };
    }
    if (code === "license_required" || code === "license_rejected" || /license_required|license_rejected/.test(message)) {
      return this.subscribe("This");
    }
    return { ok: false, message: message.slice(0, 2000) };
  }

  /** Null when the account may use hosted media; otherwise the one-line Subscribe result. */
  private async admit(feature: string, signal: AbortSignal): Promise<SystemSculptToolResult | null> {
    if (!this.host.hasLicenseKey()) return this.subscribe(feature);
    const admission = await this.host.checkLicense(signal);
    if (admission.outcome === "allowed") return null;
    if (admission.outcome === "license_required" || admission.outcome === "license_rejected") return this.subscribe(feature);
    return { ok: false, message: `${feature} is temporarily unavailable (${admission.outcome}). Try again shortly.` };
  }

  private async readImage(path: string): Promise<{ mimeType: "image/png" | "image/jpeg" | "image/webp"; sizeBytes: number; sha256: string; load: () => Promise<ArrayBuffer> }> {
    const file = this.host.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new ToolInputError(`No image at ${path}.`);
    const mimeType = IMAGE_TYPES[file.extension.toLowerCase()];
    if (!mimeType) throw new ToolInputError(`${path} is not a PNG, JPEG or WebP image.`);
    const bytes = await this.host.app.vault.readBinary(file);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_REFERENCE_BYTES) throw new ToolInputError(`${path} must be under 20 MB.`);
    return { mimeType, sizeBytes: bytes.byteLength, sha256: await sha256HexFromArrayBuffer(bytes), load: async () => bytes };
  }

  /** Saves generated bytes as an ordinary vault file and returns its path. */
  private async save(folder: string, prompt: string, bytes: ArrayBuffer, mimeType: string, index: number, count: number): Promise<string> {
    const extension = EXTENSIONS[mimeType] ?? (mimeType.startsWith("video/") ? "mp4" : "png");
    const now = (this.host.now ?? (() => new Date()))();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
    const stem = toSafeVaultFileName(`${stamp} ${words}${count > 1 ? ` ${index + 1}` : ""}`, { fallback: stamp, maxBytes: 120 });
    await ensureVaultFolder(this.host.app, folder);
    let path = normalizePath(`${folder}/${stem}.${extension}`);
    for (let suffix = 2; await this.host.app.vault.adapter.exists(path); suffix += 1) {
      path = normalizePath(`${folder}/${stem} ${suffix}.${extension}`);
    }
    await this.host.app.vault.createBinary(path, bytes);
    return path;
  }

  private operationId(kind: "image" | "video", callId?: string): string {
    const stable = callId?.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);
    const id = stable || (this.host.randomId ?? (() => window.crypto.randomUUID()))().replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
    return `chat-${kind}-${id}`;
  }

  private async generateImage(args: Record<string, unknown>, signal: AbortSignal, callId?: string): Promise<SystemSculptToolResult> {
    const prompt = requiredString(args, "prompt", 8_000);
    const count = optionalInteger(args, "count", 1, 4);
    const referencePaths = Array.isArray(args.reference_images) ? args.reference_images : args.reference_images === undefined ? [] : null;
    if (!referencePaths || referencePaths.length > 4 || referencePaths.some(path => typeof path !== "string")) {
      throw new ToolInputError("reference_images must be at most 4 vault paths.");
    }
    const denied = await this.admit("Image generation", signal);
    if (denied) return denied;
    const references = await Promise.all((referencePaths as string[]).map(path => this.readImage(path)));
    const operationId = this.operationId("image", callId);
    const model = optionalString(args, "model", 160), aspectRatio = optionalString(args, "aspect_ratio", 32);
    const quality = optionalString(args, "quality", 32), background = optionalString(args, "background", 32);
    const result = await this.host.images.generate({
      operationId,
      sourceIdentity: `chat:${operationId}`,
      signal,
      buildPayload: () => ({
        ...(model ? { model } : {}),
        prompt,
        ...(count === undefined ? {} : { count }),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
        inputImages: references,
      }),
    });
    const media: SystemSculptMedia[] = [];
    for (const [index, output] of result.outputs.entries()) {
      const path = await this.save(GENERATED_IMAGES_FOLDER, prompt, output.bytes, output.metadata.mime_type, index, result.outputs.length);
      media.push({ kind: "image", path, mimeType: output.metadata.mime_type });
    }
    // The files are already in the vault; a late delivery receipt must not fail the call.
    try {
      await this.host.images.beginLocalCommit(operationId);
      await this.host.images.completeLocalCommit(operationId);
    } catch { /* Recovery retries the receipt. */ }
    return {
      ok: true,
      message: `Saved ${media.length === 1 ? "1 image" : `${media.length} images`} to the vault: ${media.map(item => item.path).join(", ")}. ${SHOWN_IN_CHAT}`,
      media,
      data: { model: result.model },
    };
  }

  private async generateVideo(args: Record<string, unknown>, signal: AbortSignal, callId?: string): Promise<SystemSculptToolResult> {
    const prompt = requiredString(args, "prompt", 8_000);
    const durationSeconds = optionalInteger(args, "duration_seconds", 1, 60);
    const generateAudio = typeof args.generate_audio === "boolean" ? args.generate_audio : undefined;
    const denied = await this.admit("Video generation", signal);
    if (denied) return denied;
    const models = await this.host.videoModels(signal);
    const requested = optionalString(args, "model", 160);
    const model = requested ? models.find(entry => entry.id === requested) ?? null : models[0] ?? null;
    if (!model && !requested) return { ok: false, message: "No SystemSculpt video model is available right now." };
    const frames: Array<{ role: "first_frame" | "last_frame" } & Awaited<ReturnType<SystemSculptToolService["readImage"]>>> = [];
    for (const [key, role] of [["first_frame", "first_frame"], ["last_frame", "last_frame"]] as const) {
      const path = optionalString(args, key, 1_000);
      if (!path) continue;
      if (model && !model.supportedFrameRoles.includes(role)) throw new ToolInputError(`${model.name} does not accept a ${role === "first_frame" ? "first" : "last"} frame.`);
      frames.push({ role, ...(await this.readImage(path)) });
    }
    const options = { durationSeconds, resolution: optionalString(args, "resolution", 16), aspectRatio: optionalString(args, "aspect_ratio", 32), generateAudio };
    const snapped = model ? snapManagedVideoRequestToModel(model, options) : options;
    const operationId = this.operationId("video", callId);
    const result = await this.host.videos.generate({
      operationId,
      sourceIdentity: `chat:${operationId}`,
      signal,
      buildPayload: () => ({
        model: model?.id ?? requested ?? "",
        prompt,
        durationSeconds: snapped.durationSeconds,
        resolution: snapped.resolution,
        aspectRatio: snapped.aspectRatio,
        generateAudio: snapped.generateAudio,
        frameImages: frames,
      }),
    });
    // The model may snap the request to another length; report the one made.
    const seconds = result.outputs[0]?.metadata.duration_seconds ?? null;
    const media: SystemSculptMedia[] = [];
    for (const [index, output] of result.outputs.entries()) {
      const path = await this.save(GENERATED_VIDEOS_FOLDER, prompt, output.bytes, output.metadata.mime_type, index, result.outputs.length);
      media.push({ kind: "video", path, mimeType: output.metadata.mime_type });
    }
    try {
      await this.host.videos.beginLocalCommit(operationId);
      await this.host.videos.markDisplayed(operationId);
      await this.host.videos.markVaultWriteCompleted(operationId);
      await this.host.videos.completeLocalCommit(operationId);
    } catch { /* Recovery retries the receipt. */ }
    return {
      ok: true,
      message: `Saved the video${seconds ? ` (${seconds} s)` : ""} to the vault: ${media.map(item => item.path).join(", ")}. ${SHOWN_IN_CHAT}`,
      media,
      data: { model: model?.id ?? requested },
    };
  }

  private async listWorkflows(): Promise<SystemSculptToolResult> {
    const paths = await this.host.studio().listProjects();
    const workflows = paths.map(path => ({ path, name: path.split("/").pop()?.replace(/\.systemsculpt$/i, "") ?? path }));
    return {
      ok: true,
      message: workflows.length ? `${workflows.length} Studio ${workflows.length === 1 ? "workflow" : "workflows"}.` : "No Studio workflows yet.",
      data: { workflows, reference: await this.agentReference() },
    };
  }

  private async createWorkflow(args: Record<string, unknown>): Promise<SystemSculptToolResult> {
    const name = requiredString(args, "name", 120);
    const projectPath = optionalString(args, "path", 1_000);
    const studio = this.host.studio();
    const created = await studio.createProjectFile({ name, ...(projectPath ? { projectPath } : {}) });
    const document = record(await studio.readAgentDocument(created.path));
    // A new workflow opens beside the chat; the person keeps the conversation in view.
    if (args.show !== false) await this.host.openFile(created.path, false);
    return {
      ok: true,
      message: `Created ${created.path}.`,
      data: { path: created.path, revision: Array.isArray(document.heads) ? document.heads[0] : undefined, canvas: document.canvas, entities: document.entities, reference: await this.agentReference() },
    };
  }

  private async openWorkflow(args: Record<string, unknown>): Promise<SystemSculptToolResult> {
    const path = requiredString(args, "path", 1_000);
    const document = record(await this.host.studio().readAgentDocument(path));
    if (args.show === true) await this.host.openFile(path, true);
    return {
      ok: true,
      message: `Read ${path}.`,
      data: { path, revision: Array.isArray(document.heads) ? document.heads[0] : undefined, canvas: document.canvas, entities: document.entities, reference: await this.agentReference() },
    };
  }

  private async editWorkflow(args: Record<string, unknown>): Promise<SystemSculptToolResult> {
    const path = requiredString(args, "path", 1_000);
    const revision = requiredString(args, "revision", 128);
    if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 500) throw new ToolInputError("edits must list 1-500 edits.");
    const result = record(await this.host.studio().editAgentDocument(path, [revision], args.edits as StudioDocumentEdit[]));
    return {
      ok: true,
      message: `Applied ${args.edits.length} ${args.edits.length === 1 ? "edit" : "edits"} to ${path}.`,
      data: { path, revision: Array.isArray(result.heads) ? result.heads[0] : undefined, entities: result.entities },
    };
  }

  /** The reference path, written first so an agent told to read it finds it. */
  private async agentReference(): Promise<string> {
    try { await this.host.studio().ensureAgentReference(); } catch { /* Studio still works without it. */ }
    return STUDIO_AGENT_DOCS_PATH;
  }

  private async nodeTitles(path: string): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    try {
      const entities = record(record(await this.host.studio().readAgentDocument(path)).entities);
      for (const [id, value] of Object.entries(entities)) {
        const title = record(value).title;
        if (id.startsWith("node:") && typeof title === "string" && title.trim()) titles.set(id.slice(5), title.trim());
      }
    } catch { /* Titles only improve captions. */ }
    return titles;
  }

  private async nodeOutputs(path: string, onlyNodeIds?: readonly string[]) {
    const cache = await this.host.studio().getProjectNodeCache(path);
    const wanted = onlyNodeIds ? new Set(onlyNodeIds) : null;
    const media: SystemSculptMedia[] = [];
    const titles = await this.nodeTitles(path);
    const nodes = Object.values(cache?.entries ?? {}).filter(entry => !wanted || wanted.has(entry.nodeId)).map(entry => {
      const files = (entry.artifacts ?? []).map(asset => {
        const kind = asset.mimeType.startsWith("image/") ? "image" : asset.mimeType.startsWith("video/") ? "video" : null;
        // Studio names assets by hash; the step's title says what the file is. Same bytes show once.
        if (kind && !media.some(item => item.path === asset.path)) {
          const title = titles.get(entry.nodeId);
          media.push({ kind, path: asset.path, mimeType: asset.mimeType, ...(title ? { label: title } : {}) });
        }
        return { path: asset.path, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
      });
      const outputs = JSON.stringify(entry.outputs ?? {});
      return { nodeId: entry.nodeId, kind: entry.nodeKind, runId: entry.runId, updatedAt: entry.updatedAt, files,
        outputs: outputs.length > 4_000 ? `${outputs.slice(0, 4_000)}…` : entry.outputs };
    });
    return { nodes, media };
  }

  private async runWorkflow(args: Record<string, unknown>, signal: AbortSignal): Promise<SystemSculptToolResult> {
    const path = requiredString(args, "path", 1_000);
    const nodeId = optionalString(args, "node_id", 200);
    const studio = this.host.studio();
    const summary = nodeId ? await studio.runProjectFromNode(path, nodeId, { signal }) : await studio.runProject(path, { signal });
    const executed = summary.executedNodeIds ?? [];
    const ran = [...executed, ...(summary.cachedNodeIds ?? [])];
    const { nodes } = await this.nodeOutputs(path, ran.length ? ran : undefined);
    // Only nodes that ran now show inline; cached outputs are earlier work.
    const { media } = await this.nodeOutputs(path, executed);
    if (summary.error) {
      const failure = this.failure(new Error(summary.error));
      return { ...failure, message: failure.link ? failure.message : `The run ${summary.status}: ${summary.error.slice(0, 1_500)}`, ...(media.length ? { media } : {}), data: { runId: summary.runId, status: summary.status, nodes } };
    }
    return {
      ok: true,
      message: `Run ${summary.status}.${media.length ? ` Generated: ${media.map(item => item.path).join(", ")}. ${SHOWN_IN_CHAT}` : ""}`,
      ...(media.length ? { media } : {}),
      data: { runId: summary.runId, status: summary.status, nodes },
    };
  }

  private async listOutputs(args: Record<string, unknown>): Promise<SystemSculptToolResult> {
    const path = requiredString(args, "path", 1_000);
    const studio = this.host.studio();
    const [{ nodes }, runs] = await Promise.all([this.nodeOutputs(path), studio.getRecentRuns(path)]);
    return {
      ok: true,
      message: `${nodes.length} ${nodes.length === 1 ? "node has" : "nodes have"} saved outputs.`,
      data: { path, nodes, recentRuns: runs.slice(0, 10) },
    };
  }
}
