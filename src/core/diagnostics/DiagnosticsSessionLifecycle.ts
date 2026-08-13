import type { DataAdapter } from "obsidian";
import { getHostDeviceType, getHostOperatingSystem } from "../../platform/hostCapabilities";

const AUTOMATIC_DIAGNOSTICS_ARCHIVE_PATTERN = /^(?:systemsculpt-\d{8}-\d{6}\.log|resource-metrics-\d{8}-\d{6}\.ndjson|session-\d{8}-\d{6}\.json)$/u;
const AUTOMATIC_DIAGNOSTICS_SESSION_PATTERN = /^session-(?:latest|\d{8}-\d{6})\.json$/u;
const LEGACY_PRIVATE_OPERATIONS_ARCHIVE_PATTERN = /^operations-\d{8}-\d{6}\.ndjson$/u;
const LEGACY_PRIVATE_OPERATIONS_LATEST_NAME = "operations-latest.ndjson";
const LEGACY_PRIVATE_CHAT_DEBUG_DIRECTORY_NAME = "chat-debug";
const LEGACY_PRIVATE_CHAT_DEBUG_UI_PREFIX = "chat-";
const LEGACY_PRIVATE_CHAT_DEBUG_UI_SUFFIX = "-ui.json";
const LEGACY_PRIVATE_SESSION_KEY_PATTERN = /"(?:vaultName|vault_name|obsidianConfigDir|obsidian_config_dir|enabledPlugins|enabled_plugins)"\s*:/u;
const DIAGNOSTICS_ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DIAGNOSTICS_ARCHIVE_MAX_FILES = 60;
const DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DIAGNOSTICS_SESSION_MAX_INSPECTION_BYTES = 64 * 1024;
const DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES = 1_024;
const DIAGNOSTICS_ARCHIVE_MAX_CANDIDATES = 128;
const DIAGNOSTICS_ARCHIVE_MAX_INSPECTED_BYTES = 512 * 1024;
const DIAGNOSTICS_ARCHIVE_OPERATION_TIMEOUT_MS = 250;
const DIAGNOSTICS_ARCHIVE_TOTAL_TIMEOUT_MS = 2_000;

type AutomaticDiagnosticsFile = Readonly<{
  name: string;
  path: string;
}>;

type DiagnosticsCleanupCandidate = AutomaticDiagnosticsFile & Readonly<{
  kind: "automatic" | "legacy_chat_debug_ui" | "legacy_operations";
}>;

type AutomaticDiagnosticsArchive = AutomaticDiagnosticsFile & Readonly<{
  mtime: number;
  size: number;
}>;

type DiagnosticsCleanupOperationResult<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{ kind: "failed" | "stopped" | "timed_out" }>;

