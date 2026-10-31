import { FileSystemAdapter, type DataAdapter } from "obsidian";
import { hasHostCapability, openLocalFolder } from "../../platform/hostCapabilities";
import type { ResourceMonitorService } from "../../services/ResourceMonitorService";
import type { PluginLogger } from "../../utils/PluginLogger";
import { sanitizePublicDiagnosticsVersion } from "./DiagnosticsSessionLifecycle";

type PublicSupportResourceSample = Readonly<{
  captured_at?: string;
  heap_used_mb?: number;
  heap_limit_mb?: number;
  rss_mb?: number;
  cpu_percent?: number;
  event_loop_lag_ms?: number;
  freeze_delta_ms?: number;
}>;

interface DiagnosticsStorage {
  writeFile(type: "diagnostics", fileName: string, data: string): Promise<{ success: boolean; path?: string }>;
  ensureLocation(type: "diagnostics"): Promise<void>;
  getPath(type: "diagnostics"): string;
}

export type DiagnosticsFacadeOptions = Readonly<{
  getStatus: () => Readonly<{
    safeMode: boolean;
    initializationIssueCount: number;
    settingsLoaded: boolean;
  }>;
  areDirectoriesReady: () => boolean;
  getLogger: () => Pick<PluginLogger, "getSupportDiagnostics">;
  getResourceMonitor: () => Pick<ResourceMonitorService, "getRecentSamples" | "isRecording"> | null;
  getStorage: () => DiagnosticsStorage | undefined;
  getPluginVersion: () => unknown;
  getObsidianVersion: () => unknown;
  getAdapter: () => DataAdapter;
}>;

function normalizePublicDiagnosticsLimit(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function projectPublicSupportResourceSample(sample: unknown): PublicSupportResourceSample | null {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return null;
  const candidate = sample as Record<string, unknown>;
  const projected: {
    captured_at?: string;
    heap_used_mb?: number;
    heap_limit_mb?: number;
    rss_mb?: number;
    cpu_percent?: number;
    event_loop_lag_ms?: number;
    freeze_delta_ms?: number;
  } = {};

  if (typeof candidate.iso === "string" && candidate.iso.length <= 40) {
    const parsed = Date.parse(candidate.iso);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === candidate.iso) {
      projected.captured_at = candidate.iso;
    }
  }

  const metrics = [
    ["heap_used_mb", candidate.heapUsedMB],
    ["heap_limit_mb", candidate.heapLimitMB],
    ["rss_mb", candidate.rssMB],
    ["cpu_percent", candidate.cpuPercent],
    ["event_loop_lag_ms", candidate.eventLoopLagMs],
    ["freeze_delta_ms", candidate.freezeDeltaMs],
  ] as const;
  let metricCount = 0;
  for (const [key, value] of metrics) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      continue;
    }
    projected[key] = Math.round(value * 10) / 10;
    metricCount += 1;
  }
  return metricCount > 0 ? Object.freeze(projected) : null;
}

/** Owns the public support projection and its explicit local export operations. */
export class DiagnosticsFacade {
  constructor(private readonly options: DiagnosticsFacadeOptions) {}

  /**
   * Build the only diagnostic surface intended for clipboard or support use.
   * Raw console entries and local log files deliberately stay outside this
   * allowlisted, content-free schema.
   */
  public buildDiagnosticsSnapshot(eventLimit: number = 200, resourceLimit: number = 8): string {
    const monitor = this.options.getResourceMonitor();
    let resources: PublicSupportResourceSample[] = [];
    const resourceCount = normalizePublicDiagnosticsLimit(resourceLimit, 8, 24);
    if (monitor && resourceCount > 0) {
      try {
        resources = monitor
          .getRecentSamples(resourceCount)
          .map(projectPublicSupportResourceSample)
          .filter((sample): sample is PublicSupportResourceSample => sample !== null);
      } catch {
        resources = [];
      }
    }

    let directoriesReady = false;
    try {
      directoriesReady = this.options.areDirectoriesReady() === true;
    } catch {
      directoriesReady = false;
    }

    const events = this.options.getLogger().getSupportDiagnostics(
      normalizePublicDiagnosticsLimit(eventLimit, 200, 500),
    );
    const status = this.options.getStatus();
    const snapshot = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      plugin_version: sanitizePublicDiagnosticsVersion(this.options.getPluginVersion()),
      obsidian_version: sanitizePublicDiagnosticsVersion(this.options.getObsidianVersion()),
      status: {
        safe_mode: status.safeMode,
        initialization_issue_count: Math.min(9_999, status.initializationIssueCount),
        settings_loaded: status.settingsLoaded,
        directories_ready: directoriesReady,
        resource_monitor_running: monitor?.isRecording() === true,
      },
      event_count: events.length,
      events,
      resource_sample_count: resources.length,
      resources,
    };
    return JSON.stringify(snapshot, null, 2);
  }

  public async exportDiagnosticsSnapshot(
    logLines: number = 200,
    resourceLines: number = 8,
  ): Promise<{ text: string; path?: string }> {
    const snapshot = this.buildDiagnosticsSnapshot(logLines, resourceLines);
    const storage = this.options.getStorage();
    if (!storage) {
      return { text: snapshot };
    }
    const nonce = this.createDiagnosticsFileNonce();
    if (!/^[0-9a-f]{32}$/u.test(nonce)) {
      throw new Error("Secure diagnostics export identifier is invalid.");
    }
    const fileName =
      `diagnostics-${this.formatDiagnosticsFileTimestamp(new Date())}-${nonce}.txt`;
    const result = await storage.writeFile("diagnostics", fileName, snapshot);
    return {
      text: snapshot,
      path: result.success ? result.path : undefined,
    };
  }

  public async openDiagnosticsFolder(): Promise<boolean> {
    const storage = this.options.getStorage();
    if (!storage) {
      return false;
    }
    try {
      await storage.ensureLocation("diagnostics");
    } catch {
      // Best effort; continue without blocking
    }
    const relativePath = storage.getPath("diagnostics");
    const adapter = this.options.getAdapter();
    if (adapter instanceof FileSystemAdapter && hasHostCapability("file-manager-reveal")) {
      const fullPath = adapter.getFullPath(relativePath);
      return openLocalFolder(fullPath);
    }
    return false;
  }

  private createDiagnosticsFileNonce(): string {
    const runtimeCrypto = window.crypto;
    if (typeof runtimeCrypto?.getRandomValues !== "function") {
      throw new Error("Secure diagnostics export identifiers are unavailable.");
    }
    const bytes = new Uint8Array(16);
    runtimeCrypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private formatDiagnosticsFileTimestamp(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "-",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");
  }
}
