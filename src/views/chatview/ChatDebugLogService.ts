import type SystemSculptPlugin from "../../main";
import type { ChatView } from "./ChatView";

type LogWriteResult = {
  path?: string;
  bytes: number;
  errors: string[];
};

const LOG_RETENTION_MAX_FILES = 40;
const LOG_RETENTION_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const LOG_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LOG_SUBDIR = "chat-debug";

export class ChatDebugLogService {
  private readonly plugin: SystemSculptPlugin;
  private readonly chatView: ChatView;

  private lastRetentionCheck = 0;

  constructor(plugin: SystemSculptPlugin, chatView: ChatView) {
    this.plugin = plugin;
    this.chatView = chatView;
  }

  public async writeUiLog(content: string): Promise<LogWriteResult> {
    const errors: string[] = [];
    const storage = this.plugin.storage;
    if (!storage) {
      return { bytes: content.length, errors: ["Storage manager unavailable"] };
    }

    try {
      await storage.initialize();
      await this.ensureLogDirectory();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { bytes: content.length, errors };
    }

    const fileName = `${this.getFileBaseName()}-ui.json`;
    const result = await storage.writeFile("diagnostics", `${LOG_SUBDIR}/${fileName}`, content);
    if (!result.success) {
      errors.push(result.error || "Failed to write UI log");
    }

    await this.maybePruneLogs();
    return { path: result.path, bytes: content.length, errors };
  }

  public buildLogPathsDetailed(): {
    ui: { relative: string; absolute: string | null };
  } {
    const base = this.getFileBaseName();
    const ui = this.plugin.storage
      ? this.plugin.storage.getPath("diagnostics", LOG_SUBDIR, `${base}-ui.json`)
      : `.systemsculpt/diagnostics/${LOG_SUBDIR}/${base}-ui.json`;
    return {
      ui: {
        relative: ui,
        absolute: this.resolveAbsolutePath(ui),
      },
    };
  }

  public resolveAbsolutePath(relativePath: string): string | null {
    try {
      const adapter: any = this.plugin.app.vault.adapter as any;
      const basePath = typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : null;
      if (!basePath || typeof basePath !== "string") {
        return null;
      }
      const trimmedBase = basePath.replace(/[\\\/]+$/, "");
      const trimmedRel = relativePath.replace(/^[\\\/]+/, "");
      return `${trimmedBase}/${trimmedRel}`;
    } catch {
      return null;
    }
  }

  private async ensureLogDirectory(): Promise<void> {
    const storage = this.plugin.storage;
    if (!storage) return;
    const dirPath = storage.getPath("diagnostics", LOG_SUBDIR);
    await storage.ensureDirectory(dirPath, true);
  }

  private getFileBaseName(): string {
    const rawChatId = this.chatView.chatId || "unsaved-chat";
    const sanitized = rawChatId
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "-")
      .slice(0, 120);
    return `chat-${sanitized}`;
  }

  private async maybePruneLogs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRetentionCheck < 30 * 1000) {
      return;
    }
    this.lastRetentionCheck = now;

    const storage = this.plugin.storage;
    if (!storage) return;

    const folder = storage.getPath("diagnostics", LOG_SUBDIR);
    const adapter = this.plugin.app.vault.adapter;

    try {
      const listing = await adapter.list(folder);
      const files = listing.files.filter((path) => !path.endsWith("/.folder"));
      if (files.length === 0) return;

      const stats = await Promise.all(
        files.map(async (path) => {
          const stat = await adapter.stat(path);
          return { path, stat };
        })
      );

      const entries = stats
        .filter((entry) => entry.stat && typeof entry.stat.mtime === "number")
        .map((entry) => ({
          path: entry.path,
          size: entry.stat?.size ?? 0,
          mtime: entry.stat?.mtime ?? 0,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      const maxAge = now - LOG_RETENTION_MAX_AGE_MS;

      for (const entry of [...entries].reverse()) {
        if (entry.mtime && entry.mtime < maxAge) {
          await adapter.remove(entry.path);
          totalBytes -= entry.size;
        }
      }

      let remaining = entries
        .filter((entry) => entry.mtime >= maxAge)
        .sort((a, b) => b.mtime - a.mtime);

      while (remaining.length > LOG_RETENTION_MAX_FILES || totalBytes > LOG_RETENTION_MAX_BYTES) {
        const oldest = remaining.pop();
        if (!oldest) break;
        await adapter.remove(oldest.path);
        totalBytes -= oldest.size;
      }
    } catch {
      // Ignore retention failures; logging should be best-effort
    }
  }
}