export type DiagnosticsSessionMetadata = Readonly<{
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

export interface DiagnosticsSessionStorage {
  getPath(type: "diagnostics"): string;
  writeFile(type: "diagnostics", fileName: string, data: string | object): Promise<unknown>;
}

export type DiagnosticsSessionLifecycleOptions = Readonly<{
  adapter: DataAdapter;
  storage: DiagnosticsSessionStorage;
  pluginVersion: unknown;
  getObsidianVersion: () => unknown;
}>;

export type DiagnosticsSessionSchedule = Readonly<{
  sessionId: string;
  startedAt: string;
}>;

function compareDiagnosticsPaths(left: AutomaticDiagnosticsFile, right: AutomaticDiagnosticsFile): number {
  if (left.name === "session-latest.json") return right.name === "session-latest.json" ? 0 : -1;
  if (right.name === "session-latest.json") return 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function compareDiagnosticsCleanupCandidates(left: DiagnosticsCleanupCandidate, right: DiagnosticsCleanupCandidate): number {
  const priority = (candidate: DiagnosticsCleanupCandidate): number => {
    if (candidate.kind === "legacy_operations") return 0;
    if (candidate.kind === "legacy_chat_debug_ui") return 1;
    return 2;
  };
  const priorityDifference = priority(left) - priority(right);
  return priorityDifference || compareDiagnosticsPaths(left, right);
}

function isLegacyPrivateChatDebugUiFileName(name: string): boolean {
  if (!name.startsWith(LEGACY_PRIVATE_CHAT_DEBUG_UI_PREFIX) || !name.endsWith(LEGACY_PRIVATE_CHAT_DEBUG_UI_SUFFIX)) return false;
  const chatIdentifier = name.slice(LEGACY_PRIVATE_CHAT_DEBUG_UI_PREFIX.length, -LEGACY_PRIVATE_CHAT_DEBUG_UI_SUFFIX.length);
  return chatIdentifier.length >= 1 && chatIdentifier.length <= 120 && !/[\\/:*?"<>|\s]/u.test(chatIdentifier);
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

export class DiagnosticsSessionLifecycle {
  private admissionOpen = true;

  constructor(private readonly options: DiagnosticsSessionLifecycleOptions) {}

  async schedule(session: DiagnosticsSessionSchedule): Promise<void> {
    if (!this.admissionOpen) return;
    const metadata: DiagnosticsSessionMetadata = {
      schemaVersion: 2,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      environment: {
        pluginVersion: sanitizePublicDiagnosticsVersion(this.options.pluginVersion),
        obsidianVersion: sanitizePublicDiagnosticsVersion(this.options.getObsidianVersion()),
        hostDevice: getHostDeviceType(),
        operatingSystem: getHostOperatingSystem(),
      },
    };

    try {
      await this.options.storage.writeFile("diagnostics", "session-latest.json", metadata);
      await this.options.storage.writeFile("diagnostics", `session-${session.sessionId}.json`, metadata);
    } catch {
      warnDiagnostics("Failed to write session metadata");
    }

    if (!this.admissionOpen) return;
    const cleanup = Promise.resolve().then(() => this.run());
    void cleanup.catch(() => undefined);
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
    let inspectedBytes = 0;
    let inspectedDirectoryEntries = 0;
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
          () => ({ kind: "failed" }),
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
      const chatDebugPath = `${prefix}${LEGACY_PRIVATE_CHAT_DEBUG_DIRECTORY_NAME}`;
      const listingResult = await runBoundedOperation(() => adapter.list(basePath));
      if (listingResult.kind !== "success") {
        collectionFailureCount += 1;
        return;
      }

      let listedFiles: unknown[];
      let listedFolders: unknown[];
      try {
        listedFiles = Array.isArray(listingResult.value.files) ? listingResult.value.files : [];
        listedFolders = Array.isArray(listingResult.value.folders) ? listingResult.value.folders : [];
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

      const inspectDirectoryEntries = (entries: unknown[], maximumEntries: number, inspect: (entry: unknown) => void): void => {
        const remainingEntries = Math.max(0, DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES - inspectedDirectoryEntries);
        const allowedEntries = Math.min(remainingEntries, Math.max(0, maximumEntries));
        let listedEntryCount = 0;
        try {
          listedEntryCount = Math.min(entries.length, allowedEntries);
          if (entries.length > listedEntryCount) collectionFailureCount += 1;
        } catch {
          collectionFailureCount += 1;
          return;
        }
        for (let index = 0; index < listedEntryCount && !shouldStop(); index += 1) {
          inspectedDirectoryEntries += 1;
          try {
            inspect(entries[index]);
          } catch {
            collectionFailureCount += 1;
          }
        }
      };

      let hasChatDebugDirectory = false;
      inspectDirectoryEntries(listedFolders, DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES, (listedPath) => {
        const name = resolveDirectChildName(basePath, listedPath);
        if (name === LEGACY_PRIVATE_CHAT_DEBUG_DIRECTORY_NAME) hasChatDebugDirectory = true;
      });

      const candidatesByPath = new Map<string, DiagnosticsCleanupCandidate>();
      const addRootCandidate = (listedPath: unknown): void => {
        const name = resolveDirectChildName(basePath, listedPath);
        if (!name) return;
        if (name === LEGACY_PRIVATE_OPERATIONS_LATEST_NAME || LEGACY_PRIVATE_OPERATIONS_ARCHIVE_PATTERN.test(name)) {
          candidatesByPath.set(`${prefix}${name}`, { kind: "legacy_operations", name, path: `${prefix}${name}` });
          return;
        }
        if (AUTOMATIC_DIAGNOSTICS_ARCHIVE_PATTERN.test(name) || name === "session-latest.json") {
          candidatesByPath.set(`${prefix}${name}`, { kind: "automatic", name, path: `${prefix}${name}` });
        }
      };

      const entriesRemainingAfterFolders = Math.max(0, DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES - inspectedDirectoryEntries);
      const rootFileBudget = hasChatDebugDirectory ? Math.ceil(entriesRemainingAfterFolders / 2) : entriesRemainingAfterFolders;
      inspectDirectoryEntries(listedFiles, rootFileBudget, addRootCandidate);

      if (hasChatDebugDirectory && !shouldStop()) {
        const chatListingResult = await runBoundedOperation(() => adapter.list(chatDebugPath));
        if (chatListingResult.kind !== "success") {
          collectionFailureCount += 1;
        } else {
          let chatFiles: unknown[] | null = null;
          try {
            chatFiles = Array.isArray(chatListingResult.value.files) ? chatListingResult.value.files : null;
          } catch {
            collectionFailureCount += 1;
          }
          if (chatFiles) {
            inspectDirectoryEntries(chatFiles, DIAGNOSTICS_ARCHIVE_MAX_DIRECTORY_ENTRIES - inspectedDirectoryEntries, (listedPath) => {
              const name = resolveDirectChildName(chatDebugPath, listedPath);
              if (!name || !isLegacyPrivateChatDebugUiFileName(name)) return;
              const path = `${chatDebugPath}/${name}`;
              candidatesByPath.set(path, { kind: "legacy_chat_debug_ui", name, path });
            });
          }
        }
      }

      const selectedCandidates = [...candidatesByPath.values()].sort(compareDiagnosticsCleanupCandidates).slice(0, DIAGNOSTICS_ARCHIVE_MAX_CANDIDATES);
      if (candidatesByPath.size > DIAGNOSTICS_ARCHIVE_MAX_CANDIDATES) collectionFailureCount += 1;

      const removePaths = async (paths: readonly string[]): Promise<void> => {
        for (const path of paths) {
          if (shouldStop()) break;
          const removeResult = await runBoundedOperation(async () => {
            if (shouldStop()) return false;
            await adapter.remove(path);
            return true;
          });
          if (removeResult.kind === "stopped" || removeResult.kind === "timed_out") {
            removalFailureCount += 1;
            break;
          }
          if (removeResult.kind !== "success" || !removeResult.value) removalFailureCount += 1;
        }
      };

      await removePaths(selectedCandidates.filter((candidate) => candidate.kind !== "automatic").map((candidate) => candidate.path));

      if (hasChatDebugDirectory && !shouldStop() && typeof adapter.rmdir === "function") {
        const emptyCheckResult = await runBoundedOperation(() => adapter.list(chatDebugPath));
        if (emptyCheckResult.kind === "success") {
          let isConfirmedEmpty = false;
          try {
            isConfirmedEmpty = Array.isArray(emptyCheckResult.value.files) && emptyCheckResult.value.files.length === 0 && Array.isArray(emptyCheckResult.value.folders) && emptyCheckResult.value.folders.length === 0;
          } catch {
            collectionFailureCount += 1;
          }
          if (isConfirmedEmpty && !shouldStop()) {
            const directoryRemovalResult = await runBoundedOperation(async () => {
              if (shouldStop()) return false;
              await adapter.rmdir(chatDebugPath, false);
              return true;
            });
            if (directoryRemovalResult.kind !== "success" || !directoryRemovalResult.value) removalFailureCount += 1;
          }
        } else {
          collectionFailureCount += 1;
        }
      }

      const automaticFiles = selectedCandidates.filter((candidate): candidate is DiagnosticsCleanupCandidate & Readonly<{ kind: "automatic" }> => candidate.kind === "automatic");
      const fileStats = new Map<string, AutomaticDiagnosticsArchive>();
      for (const file of automaticFiles) {
        if (shouldStop()) break;
        const statResult = await runBoundedOperation(() => adapter.stat(file.path));
        if (statResult.kind === "stopped" || statResult.kind === "timed_out") {
          collectionFailureCount += 1;
          break;
        }
        if (statResult.kind !== "success") {
          collectionFailureCount += 1;
          continue;
        }
        const stat = statResult.value;
        if (!stat || stat.type !== "file" || !Number.isFinite(stat.mtime) || !Number.isFinite(stat.size) || stat.size < 0) {
          collectionFailureCount += 1;
          continue;
        }
        fileStats.set(file.path, { ...file, mtime: stat.mtime, size: Math.floor(stat.size) });
      }

      const pathsToRemove = new Set<string>();
      const sessionFiles = [...fileStats.values()].filter((file) => AUTOMATIC_DIAGNOSTICS_SESSION_PATTERN.test(file.name)).sort(compareDiagnosticsPaths);
      for (const file of sessionFiles) {
        if (shouldStop()) break;
        if (file.size > DIAGNOSTICS_SESSION_MAX_INSPECTION_BYTES) {
          pathsToRemove.add(file.path);
          continue;
        }
        if (file.size > DIAGNOSTICS_ARCHIVE_MAX_INSPECTED_BYTES - inspectedBytes) {
          collectionFailureCount += 1;
          break;
        }
        inspectedBytes += file.size;
        const readResult = await runBoundedOperation(() => adapter.read(file.path));
        if (readResult.kind === "stopped" || readResult.kind === "timed_out") {
          collectionFailureCount += 1;
          break;
        }
        if (readResult.kind !== "success") {
          collectionFailureCount += 1;
          continue;
        }
        if (LEGACY_PRIVATE_SESSION_KEY_PATTERN.test(readResult.value)) pathsToRemove.add(file.path);
      }

      const archives = [...fileStats.values()]
        .filter((file) => AUTOMATIC_DIAGNOSTICS_ARCHIVE_PATTERN.test(file.name))
        .filter((file) => !pathsToRemove.has(file.path))
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
