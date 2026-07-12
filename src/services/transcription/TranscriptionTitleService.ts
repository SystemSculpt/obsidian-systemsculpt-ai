import { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { sanitizeChatTitle } from "../../utils/titleUtils";

const TRANSCRIPT_LABEL = "transcript";
const MAX_TITLE_CONTEXT_CHARS = 2_800;
const MAX_TITLE_CHARS = 120;
const MAX_COLLISION_ATTEMPTS = 50;

export class TranscriptionTitleService {
  private static instance: TranscriptionTitleService | null = null;

  private constructor(_plugin: SystemSculptPlugin) {}

  public static getInstance(plugin: SystemSculptPlugin): TranscriptionTitleService {
    if (!TranscriptionTitleService.instance) {
      TranscriptionTitleService.instance = new TranscriptionTitleService(plugin);
    }
    return TranscriptionTitleService.instance;
  }

  public buildFallbackBasename(prefix: string): string {
    const cleanPrefix = prefix.trim();
    if (!cleanPrefix) {
      return TRANSCRIPT_LABEL;
    }
    return `${cleanPrefix} - ${TRANSCRIPT_LABEL}`;
  }

  public sanitizeGeneratedTitle(title: string): string {
    const normalized = String(title || "")
      .replace(/\r?\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim()
      .replace(/\.md$/i, "")
      .trim();

    const sanitized = sanitizeChatTitle(normalized).replace(/\s+/g, " ").trim();
    return sanitized.replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
  }

  public isUsableTitle(title: string): boolean {
    const clean = title.trim();
    if (!clean) return false;
    if (clean.length > MAX_TITLE_CHARS) return false;
    return true;
  }

  public buildTitledBasename(prefix: string, title: string): string {
    const safeTitle = this.sanitizeGeneratedTitle(title);
    return `${this.buildFallbackBasename(prefix)} - ${safeTitle}`;
  }

  public buildTitleContext(text: string): string {
    return buildPercentileExcerpt(text, MAX_TITLE_CONTEXT_CHARS);
  }

  public async tryGenerateTitle(transcriptText: string): Promise<string | null> {
    const excerpt = this.buildTitleContext(transcriptText).trim();
    if (!excerpt) return null;
    const candidate = excerpt
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*(?:\[[^\]]+\]|\d{1,2}:\d{2}(?::\d{2})?|[-*#]+)\s*/u, "").trim())
      .find((line) => line.length > 0) ?? "";
    const words = candidate.replace(/\s+/gu, " ").split(" ").filter(Boolean).slice(0, 8);
    const safeTitle = this.sanitizeGeneratedTitle(words.join(" "));
    return this.isUsableTitle(safeTitle) ? safeTitle : null;
  }

  public async tryRenameTranscriptionFile(
    app: App,
    transcriptionFile: TFile,
    options: {
      prefix: string;
      transcriptText: string;
      extension?: string;
    }
  ): Promise<string> {
    const extension = (options.extension || transcriptionFile.extension || "md").replace(/^\./, "") || "md";
    const title = await this.tryGenerateTitle(options.transcriptText);
    if (!title) {
      return transcriptionFile.path;
    }

    const folderPath = transcriptionFile.path.split("/").slice(0, -1).join("/");
    const desiredBase = this.buildTitledBasename(options.prefix, title);
    const destinationPath = this.findAvailablePath(app, folderPath, desiredBase, extension, transcriptionFile.path);
    if (destinationPath === transcriptionFile.path) {
      return transcriptionFile.path;
    }

    try {
      await app.fileManager.renameFile(transcriptionFile, destinationPath);
      return destinationPath;
    } catch (_) {
      return transcriptionFile.path;
    }
  }

  private findAvailablePath(
    app: App,
    folderPath: string,
    baseName: string,
    extension: string,
    currentPath?: string
  ): string {
    const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

    const desired = join(folderPath, `${baseName}.${extension}`);
    if (desired === currentPath) {
      return desired;
    }

    const exists = (path: string) => !!app.vault.getAbstractFileByPath(path);
    if (!exists(desired)) {
      return desired;
    }

    for (let i = 2; i <= MAX_COLLISION_ATTEMPTS; i += 1) {
      const candidate = join(folderPath, `${baseName} (${i}).${extension}`);
      if (candidate === currentPath) {
        return candidate;
      }
      if (!exists(candidate)) {
        return candidate;
      }
    }

    return desired;
  }
}

export function buildPercentileExcerpt(text: string, maxChars: number): string {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;

  const offsets = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;
  const separator = "\n\n...\n\n";

  const budget = Math.max(0, maxChars - separator.length * (offsets.length - 1));
  const sliceLen = Math.max(0, Math.floor(budget / offsets.length));
  if (sliceLen <= 0) return normalized.slice(0, maxChars);

  const sourceLen = normalized.length;
  const maxStart = Math.max(0, sourceLen - sliceLen);

  const slices = offsets
    .map((fraction) => {
      const start = fraction === 1 ? maxStart : Math.floor(maxStart * fraction);
      return normalized.slice(start, start + sliceLen).trim();
    })
    .filter((slice) => slice.length > 0);

  return slices.join(separator).slice(0, maxChars);
}
