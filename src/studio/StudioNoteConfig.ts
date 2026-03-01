import type { StudioJsonValue } from "./types";
import { isRecord } from "./utils";

export type StudioNoteConfigItem = {
  path: string;
  enabled: boolean;
};

export function normalizeStudioNotePath(path: string): string {
  return String(path || "").replace(/\\/g, "/").trim();
}

export function deriveStudioNoteTitleFromPath(vaultPath: string): string {
  const normalized = normalizeStudioNotePath(vaultPath);
  if (!normalized) {
    return "";
  }
  const fileName = normalized.split("/").pop() || normalized;
  if (fileName.toLowerCase().endsWith(".md") && fileName.length > 3) {
    return fileName.slice(0, -3);
  }
  return fileName;
}

function parseStudioNoteItem(raw: StudioJsonValue): StudioNoteConfigItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const entry = raw as Record<string, StudioJsonValue>;
  return {
    path: normalizeStudioNotePath(typeof entry.path === "string" ? entry.path : ""),
    enabled: entry.enabled !== false,
  };
}

export function parseStudioNoteItems(raw: StudioJsonValue | undefined): StudioNoteConfigItem[] {
  if (!isRecord(raw)) {
    return [];
  }
  const notes = raw as Record<string, StudioJsonValue>;
  if (!Array.isArray(notes.items)) {
    return [];
  }
  const items: StudioNoteConfigItem[] = [];
  for (const entry of notes.items) {
    const parsed = parseStudioNoteItem(entry as StudioJsonValue);
    if (!parsed) {
      continue;
    }
    items.push(parsed);
  }
  return items;
}

export function serializeStudioNoteItems(items: StudioNoteConfigItem[]): StudioJsonValue {
  return {
    items: items.map((item) => ({
      path: normalizeStudioNotePath(item.path),
      enabled: item.enabled !== false,
    })),
  } as unknown as StudioJsonValue;
}

export function readStudioNoteItemsFromConfig(
  config: Record<string, StudioJsonValue>
): StudioNoteConfigItem[] {
  return parseStudioNoteItems(config.notes);
}

export function readEnabledStudioNoteItems(
  config: Record<string, StudioJsonValue>
): StudioNoteConfigItem[] {
  return readStudioNoteItemsFromConfig(config).filter(
    (item) => item.enabled && item.path.length > 0
  );
}

export function readLegacyStudioNotePath(
  config: Record<string, StudioJsonValue>
): string {
  return normalizeStudioNotePath(typeof config.vaultPath === "string" ? config.vaultPath : "");
}

export function readPrimaryStudioNotePath(
  config: Record<string, StudioJsonValue>
): string {
  const items = readStudioNoteItemsFromConfig(config);
  const enabledPath = items.find((entry) => entry.enabled && entry.path.length > 0)?.path;
  if (enabledPath) {
    return enabledPath;
  }
  return items.find((entry) => entry.path.length > 0)?.path || readLegacyStudioNotePath(config);
}

export function readAllStudioNotePaths(
  config: Record<string, StudioJsonValue>
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of readStudioNoteItemsFromConfig(config)) {
    if (!item.path) {
      continue;
    }
    if (seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    paths.push(item.path);
  }
  const legacyPath = readLegacyStudioNotePath(config);
  if (legacyPath && !seen.has(legacyPath)) {
    paths.push(legacyPath);
  }
  return paths;
}

export function ensureStudioNoteConfigItems(
  config: Record<string, StudioJsonValue>
): { nextConfig: Record<string, StudioJsonValue>; changed: boolean } {
  const items = readStudioNoteItemsFromConfig(config);
  const legacyPath = readLegacyStudioNotePath(config);
  const normalizedItems = items.map((item) => ({
    path: normalizeStudioNotePath(item.path),
    enabled: item.enabled !== false,
  }));
  const hasLegacyFallback = normalizedItems.length === 0 && legacyPath.length > 0;
  const nextItems = hasLegacyFallback
    ? [{ path: legacyPath, enabled: true }]
    : normalizedItems;
  const nextConfig: Record<string, StudioJsonValue> = {
    ...config,
    notes: serializeStudioNoteItems(nextItems),
  };
  delete nextConfig.vaultPath;
  delete nextConfig.value;

  const changed =
    JSON.stringify(config.notes) !== JSON.stringify(nextConfig.notes) ||
    Object.prototype.hasOwnProperty.call(config, "vaultPath") ||
    Object.prototype.hasOwnProperty.call(config, "value");
  return { nextConfig, changed };
}
