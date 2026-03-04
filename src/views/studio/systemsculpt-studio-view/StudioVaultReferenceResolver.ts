import { normalizePath, type TAbstractFile } from "obsidian";
import { isAbsoluteFilesystemPath } from "../../../utils/vaultPathUtils";

export type ResolveVaultItemFromReferenceOptions = {
  reference: string;
  getAbstractFileByPath: (path: string) => TAbstractFile | null;
  resolveVaultPathFromAbsoluteFilePath: (absolutePath: string) => string | null;
};

export function parseObsidianOpenFilePath(reference: string): string | null {
  const raw = String(reference || "").trim();
  if (!raw.startsWith("obsidian://open")) {
    return null;
  }
  try {
    const url = new URL(raw);
    const filePath = url.searchParams.get("file");
    if (!filePath) {
      return null;
    }
    const decoded = decodeURIComponent(filePath).trim();
    return decoded ? normalizePath(decoded) : null;
  } catch {
    return null;
  }
}

export function stripEnclosingReferenceWrappers(reference: string): string {
  let next = String(reference || "").trim();
  while (next.startsWith("<") && next.endsWith(">") && next.length > 1) {
    next = next.slice(1, -1).trim();
  }
  if (
    (next.startsWith("\"") && next.endsWith("\"") && next.length > 1) ||
    (next.startsWith("'") && next.endsWith("'") && next.length > 1) ||
    (next.startsWith("`") && next.endsWith("`") && next.length > 1)
  ) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

export function normalizeObsidianLinkTarget(reference: string): string {
  let next = stripEnclosingReferenceWrappers(reference);
  if (!next) {
    return "";
  }
  if (next.startsWith("!")) {
    next = next.slice(1).trim();
  }
  const aliasIndex = next.indexOf("|");
  if (aliasIndex >= 0) {
    next = next.slice(0, aliasIndex).trim();
  }
  const headingIndex = next.indexOf("#");
  if (headingIndex >= 0) {
    next = next.slice(0, headingIndex).trim();
  }
  const blockIndex = next.indexOf("^");
  if (blockIndex >= 0) {
    next = next.slice(0, blockIndex).trim();
  }
  return next.trim();
}

export function parseObsidianWikiLinkTarget(reference: string): string | null {
  const raw = stripEnclosingReferenceWrappers(reference);
  const match = raw.match(/^!?\[\[([\s\S]+?)\]\]$/);
  if (!match) {
    return null;
  }
  const target = normalizeObsidianLinkTarget(match[1]);
  return target || null;
}

export function parseMarkdownLinkTarget(reference: string): string | null {
  const raw = stripEnclosingReferenceWrappers(reference);
  const match = raw.match(/^!?\[[^\]]*]\((.+)\)$/);
  if (!match) {
    return null;
  }
  let target = String(match[1] || "").trim();
  if (!target) {
    return null;
  }
  if (target.startsWith("<") && target.endsWith(">") && target.length > 1) {
    target = target.slice(1, -1).trim();
  } else {
    const firstToken = target.split(/\s+/)[0];
    target = firstToken || target;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep original text when URL decoding fails.
  }
  const normalized = normalizeObsidianLinkTarget(target);
  return normalized || null;
}

export function resolveVaultPathFromFileUri(options: {
  reference: string;
  resolveVaultPathFromAbsoluteFilePath: (absolutePath: string) => string | null;
}): string | null {
  const { reference, resolveVaultPathFromAbsoluteFilePath } = options;
  const raw = stripEnclosingReferenceWrappers(reference);
  if (!raw.toLowerCase().startsWith("file://")) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:") {
      return null;
    }
    let absolutePath = decodeURIComponent(url.pathname || "").trim();
    if (/^\/[a-zA-Z]:\//.test(absolutePath)) {
      absolutePath = absolutePath.slice(1);
    }
    return resolveVaultPathFromAbsoluteFilePath(absolutePath);
  } catch {
    return null;
  }
}

export function resolveVaultItemFromReference(
  options: ResolveVaultItemFromReferenceOptions
): TAbstractFile | null {
  const {
    reference,
    getAbstractFileByPath,
    resolveVaultPathFromAbsoluteFilePath,
  } = options;

  const raw = stripEnclosingReferenceWrappers(reference);
  if (!raw) {
    return null;
  }

  const candidatePaths = new Set<string>();
  const pushCandidate = (value: string | null | undefined): void => {
    const next = String(value || "").trim();
    if (!next) {
      return;
    }
    candidatePaths.add(next);
  };

  pushCandidate(parseObsidianOpenFilePath(raw));
  pushCandidate(parseObsidianWikiLinkTarget(raw));
  pushCandidate(parseMarkdownLinkTarget(raw));
  pushCandidate(
    resolveVaultPathFromFileUri({
      reference: raw,
      resolveVaultPathFromAbsoluteFilePath,
    })
  );
  if (isAbsoluteFilesystemPath(raw)) {
    pushCandidate(resolveVaultPathFromAbsoluteFilePath(raw));
  }
  pushCandidate(normalizeObsidianLinkTarget(raw));
  pushCandidate(raw);

  for (const candidate of candidatePaths) {
    const normalizedCandidate = normalizePath(candidate.replace(/\\/g, "/"));
    if (!normalizedCandidate) {
      continue;
    }
    const direct = getAbstractFileByPath(normalizedCandidate);
    if (direct) {
      return direct;
    }
    if (!normalizedCandidate.includes(".")) {
      const markdownFallback = getAbstractFileByPath(`${normalizedCandidate}.md`);
      if (markdownFallback) {
        return markdownFallback;
      }
    }
  }

  return null;
}

export function collectInlinePathReferencesFromText(raw: string, push: (value: string) => void): void {
  const text = String(raw || "");
  if (!text.trim()) {
    return;
  }

  for (const match of text.matchAll(/obsidian:\/\/open[^\s)]+/gi)) {
    push(match[0]);
  }
  for (const match of text.matchAll(/file:\/\/[^\s)]+/gi)) {
    push(match[0]);
  }
  for (const match of text.matchAll(/!?\[\[([\s\S]+?)\]\]/g)) {
    push(match[0]);
    push(match[1]);
  }
  for (const match of text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    push(match[0]);
    push(match[1]);
  }
}

export function parsePathReferencesFromText(raw: string): string[] {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return [];
  }

  const references = new Set<string>();
  const push = (value: string): void => {
    const next = String(value || "").trim();
    if (!next) {
      return;
    }
    references.add(next);
  };

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.path === "string") {
        push(record.path);
      }
      if (typeof record.file === "string") {
        push(record.file);
      }
      if (Array.isArray(record.results)) {
        for (const result of record.results) {
          if (result && typeof result === "object" && typeof (result as Record<string, unknown>).path === "string") {
            push((result as Record<string, unknown>).path as string);
          }
        }
      }
    } else if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === "string") {
          push(value);
        }
      }
    }
  } catch {
    // Continue with line parsing.
  }

  collectInlinePathReferencesFromText(normalized, push);
  for (const line of normalized.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    push(trimmedLine);
    push(trimmedLine.replace(/^[-*]\s+/, ""));
  }

  return Array.from(references);
}
