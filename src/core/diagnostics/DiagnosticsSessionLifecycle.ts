import type { DataAdapter } from "obsidian";
import { getHostDeviceType, getHostOperatingSystem } from "../../platform/hostCapabilities";

const AUTOMATIC_DIAGNOSTICS_ARCHIVE_PATTERN = /^(?:systemsculpt-\d{8}-\d{6}\.log|resource-metrics-\d{8}-\d{6}\.ndjson|session-\d{8}-\d{6}\.json)$/u;
const DIAGNOSTICS_ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DIAGNOSTICS_ARCHIVE_MAX_FILES = 60;
const DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES = 1_024;
const DIAGNOSTICS_ARCHIVE_MAX_CANDIDATES = 128;
const DIAGNOSTICS_ARCHIVE_OPERATION_TIMEOUT_MS = 250;
const DIAGNOSTICS_ARCHIVE_TOTAL_TIMEOUT_MS = 2_000;

type AutomaticDiagnosticsFile = Readonly<{
  name: string;
  path: string;
}>;

type AutomaticDiagnosticsArchive = AutomaticDiagnosticsFile & Readonly<{
  mtime: number;
  size: number;
}>;

type DiagnosticsCleanupOperationResult<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{ kind: "failed" | "missing" | "stopped" | "timed_out" }>;

type DiagnosticsSessionMetadata = Readonly<{
  schemaVersion: 2;
  sessionId: string;
  startedAt: string;
  environment: Readonly<{
    pluginVersion: string;
    obsidianVersion: string;
    hostDevice: ReturnType<typeof getHostDeviceType>;
    operatingSystem: ReturnType<typeof getHostOperatingSystem>;
  }>;
}>;

interface DiagnosticsSessionStorage {
  initialize(): Promise<void>;
  getPath(type: "diagnostics"): string;
  writeFile(type: "diagnostics", fileName: string, data: string | object): Promise<unknown>;
  appendToFile(type: "diagnostics", fileName: string, data: string): Promise<unknown>;
}

export type DiagnosticsSessionLifecycleOptions = Readonly<{
  adapter: DataAdapter;
  storage: DiagnosticsSessionStorage;
  pluginVersion: unknown;
  getObsidianVersion: () => unknown;
}>;

