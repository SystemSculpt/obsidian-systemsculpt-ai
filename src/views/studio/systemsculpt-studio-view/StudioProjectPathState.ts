import { normalizePath } from "obsidian";

export function isStudioProjectPath(path: string): boolean {
  return String(path || "").trim().toLowerCase().endsWith(".systemsculpt");
}

export function resolveProjectPathAfterFolderRename(options: {
  currentProjectPath: string;
  previousFolderPath: string;
  nextFolderPath: string;
}): string | null {
  const currentPath = normalizePath(String(options.currentProjectPath || "").trim());
  const previousFolderPath = normalizePath(String(options.previousFolderPath || "").trim());
  const nextFolderPath = normalizePath(String(options.nextFolderPath || "").trim());
  if (!currentPath || !previousFolderPath || !nextFolderPath || previousFolderPath === nextFolderPath) {
    return null;
  }
  if (!currentPath.startsWith(`${previousFolderPath}/`)) {
    return null;
  }
  const suffix = currentPath.slice(previousFolderPath.length + 1);
  if (!suffix) {
    return null;
  }
  return normalizePath(`${nextFolderPath}/${suffix}`);
}

export function remapPathScopedRecord<T>(
  record: Record<string, T>,
  previousPath: string,
  nextPath: string
): Record<string, T> {
  const previous = normalizePath(String(previousPath || "").trim());
  const next = normalizePath(String(nextPath || "").trim());
  if (!previous || !next || previous === next) {
    return record;
  }
  if (!Object.prototype.hasOwnProperty.call(record, previous)) {
    return record;
  }
  const value = record[previous];
  const nextRecord = { ...record };
  delete nextRecord[previous];
  nextRecord[next] = value;
  return nextRecord;
}
