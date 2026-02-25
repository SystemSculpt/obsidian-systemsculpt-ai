import { App, normalizePath } from "obsidian";
import { sha256HexFromArrayBuffer } from "./hash";
import { deriveStudioNodeCachePath } from "./paths";
import type {
  StudioJsonValue,
  StudioNodeCacheEntry,
  StudioNodeCacheSnapshotV1,
  StudioNodeInputMap,
  StudioNodeInstance,
} from "./types";
import { isRecord, nowIso } from "./utils";

type JsonAdapter = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
};

const NODE_CACHE_SCHEMA = "studio.node-cache.v1" as const;
const NODE_FINGERPRINT_SALT_BY_KIND: Record<string, string> = {
  // Text generation fingerprinting ignores unlocked output snapshots stored in node config.
  "studio.text_generation": "prompt-bundle-v4",
  // Image generation uses prompt input plus count/aspect controls; model selection is server-managed.
  "studio.image_generation": "image-prompt-v3",
};

function normalizeNodeConfigForFingerprint(node: StudioNodeInstance): StudioNodeInstance["config"] {
  if (!isRecord(node.config)) {
    return node.config;
  }
  const config = {
    ...(node.config as Record<string, StudioJsonValue>),
  };
  const kind = String(node.kind || "").trim();

  if (kind === "studio.text_generation") {
    const lockOutput = config.lockOutput === true;
    // `value` and `textDisplayMode` are UI/runtime snapshot fields; they should not invalidate cache
    // unless lockOutput is intentionally enabled.
    if (!lockOutput) {
      delete config.value;
      delete config.lockOutput;
    }
    delete config.textDisplayMode;
    return config;
  }

  if (kind === "studio.transcription") {
    // Transcription node stores rendered output in config for inline display; ignore in cache keys.
    delete config.value;
    delete config.textDisplayMode;
    return config;
  }

  return config;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function normalizeNodeOutputs(raw: unknown): Record<string, StudioJsonValue> {
  if (!isRecord(raw)) {
    return {};
  }
  return raw as Record<string, StudioJsonValue>;
}

function normalizeNodeCacheEntry(raw: unknown): StudioNodeCacheEntry | null {
  if (!isRecord(raw)) {
    return null;
  }

  const nodeId = typeof raw.nodeId === "string" ? raw.nodeId : "";
  const nodeKind = typeof raw.nodeKind === "string" ? raw.nodeKind : "";
  const nodeVersion = typeof raw.nodeVersion === "string" ? raw.nodeVersion : "";
  const inputFingerprint = typeof raw.inputFingerprint === "string" ? raw.inputFingerprint : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  const runId = typeof raw.runId === "string" ? raw.runId : "";
  if (!nodeId || !nodeKind || !nodeVersion || !inputFingerprint || !updatedAt || !runId) {
    return null;
  }

  return {
    nodeId,
    nodeKind,
    nodeVersion,
    inputFingerprint,
    outputs: normalizeNodeOutputs(raw.outputs),
    artifacts: Array.isArray(raw.artifacts) ? (raw.artifacts as StudioNodeCacheEntry["artifacts"]) : undefined,
    updatedAt,
    runId,
  };
}

function createEmptySnapshot(projectId: string): StudioNodeCacheSnapshotV1 {
  return {
    schema: NODE_CACHE_SCHEMA,
    projectId,
    updatedAt: nowIso(),
    entries: {},
  };
}

export async function buildNodeInputFingerprint(
  node: StudioNodeInstance,
  inputs: StudioNodeInputMap
): Promise<string> {
  const serialized = stableStringify({
    salt: NODE_FINGERPRINT_SALT_BY_KIND[node.kind] || "",
    kind: node.kind,
    version: node.version,
    config: normalizeNodeConfigForFingerprint(node),
    inputs,
  });
  const bytes = new TextEncoder().encode(serialized);
  return sha256HexFromArrayBuffer(bytes.buffer);
}

export class StudioNodeResultCacheStore {
  private readonly adapter: JsonAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter as unknown as JsonAdapter;
  }

  private async ensureDir(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        const exists = await this.adapter.exists(current);
        if (!exists) {
          await this.adapter.mkdir(current);
        }
      } catch {
        // Best effort: another worker may have created this path.
      }
    }
  }

  private dirname(path: string): string {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index > 0 ? normalized.slice(0, index) : "";
  }

  async load(projectPath: string, projectId: string): Promise<StudioNodeCacheSnapshotV1> {
    const cachePath = deriveStudioNodeCachePath(projectPath);
    const exists = await this.adapter.exists(cachePath);
    if (!exists) {
      return createEmptySnapshot(projectId);
    }

    try {
      const raw = await this.adapter.read(cachePath);
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return createEmptySnapshot(projectId);
      }
      if (parsed.schema !== NODE_CACHE_SCHEMA) {
        return createEmptySnapshot(projectId);
      }

      const snapshotProjectId = typeof parsed.projectId === "string" ? parsed.projectId : "";
      if (!snapshotProjectId || snapshotProjectId !== projectId) {
        return createEmptySnapshot(projectId);
      }

      const entriesRaw = isRecord(parsed.entries) ? parsed.entries : {};
      const entries: StudioNodeCacheSnapshotV1["entries"] = {};
      for (const [nodeId, rawEntry] of Object.entries(entriesRaw)) {
        const normalized = normalizeNodeCacheEntry(rawEntry);
        if (!normalized) {
          continue;
        }
        entries[nodeId] = normalized;
      }

      return {
        schema: NODE_CACHE_SCHEMA,
        projectId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        entries,
      };
    } catch {
      return createEmptySnapshot(projectId);
    }
  }

  async save(projectPath: string, snapshot: StudioNodeCacheSnapshotV1): Promise<void> {
    const cachePath = deriveStudioNodeCachePath(projectPath);
    await this.ensureDir(this.dirname(cachePath));
    const normalized: StudioNodeCacheSnapshotV1 = {
      schema: NODE_CACHE_SCHEMA,
      projectId: String(snapshot.projectId || ""),
      updatedAt: nowIso(),
      entries: snapshot.entries || {},
    };
    await this.adapter.write(cachePath, `${JSON.stringify(normalized, null, 2)}\n`);
  }
}
