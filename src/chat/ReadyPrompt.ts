import type { App, TFile } from "obsidian";

/**
 * The one prompt a new account can run right after sign-in (T-5302): a
 * summary of the person's open or most recently edited note, on the free
 * credits. Only 6 of 408 starter accounts ever got a hosted reply, so the
 * sign-in result offers this as a single tap instead of an empty chat.
 */
export const READY_PROMPT_LABEL = "Summarize my latest note";

/** Too small holds only a template; too large spends a large share of the free credits. */
const MIN_NOTE_BYTES = 200;
const MAX_NOTE_BYTES = 100_000;

export type ReadyPromptSources = Readonly<{
  /** Search exclusions plus SystemSculpt's own and template folders. */
  isExcluded: (path: string) => boolean;
  /** The note open in the editor, preferred when it qualifies. */
  openNote?: TFile | null;
}>;

function qualifies(file: TFile, isExcluded: (path: string) => boolean): boolean {
  return file.extension === "md"
    && !file.path.toLowerCase().endsWith(".excalidraw.md")
    && file.stat.size >= MIN_NOTE_BYTES
    && file.stat.size <= MAX_NOTE_BYTES
    && !isExcluded(file.path);
}

/** The open note when it qualifies, else the most recently edited qualifying note. */
export function latestNote(app: App, sources: ReadyPromptSources): TFile | null {
  if (sources.openNote && qualifies(sources.openNote, sources.isExcluded)) return sources.openNote;
  let latest: TFile | null = null;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!qualifies(file, sources.isExcluded)) continue;
    if (!latest || file.stat.mtime > latest.stat.mtime) latest = file;
  }
  return latest;
}

/** "Summarize [[Note]]" for that note, or null when the vault has none that qualifies. */
export function readyPrompt(app: App, sources: ReadyPromptSources): string | null {
  const file = latestNote(app, sources);
  if (!file) return null;
  return `Summarize [[${app.metadataCache.fileToLinktext(file, "", true)}]]`;
}

/** True when `path` is `folder` or inside it (vault-relative, case-insensitive). */
export function insideFolder(path: string, folder: string): boolean {
  const prefix = folder.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  const lower = path.toLowerCase();
  return prefix.length > 0 && (lower === prefix || lower.startsWith(`${prefix}/`));
}
