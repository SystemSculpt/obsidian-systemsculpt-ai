import { sha256HexFromArrayBuffer } from "./hash";
import { deriveStudioNodeCachePath } from "./paths";
import { StudioProjectStore } from "./StudioProjectStore";
import type { StudioJsonValue, StudioNodeCacheEntry, StudioNodeCacheSnapshotV1, StudioNodeInputMap, StudioNodeInstance } from "./types";
import { isRecord, nowIso } from "./utils";

const NODE_CACHE_SCHEMA = "studio.node-cache.v1" as const;
const NODE_FINGERPRINT_SALT_BY_KIND: Record<string, string> = { "studio.text_generation": "prompt-bundle-v4", "studio.image_generation": "image-prompt-v3" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeNodeConfigForFingerprint(node: StudioNodeInstance): StudioNodeInstance["config"] {
  if (!isRecord(node.config)) return node.config;
  const config = { ...(node.config as Record<string, StudioJsonValue>) }; const kind = String(node.kind || "").trim();
  if (kind === "studio.text_generation") { if (config.lockOutput !== true) { delete config.value; delete config.lockOutput; } delete config.textDisplayMode; }
  if (kind === "studio.transcription") { delete config.value; delete config.textDisplayMode; }
  if (kind === "studio.media_ingest" && isRecord(config.captionBoard)) { const board = { ...(config.captionBoard as Record<string, StudioJsonValue>) }; delete board.lastRenderedAsset; delete board.updatedAt; delete board.sourceAssetPath; config.captionBoard = board; }
  return config;
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(String(value));
}
function createEmptySnapshot(projectId: string): StudioNodeCacheSnapshotV1 { return { schema: NODE_CACHE_SCHEMA, projectId, updatedAt: nowIso(), entries: {} }; }
function normalizeEntry(raw: unknown): StudioNodeCacheEntry | null {
  if (!isRecord(raw)) return null;
  const required = ["nodeId", "nodeKind", "nodeVersion", "inputFingerprint", "updatedAt", "runId"] as const;
  if (required.some((key) => typeof raw[key] !== "string" || !(raw[key] as string))) return null;
  return { nodeId: raw.nodeId as string, nodeKind: raw.nodeKind as string, nodeVersion: raw.nodeVersion as string, inputFingerprint: raw.inputFingerprint as string, outputs: isRecord(raw.outputs) ? raw.outputs as Record<string, StudioJsonValue> : {}, artifacts: Array.isArray(raw.artifacts) ? raw.artifacts as StudioNodeCacheEntry["artifacts"] : undefined, updatedAt: raw.updatedAt as string, runId: raw.runId as string };
}

export async function buildNodeInputFingerprint(node: StudioNodeInstance, inputs: StudioNodeInputMap): Promise<string> {
  const bytes = encoder.encode(stableStringify({ salt: NODE_FINGERPRINT_SALT_BY_KIND[node.kind] || "", kind: node.kind, version: node.version, config: normalizeNodeConfigForFingerprint(node), inputs }));
  return sha256HexFromArrayBuffer(bytes.buffer);
}

export class StudioNodeResultCacheStore {
  constructor(private readonly projectStore: StudioProjectStore) {}
  async load(projectPath: string, projectId: string): Promise<StudioNodeCacheSnapshotV1> {
    const bytes = await this.projectStore.readSupportFile(projectPath, deriveStudioNodeCachePath(projectPath));
    if (!bytes) return createEmptySnapshot(projectId);
    try {
      const parsed = JSON.parse(decoder.decode(bytes)); if (!isRecord(parsed) || parsed.schema !== NODE_CACHE_SCHEMA || parsed.projectId !== projectId) return createEmptySnapshot(projectId);
      const entries: StudioNodeCacheSnapshotV1["entries"] = {};
      for (const [nodeId, raw] of Object.entries(isRecord(parsed.entries) ? parsed.entries : {})) { const entry = normalizeEntry(raw); if (entry) entries[nodeId] = entry; }
      return { schema: NODE_CACHE_SCHEMA, projectId, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(), entries };
    } catch { return createEmptySnapshot(projectId); }
  }
  async save(projectPath: string, snapshot: StudioNodeCacheSnapshotV1): Promise<void> {
    const normalized: StudioNodeCacheSnapshotV1 = { schema: NODE_CACHE_SCHEMA, projectId: String(snapshot.projectId || ""), updatedAt: nowIso(), entries: snapshot.entries || {} };
    await this.projectStore.replaceCache(projectPath, normalized.projectId, encoder.encode(`${JSON.stringify(normalized, null, 2)}\n`));
  }
}