function compareDiagnosticsPaths(left: AutomaticDiagnosticsFile, right: AutomaticDiagnosticsFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function warnDiagnostics(message: string): void {
  try {
    console.warn(`[SystemSculpt][Diagnostics] ${message}`);
  } catch {
    // Diagnostics cleanup must never create a new failure path.
  }
}

export function sanitizePublicDiagnosticsVersion(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return /^\d{1,4}(?:\.\d{1,4}){1,3}$/u.test(value) ? value : "unknown";
}

/**
 * Owns the diagnostics session around the automatic `-latest` files.
 *
 * Every launch archives the previous session's files (rename only) and prunes
 * archives, so diagnostics stay bounded even while recording is off. Session
 * records are written only while diagnostics recording is on (#337). The
 * session identity is fixed at construction; the archive itself runs off the
 * load path, before the first diagnostics write at the latest (#343).
 */
export class DiagnosticsSessionLifecycle {
  readonly logFileName = "systemsculpt-latest.log";
  readonly metricsFileName = "resource-metrics-latest.ndjson";
  private activeSessionId: string | null = null;
  private startedAt: Date | null = null;
  private startup: Promise<void> | null = null;
  private sessionRecord: Promise<void> | null = null;
  private admissionOpen = true;

  constructor(private readonly options: DiagnosticsSessionLifecycleOptions) {
    const startedAt = new Date();
    const pad = (value: number): string => value.toString().padStart(2, "0");
    this.activeSessionId = [
      startedAt.getFullYear(), pad(startedAt.getMonth() + 1), pad(startedAt.getDate()),
      "-", pad(startedAt.getHours()), pad(startedAt.getMinutes()), pad(startedAt.getSeconds()),
    ].join("");
    this.startedAt = startedAt;
  }

  get sessionId(): string | null {
    return this.activeSessionId;
  }

  /** Prepares one session. Concurrent callers share archiving and cleanup. */
  start(): Promise<void> {
    return this.startup ??= this.prepare();
  }

  /** Writes this session's header and metadata once, when diagnostics recording is on. */
  recordSession(): Promise<void> {
    return this.sessionRecord ??= this.writeSessionRecord();
  }

  private async prepare(): Promise<void> {
    if (!this.admissionOpen) return;
    try {
      await this.options.storage.initialize();
    } catch {
      warnDiagnostics("Failed to initialize storage");
    }
    if (!this.admissionOpen) return;

    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    await this.rotate(this.logFileName, `systemsculpt-${sessionId}.log`);
    await this.rotate(this.metricsFileName, `resource-metrics-${sessionId}.ndjson`);

    if (!this.admissionOpen) return;
    const cleanup = Promise.resolve().then(() => this.run());
    void cleanup.catch(() => undefined);
  }

  /** Archives a previous session's file. Nothing is created: writers append on demand. */
  private async rotate(latestName: string, archiveName: string): Promise<void> {
    if (!this.admissionOpen) return;
    const { adapter, storage } = this.options;
    const basePath = storage.getPath("diagnostics");
    const latestPath = `${basePath}/${latestName}`;
    try {
      if (await adapter.exists(latestPath)) {
        if (!this.admissionOpen) return;
        await adapter.rename(latestPath, `${basePath}/${archiveName}`);
      }
    } catch {
      warnDiagnostics("Failed to rotate file");
    }
  }

  private async writeSessionRecord(): Promise<void> {
    await this.start();
    const sessionId = this.activeSessionId;
    const startedAt = this.startedAt;
    if (!this.admissionOpen || !sessionId || !startedAt) return;
    const { storage } = this.options;
    const pluginVersion = sanitizePublicDiagnosticsVersion(this.options.pluginVersion);
    try {
      await storage.appendToFile(
        "diagnostics",
        this.logFileName,
        `SystemSculpt diagnostics session ${sessionId} (plugin v${pluginVersion})\n`,
      );
    } catch {
      warnDiagnostics("Failed to write session header");
    }

    if (!this.admissionOpen) return;
    const metadata: DiagnosticsSessionMetadata = {
      schemaVersion: 2,
      sessionId,
      startedAt: startedAt.toISOString(),
      environment: {
        pluginVersion,
        obsidianVersion: sanitizePublicDiagnosticsVersion(this.options.getObsidianVersion()),
        hostDevice: getHostDeviceType(),
        operatingSystem: getHostOperatingSystem(),
      },
    };

    try {
      await storage.writeFile("diagnostics", "session-latest.json", metadata);
      await storage.writeFile("diagnostics", `session-${sessionId}.json`, metadata);
    } catch {
      warnDiagnostics("Failed to write session metadata");
    }
  }

  close(): void {
    this.admissionOpen = false;
  }

  async run(now: number = Date.now()): Promise<void> {
    if (!this.admissionOpen) return;
    const { adapter, storage } = this.options;
    const startedAt = performance.now();
    let deadlineReached = false;
    let operationTimedOut = false;
    let deadlineTimer: number | null = null;
    let collectionFailureCount = 0;
    let removalFailureCount = 0;
    const deadlineSignal = new Promise<DiagnosticsCleanupOperationResult<never>>((resolve) => {
      deadlineTimer = window.setTimeout(() => {
        deadlineReached = true;
        resolve({ kind: "stopped" });
      }, DIAGNOSTICS_ARCHIVE_TOTAL_TIMEOUT_MS);
    });
    const shouldStop = (): boolean => {
      if (!deadlineReached && performance.now() - startedAt >= DIAGNOSTICS_ARCHIVE_TOTAL_TIMEOUT_MS) deadlineReached = true;
      return operationTimedOut || deadlineReached || !this.admissionOpen;
    };
    const runBoundedOperation = async <T>(operation: () => T | Promise<T>): Promise<DiagnosticsCleanupOperationResult<T>> => {
      if (shouldStop()) return { kind: "stopped" };
      let operationTimer: number | null = null;
      const observedOperation = Promise.resolve()
        .then(operation)
        .then<DiagnosticsCleanupOperationResult<T>, DiagnosticsCleanupOperationResult<T>>(
          (value) => ({ kind: "success", value }),
          (error: unknown) => ({ kind: error instanceof Error && /ENOENT|not found|does not exist/i.test(error.message) ? "missing" : "failed" }),
        );
      const operationTimeout = new Promise<DiagnosticsCleanupOperationResult<T>>((resolve) => {
        operationTimer = window.setTimeout(() => resolve({ kind: "timed_out" }), DIAGNOSTICS_ARCHIVE_OPERATION_TIMEOUT_MS);
      });
      const result = await Promise.race([observedOperation, operationTimeout, deadlineSignal]);
      if (operationTimer !== null) window.clearTimeout(operationTimer);
      if (result.kind === "timed_out") operationTimedOut = true;
      return shouldStop() ? { kind: "stopped" } : result;
    };

    try {
      const basePath = storage.getPath("diagnostics").replace(/\/$/u, "");
      const prefix = `${basePath}/`;
      const listingResult = await runBoundedOperation(() => adapter.list(basePath));
      if (listingResult.kind !== "success") {
        if (listingResult.kind === "failed") collectionFailureCount += 1;
        return;
      }

      let listedFiles: unknown[];
      try {
        listedFiles = Array.isArray(listingResult.value.files) ? listingResult.value.files : [];
      } catch {
        collectionFailureCount += 1;
        return;
      }

      const resolveDirectChildName = (parentPath: string, listedPath: unknown): string | null => {
        if (typeof listedPath !== "string" || listedPath.length === 0) return null;
        const parentPrefix = `${parentPath}/`;
        const name = listedPath.startsWith(parentPrefix) ? listedPath.slice(parentPrefix.length) : listedPath;
        if (!name || name.includes("/") || name.includes("\\")) return null;
        return name;
      };

      const candidatesByPath = new Map<string, AutomaticDiagnosticsFile>();
      const listedEntryCount = Math.min(listedFiles.length, DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES);
      for (let index = 0; index < listedEntryCount && !shouldStop(); index += 1) {
        try {
          const name = resolveDirectChildName(basePath, listedFiles[index]);
          if (name && AUTOMATIC_DIAGNOSTICS_ARCHIVE_PATTERN.test(name)) {
            candidatesByPath.set(`${prefix}${name}`, { name, path: `${prefix}${name}` });
          }
        } catch {
          collectionFailureCount += 1;
        }
      }

      const automaticFiles = [...candidatesByPath.values()].sort(compareDiagnosticsPaths).slice(0, DIAGNOSTICS_ARCHIVE_MAX_CANDIDATES);

      const removePaths = async (paths: readonly string[]): Promise<void> => {
        for (const path of paths) {
          if (shouldStop()) break;
          const removeResult = await runBoundedOperation(async () => {
            if (shouldStop()) return false;
            await adapter.remove(path);
            return true;
          });
          if (removeResult.kind === "stopped" || removeResult.kind === "timed_out") {
            break;
          }
          if (removeResult.kind === "failed" || (removeResult.kind === "success" && !removeResult.value)) removalFailureCount += 1;
        }
      };

      const fileStats = new Map<string, AutomaticDiagnosticsArchive>();
      for (const file of automaticFiles) {
        if (shouldStop()) break;
        const statResult = await runBoundedOperation(() => adapter.stat(file.path));
        if (statResult.kind === "stopped" || statResult.kind === "timed_out") {
          break;
        }
        if (statResult.kind === "missing") continue;
        if (statResult.kind !== "success") {
          collectionFailureCount += 1;
          continue;
        }
        const stat = statResult.value;
        if (!stat) continue;
        if (stat.type !== "file" || !Number.isFinite(stat.mtime) || !Number.isFinite(stat.size) || stat.size < 0) {
          collectionFailureCount += 1;
          continue;
        }
        fileStats.set(file.path, { ...file, mtime: stat.mtime, size: Math.floor(stat.size) });
      }

      const pathsToRemove = new Set<string>();
      const archives = [...fileStats.values()]
        .sort((left, right) => right.mtime - left.mtime || compareDiagnosticsPaths(left, right));
      let retainedFileCount = 0;
      let retainedTotalBytes = 0;
      for (const archive of archives) {
        const isExpired = now - archive.mtime > DIAGNOSTICS_ARCHIVE_MAX_AGE_MS;
        const exceedsCount = retainedFileCount >= DIAGNOSTICS_ARCHIVE_MAX_FILES;
        const exceedsBytes = archive.size > DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES - retainedTotalBytes;
        if (isExpired || exceedsCount || exceedsBytes) {
          pathsToRemove.add(archive.path);
          continue;
        }
        retainedFileCount += 1;
        retainedTotalBytes += archive.size;
      }

      await removePaths([...pathsToRemove].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    } catch {
      collectionFailureCount += 1;
    } finally {
      if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
      if (collectionFailureCount > 0 || removalFailureCount > 0) warnDiagnostics(`Archive cleanup skipped ${collectionFailureCount} file checks and ${removalFailureCount} removals`);
    }
  }
}
