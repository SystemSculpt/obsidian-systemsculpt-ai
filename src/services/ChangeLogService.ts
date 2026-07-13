import { GITHUB_API } from "../constants/externalServices";
import type SystemSculptPlugin from "../main";

export interface ChangeLogEntry {
  version: string;
  date: string;
  notes: string;
  url: string;
}

const GITHUB_OWNER = "SystemSculpt";
const GITHUB_REPO = "obsidian-systemsculpt-ai";

export const BUNDLED_CHANGELOG_ENTRIES: readonly ChangeLogEntry[] = Object.freeze([
  Object.freeze({
    version: "6.0.0",
    date: "Jul 2026",
    notes: [
      "Chat, transcription, embeddings, and Studio now share one fast, reliable SystemSculpt service.",
      "Chat is rebuilt as a native agent workspace with live tool progress, inline approvals, artifacts, retries, and queued follow-ups.",
      "Setup is simpler, with no model or endpoint configuration required.",
      "SystemSculpt 6 is desktop-only. Existing chats remain available; older unsupported chats open read-only.",
    ].join("\n\n"),
    url: GITHUB_API.RELEASE_URL(GITHUB_OWNER, GITHUB_REPO),
  }),
  Object.freeze({
    version: "5.11.0",
    date: "Jul 2026",
    notes: [
      "Studio text nodes now use Obsidian's Markdown editor with stable focus, save, and history behavior.",
      "Chat Resend is restored on desktop, with filesystem access kept behind the desktop-only boundary.",
      "No manual upgrade action is required.",
    ].join("\n\n"),
    url: GITHUB_API.RELEASE_URL(GITHUB_OWNER, GITHUB_REPO),
  }),
]);

function bundledEntries(): ChangeLogEntry[] {
  return BUNDLED_CHANGELOG_ENTRIES.map((entry) => ({ ...entry }));
}

export class ChangeLogService {
  static getReleasesPageUrl(): string {
    return GITHUB_API.RELEASE_URL(GITHUB_OWNER, GITHUB_REPO);
  }

  static async getReleases(
    _plugin?: Pick<SystemSculptPlugin, "storage">,
    _options: { forceRefresh?: boolean; allowStale?: boolean } = {},
  ): Promise<ChangeLogEntry[]> {
    return bundledEntries();
  }

  static findIndexByVersion(entries: ChangeLogEntry[], version: string | undefined): number {
    if (!version) return 0;
    const candidates = [version, version.startsWith("v") ? version.substring(1) : `v${version}`];
    const index = entries.findIndex((entry) => candidates.includes(entry.version));
    return index >= 0 ? index : 0;
  }
}

export { GITHUB_OWNER, GITHUB_REPO };
