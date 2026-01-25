import type SystemSculptPlugin from "../../main";
import type { ChatView } from "./ChatView";
import type { StreamEvent, StreamPipelineDiagnostics } from "../../streaming/types";
import type { StreamDebugCallbacks } from "../../services/SystemSculptService";

type StreamLogContext = {
  chatId?: string;
  assistantMessageId?: string;
  modelId?: string;
};

type StreamLogStats = {
  entryCount: number;
  bytes: number;
  maxBytes: number;
  truncated: boolean;
};

type LogWriteResult = {
  path?: string;
  bytes: number;
  errors: string[];
};

const STREAM_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2MB in-memory cap
const LOG_RETENTION_MAX_FILES = 40;
const LOG_RETENTION_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const LOG_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const LOG_SUBDIR = "chat-debug";

export class ChatDebugLogService {
  private readonly plugin: SystemSculptPlugin;
  private readonly chatView: ChatView;

  private streamEntries: string[] = [];
  private streamBytes = 0;
  private streamSequence = 0;
  private streamTruncated = false;
  private lastRetentionCheck = 0;
  private lastStreamDiagnostics: StreamPipelineDiagnostics | null = null;

  constructor(plugin: SystemSculptPlugin, chatView: ChatView) {
    this.plugin = plugin;
    this.chatView = chatView;
  }

  public createStreamLogger(context: StreamLogContext): StreamDebugCallbacks {
    const base = {
      chatId: context.chatId || this.chatView.chatId || undefined,
      assistantMessageId: context.assistantMessageId,
      modelId: context.modelId,
    };

    return {
      onRequest: (data) => {
        this.recordStreamEntry("request", { ...base, ...data });
      },
      onResponse: (data) => {
        this.recordStreamEntry("response", { ...base, ...data });
      },
      onRawEvent: (data) => {
        this.recordStreamEntry("raw", { ...base, ...data });
      },
      onStreamEvent: (data) => {
        this.recordStreamEntry("event", { ...base, ...data });
      },
      onStreamEnd: (data) => {
        if (data.diagnostics) {
          this.lastStreamDiagnostics = data.diagnostics;
        }
        this.recordStreamEntry("stream-end", { ...base, ...data });
      },
      onError: (data) => {
        this.recordStreamEntry("error", { ...base, ...data });
      },
    };
  }

  public recordStreamEvent(event: StreamEvent, context?: StreamLogContext): void {
    this.recordStreamEntry("event", {
      chatId: context?.chatId || this.chatView.chatId || undefined,
      assistantMessageId: context?.assistantMessageId,
      modelId: context?.modelId,
      event,
    });
  }

  public getStreamStats(): StreamLogStats {
    return {
      entryCount: this.streamEntries.length,
      bytes: this.streamBytes,
      maxBytes: STREAM_BUFFER_MAX_BYTES,
      truncated: this.streamTruncated,
    };
  }

  public getLastStreamDiagnostics(): StreamPipelineDiagnostics | null {
    return this.lastStreamDiagnostics;
  }

  public resetStreamBuffer(): void {
    this.streamEntries = [];
    this.streamBytes = 0;
    this.streamSequence = 0;
    this.streamTruncated = false;
    this.lastStreamDiagnostics = null;
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

  public async writeStreamLog(): Promise<LogWriteResult> {
    const errors: string[] = [];
    const storage = this.plugin.storage;
    const content = this.streamEntries.length > 0 ? `${this.streamEntries.join("\n")}\n` : "";
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

    const fileName = `${this.getFileBaseName()}-stream.ndjson`;
    const result = await storage.writeFile("diagnostics", `${LOG_SUBDIR}/${fileName}`, content);
    if (!result.success) {
      errors.push(result.error || "Failed to write stream log");
    }

    await this.maybePruneLogs();
    return { path: result.path, bytes: content.length, errors };
  }

  public buildLogPaths(): { ui: string; stream: string } {
    const base = this.getFileBaseName();
    const ui = this.plugin.storage
      ? this.plugin.storage.getPath("diagnostics", LOG_SUBDIR, `${base}-ui.json`)
      : `.systemsculpt/diagnostics/${LOG_SUBDIR}/${base}-ui.json`;
    const stream = this.plugin.storage
      ? this.plugin.storage.getPath("diagnostics", LOG_SUBDIR, `${base}-stream.ndjson`)
      : `.systemsculpt/diagnostics/${LOG_SUBDIR}/${base}-stream.ndjson`;
    return { ui, stream };
  }

  public buildLogPathsDetailed(): {
    ui: { relative: string; absolute: string | null };
    stream: { relative: string; absolute: string | null };
  } {
    const paths = this.buildLogPaths();
    return {
      ui: {
        relative: paths.ui,
        absolute: this.resolveAbsolutePath(paths.ui),
      },
      stream: {
        relative: paths.stream,
        absolute: this.resolveAbsolutePath(paths.stream),
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

  private recordStreamEntry(kind: string, payload: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      seq: ++this.streamSequence,
      kind,
      ...payload,
    };

    let serialized = "";
    try {
      serialized = JSON.stringify(entry);
    } catch (error) {
      serialized = JSON.stringify({
        timestamp: entry.timestamp,
        seq: entry.seq,
        kind: "serialization-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const bytes = serialized.length + 1;
    if (bytes > STREAM_BUFFER_MAX_BYTES) {
      this.streamEntries = [serialized.slice(0, STREAM_BUFFER_MAX_BYTES - 1)];
      this.streamBytes = this.streamEntries[0].length + 1;
      this.streamTruncated = true;
      return;
    }

    this.streamEntries.push(serialized);
    this.streamBytes += bytes;

    while (this.streamBytes > STREAM_BUFFER_MAX_BYTES && this.streamEntries.length > 0) {
      const removed = this.streamEntries.shift();
      if (!removed) break;
      this.streamBytes -= removed.length + 1;
      this.streamTruncated = true;
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
