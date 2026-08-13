import type { ListedFiles, Stat } from "obsidian";
import { isThinAgentCommandKind } from "../../services/managed/ThinAgentV1Contract";
import { isFirstPartyToolName } from "../../tools/toolNames";
import {
  isAgentLifecycleCode,
  isAgentLifecyclePhase,
  isCreditsRefreshReason,
  isHistorySyncKind,
  isToolDiagnosticFailureClass,
  isToolDiagnosticOutcome,
} from "../../utils/ThinAgentLifecycleSchema";
import { canonicalJsonStringify, utf8ByteLength } from "./AgentIncidentCanonicalJson";
import {
  AGENT_INCIDENT_CAPTURE_FAILURE_CODES,
  AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES,
  AGENT_INCIDENT_GROUPING_STRATEGY,
  AGENT_INCIDENT_MAX_COUNT as MAX_COUNT,
  AGENT_INCIDENT_MAX_EVENTS as MAX_TIMELINE_EVENTS,
  AGENT_INCIDENT_MAX_RENDER_COUNT as MAX_RENDER_COUNT,
  AGENT_INCIDENT_MAX_RENDER_DURATION_MS as MAX_RENDER_DURATION_MS,
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_MAX_RESOURCE_SAMPLES as MAX_RESOURCE_SAMPLES,
  AGENT_INCIDENT_MAX_TOOL_ORDINAL as MAX_TOOL_ORDINAL,
  AGENT_INCIDENT_MAX_TOOLS as MAX_TOOLS,
  AGENT_INCIDENT_MAX_TRANSPORT_BYTES as MAX_TRANSPORT_BYTES,
  AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT as MAX_TRANSPORT_OBSERVATION_COUNT,
  AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS as MAX_TRANSPORT_SEGMENTS,
  AGENT_INCIDENT_MISSING_FIELD_CODES,
  AGENT_INCIDENT_SCHEMA_VERSION,
  AGENT_INCIDENT_TRANSPORT_SEGMENT_CLOSE_REASONS,
  buildAgentIncidentGroupingFingerprint,
  deriveAgentIncidentTerminalEvidence,
  isAgentIncidentFailureMechanism,
  isAgentIncidentFailureStage,
  isAgentIncidentExportedFailureCode,
  type AgentIncidentExportedFailureCode,
  type AgentIncidentFailureAuthority,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
  type AgentIncidentTerminalEvidence,
  type AgentIncidentTerminalSource,
  type AgentIncidentTerminalValidation,
} from "./AgentIncidentSchema";

export const AGENT_INCIDENT_STORE_PATH = ".systemsculpt/diagnostics/incidents";
export const AGENT_INCIDENT_MAX_REPORTS = 20;
export const AGENT_INCIDENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const AGENT_INCIDENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES = 1_024;
export const AGENT_INCIDENT_MAX_SCAN_CANDIDATES = 128;
export const AGENT_INCIDENT_MAX_SCAN_BYTES = 4 * 1024 * 1024;

export {
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_SCHEMA_VERSION,
} from "./AgentIncidentSchema";

const AGENT_INCIDENT_SCAN_BATCH_SIZE = 16;

const REPORT_ID_PATTERN = /^report_[a-f0-9]{32}$/;
const INCIDENT_ID_PATTERN = /^incident_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^run_(?!0{32}$)[a-f0-9]{32}$/;
const SERVER_LATENCY_CORRELATION_ID_PATTERN = /^(?!0{32}$)[a-f0-9]{32}$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_BUILD_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/;
const RFC3339_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TEMP_FILE_PATTERN = /\.tmp$/;
const CORRUPT_REPORT_FILE_PATTERN = /\.json\.corrupt(?:-\d+)?$/;
const MAX_SERIALIZATION_DEPTH = 64;
const MAX_SERIALIZATION_VALUES = 100_000;
const MAX_TOOL_ITEM_COUNT = 10_000;
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1_000;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CAPTURE_FAILURE_CODE_SET = new Set<string>(AGENT_INCIDENT_CAPTURE_FAILURE_CODES);

interface AdapterCoordination {
  tail: Promise<void>;
}

const ADAPTER_COORDINATION = new WeakMap<object, AdapterCoordination>();

type CanonicalObject = { [key: string]: CanonicalJson };
type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalObject;

export interface AgentIncidentStoreAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<Stat | null>;
  list(path: string): Promise<ListedFiles>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename?: (path: string, newPath: string) => Promise<void>;
}

export interface AgentIncidentStoreIncident {
  readonly classification: "operation_failure";
  readonly impact: "run_failed";
  readonly outcome: "failed";
  readonly severity_text: "ERROR";
  readonly severity_number: 17;
  readonly failure_authority: AgentIncidentFailureAuthority;
  readonly origin: "agent_terminal" | "agent_local_failure";
  readonly terminal_evidence: AgentIncidentTerminalEvidence;
  readonly artifact_integrity: "unauthenticated_client_record";
  readonly evidence_scope: "client_observation_only";
  readonly causal_assessment: "not_established";
  readonly observation_source: "server_protocol_terminal" | "server_http_response" | "client_runtime";
  readonly failure_stage: AgentIncidentFailureStage | "not_recorded";
  readonly failure_mechanism: AgentIncidentFailureMechanism | "not_recorded";
  readonly incident_id?: string;
  readonly failure_code?: string;
  readonly retryable?: boolean;
  readonly http_status?: number;
}

/**
 * The store only owns persistence. The recorder owns the closed, privacy-safe
 * report schema. This structural boundary keeps the store independent of the
 * recorder while retaining the fields needed for identity and retention.
 */
export interface AgentIncidentStoreReport {
  readonly schema_version: typeof AGENT_INCIDENT_SCHEMA_VERSION;
  readonly report_id: string;
  readonly created_at: string;
  readonly incident: AgentIncidentStoreIncident;
}

export interface StoredAgentIncidentReport<TReport extends AgentIncidentStoreReport = AgentIncidentStoreReport> {
  readonly report: TReport;
  /** Canonical JSON bytes used for both disk persistence and explicit copy. */
  readonly serialized: string;
  readonly sizeBytes: number;
}

export interface AgentIncidentStoreSaveResult<TReport extends AgentIncidentStoreReport = AgentIncidentStoreReport>
  extends StoredAgentIncidentReport<TReport> {
  readonly created: boolean;
  readonly retention: AgentIncidentRetentionResult;
}

export interface AgentIncidentRetentionResult {
  readonly scanComplete: boolean;
  readonly inspectedCandidates: number;
  readonly inspectedBytes: number;
  readonly skippedCandidates: number;
  readonly scannedReports: number;
  readonly retainedReports: number;
  readonly retainedBytes: number;
  readonly removedReports: number;
  readonly removedArtifacts: number;
  readonly corruptReports: number;
  readonly cleanupFailures: number;
  readonly limitsSatisfied: boolean;
}

export type AgentIncidentStoreErrorCode =
  | "invalid_identifier"
  | "invalid_report"
  | "report_too_large"
  | "duplicate_report_id"
  | "lookup_incomplete"
  | "persistence_unavailable";

export class AgentIncidentStoreError extends Error {
  constructor(public readonly code: AgentIncidentStoreErrorCode, message: string) {
    super(message);
    this.name = "AgentIncidentStoreError";
  }
}

export interface AgentIncidentStoreOptions {
  now?: () => number;
  writeAttempts?: number;
  maxReports?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  maxReportBytes?: number;
  maxScanCandidates?: number;
  maxScanBytes?: number;
  yieldToHost?: () => Promise<void>;
}

interface StoreLimits {
  writeAttempts: number;
  maxReports: number;
  maxTotalBytes: number;
  maxAgeMs: number;
  maxReportBytes: number;
  maxScanCandidates: number;
  maxScanBytes: number;
}

interface ReportEntry extends StoredAgentIncidentReport {
  path: string;
  reportId: string;
  incidentId?: string;
  createdAtMs: number;
  ctimeMs: number;
  mtimeMs: number;
  diskBytes: number;
}

interface ArtifactEntry {
  path: string;
  reportCreatedAtMs?: number;
  ctimeMs: number;
  mtimeMs: number;
  diskBytes: number;
}

type CandidateRead =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "valid"; entry: ReportEntry }
  | { kind: "corrupt"; artifact: ArtifactEntry | null };

interface ScanResult {
  reports: ReportEntry[];
  artifacts: ArtifactEntry[];
  corruptReports: number;
  cleanupFailures: number;
  removedArtifacts: number;
  scanFailed: boolean;
  inspectedCandidates: number;
  inspectedBytes: number;
  skippedCandidates: number;
}

/**
 * Persists frozen client incident reports without network access. The store
 * never reads logs or chat content and never derives report fields.
 */
export class AgentIncidentStore {
  private readonly now: () => number;
  private readonly limits: StoreLimits;
  private readonly coordination: AdapterCoordination;
  private readonly yieldToHost: () => Promise<void>;
  private initialized = false;
  private initializationPromise: Promise<AgentIncidentRetentionResult> | null = null;

  constructor(
    private readonly adapter: AgentIncidentStoreAdapter,
    options: AgentIncidentStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.yieldToHost = options.yieldToHost ?? yieldToHost;
    this.coordination = adapterCoordination(adapter);
    const maxTotalBytes = boundedInteger(options.maxTotalBytes, AGENT_INCIDENT_MAX_TOTAL_BYTES, 1, 100 * 1024 * 1024);
    this.limits = {
      writeAttempts: boundedInteger(options.writeAttempts, 3, 1, 5),
      maxReports: boundedInteger(options.maxReports, AGENT_INCIDENT_MAX_REPORTS, 1, 100),
      maxTotalBytes,
      maxAgeMs: boundedInteger(options.maxAgeMs, AGENT_INCIDENT_MAX_AGE_MS, 1, 365 * 24 * 60 * 60 * 1000),
      maxReportBytes: Math.min(
        maxTotalBytes,
        boundedInteger(options.maxReportBytes, AGENT_INCIDENT_MAX_REPORT_BYTES, 1, AGENT_INCIDENT_MAX_REPORT_BYTES),
      ),
      maxScanCandidates: boundedInteger(options.maxScanCandidates, AGENT_INCIDENT_MAX_SCAN_CANDIDATES, 1, AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES),
      maxScanBytes: boundedInteger(options.maxScanBytes, AGENT_INCIDENT_MAX_SCAN_BYTES, 1, AGENT_INCIDENT_MAX_TOTAL_BYTES),
    };
  }

  public initialize(): Promise<AgentIncidentRetentionResult> {
    return this.exclusive(() => this.ensureInitialized());
  }

  /** Return canonical JSON without writing it. */
  public serialize(report: AgentIncidentStoreReport): string {
    return this.serializeUnknown(report);
  }

  public async save<TReport extends AgentIncidentStoreReport>(
    report: TReport,
  ): Promise<AgentIncidentStoreSaveResult<TReport>> {
    const serialized = this.serializeUnknown(report);
    const sizeBytes = utf8ByteLength(serialized);
    if (sizeBytes > this.limits.maxReportBytes) {
      throw new AgentIncidentStoreError("report_too_large", "The incident report exceeds the local size limit.");
    }

    const parsed = this.parseSerialized<TReport>(serialized);
    return this.exclusive(async () => {
      await this.ensureInitialized();
      const path = this.reportPath(parsed.report.report_id);
      const created = await this.persistWithRetry(path, serialized, parsed.report.report_id);
      const retention = await this.enforceRetentionInternal(path);
      const retained = await this.readCandidate(path, parsed.report.report_id, false);
      if (retained.kind !== "valid" || retained.entry.serialized !== serialized) {
        throw new AgentIncidentStoreError("persistence_unavailable", "The incident report did not survive local retention.");
      }
      return Object.freeze({
        report: parsed.report,
        serialized,
        sizeBytes,
        created,
        retention,
      });
    });
  }

  public async loadByReportId<TReport extends AgentIncidentStoreReport = AgentIncidentStoreReport>(
    reportId: string,
  ): Promise<StoredAgentIncidentReport<TReport> | null> {
    validateReportId(reportId);
    return await this.exclusive(async () => {
      await this.ensureInitialized();
      const candidate = await this.readCandidate(this.reportPath(reportId), reportId, true);
      if (candidate.kind === "unavailable") {
        throw new AgentIncidentStoreError("lookup_incomplete", "The local incident report could not be inspected.");
      }
      return candidate.kind === "valid" ? storedResult<TReport>(candidate.entry) : null;
    });
  }

  public async loadByIncidentId<TReport extends AgentIncidentStoreReport = AgentIncidentStoreReport>(
    incidentId: string,
  ): Promise<StoredAgentIncidentReport<TReport> | null> {
    validateIncidentId(incidentId);
    return await this.exclusive(async () => {
      await this.ensureInitialized();
      const scan = await this.scanDirectory();
      const matches = scan.reports
        .filter((entry) => entry.incidentId === incidentId)
        .sort(compareNewestFirst);
      if (matches.length > 0) return storedResult<TReport>(matches[0]);
      if (scan.scanFailed) {
        throw new AgentIncidentStoreError("lookup_incomplete", "The local incident lookup reached its bounded scan limit.");
      }
      return null;
    });
  }

  public enforceRetention(): Promise<AgentIncidentRetentionResult> {
    return this.exclusive(async () => {
      await this.ensureDirectoryWithRetry();
      return this.enforceRetentionInternal();
    });
  }

  private async ensureInitialized(): Promise<AgentIncidentRetentionResult> {
    if (this.initialized) return emptyRetentionResult();
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeInternal();
    }
    try {
      const result = await this.initializationPromise;
      this.initialized = true;
      return result;
    } finally {
      if (!this.initialized) this.initializationPromise = null;
    }
  }

  private async initializeInternal(): Promise<AgentIncidentRetentionResult> {
    await this.ensureDirectoryWithRetry();
    return this.enforceRetentionInternal();
  }

  private async ensureDirectoryWithRetry(): Promise<void> {
    let lastFailure = false;
    for (let attempt = 0; attempt < this.limits.writeAttempts; attempt += 1) {
      try {
        await this.ensureDirectory();
        return;
      } catch {
        lastFailure = true;
      }
    }
    if (lastFailure) {
      throw new AgentIncidentStoreError("persistence_unavailable", "The local incident directory is unavailable.");
    }
  }

  private async ensureDirectory(): Promise<void> {
    const components = AGENT_INCIDENT_STORE_PATH.split("/");
    let current = "";
    for (const component of components) {
      current = current ? `${current}/${component}` : component;
      if (await this.adapter.exists(current)) continue;
      try {
        await this.adapter.mkdir(current);
      } catch {
        if (!(await this.adapter.exists(current))) throw new Error("directory-unavailable");
      }
    }
  }

  private async persistWithRetry(path: string, serialized: string, reportId: string): Promise<boolean> {
    let lastFailure = false;
    for (let attempt = 0; attempt < this.limits.writeAttempts; attempt += 1) {
      const tempPath = `${path}.tmp`;
      try {
        const existing = await this.readCandidate(path, reportId, true);
        if (existing.kind === "valid") {
          if (existing.entry.serialized !== serialized) {
            throw new AgentIncidentStoreError("duplicate_report_id", "A different incident report already uses this report ID.");
          }
          await this.removeIfPresent(tempPath);
          return false;
        }
        if (existing.kind === "unavailable") throw new Error("read-unavailable");
        if (existing.kind === "corrupt" && await this.safeExists(path)) throw new Error("corrupt-not-isolated");
        if (typeof this.adapter.rename !== "function") {
          throw new AgentIncidentStoreError("persistence_unavailable", "Atomic incident report persistence is unavailable.");
        }

        await this.removeIfPresent(tempPath);
        await this.adapter.write(tempPath, serialized);
        if (await this.adapter.read(tempPath) !== serialized) throw new Error("candidate-verification-failed");
        if (await this.adapter.exists(path)) throw new Error("target-created-concurrently");
        await this.adapter.rename(tempPath, path);

        const verified = await this.readCandidate(path, reportId, false);
        if (verified.kind !== "valid" || verified.entry.serialized !== serialized) {
          throw new Error("write-verification-failed");
        }
        await this.removeIfPresent(tempPath);
        return true;
      } catch (error) {
        await this.removeIfPresent(tempPath);
        if (error instanceof AgentIncidentStoreError) throw error;
        lastFailure = true;
      }
    }
    if (lastFailure) {
      throw new AgentIncidentStoreError("persistence_unavailable", "The incident report could not be saved locally.");
    }
    throw new AgentIncidentStoreError("persistence_unavailable", "The incident report could not be saved locally.");
  }

  private async enforceRetentionInternal(protectedReportPath?: string): Promise<AgentIncidentRetentionResult> {
    const nowMs = safeNow(this.now);
    const scan = await this.scanDirectory();
    let reports = scan.reports;
    let artifacts = scan.artifacts;
    let removedReports = 0;
    let removedArtifacts = scan.removedArtifacts;
    let cleanupFailures = scan.cleanupFailures;
    const cutoffMs = nowMs - this.limits.maxAgeMs;

    const removeReports = async (targets: Set<string>): Promise<void> => {
      const retained: ReportEntry[] = [];
      for (const entry of reports) {
        if (!targets.has(entry.path)) {
          retained.push(entry);
          continue;
        }
        if (await this.removePath(entry.path)) removedReports += 1;
        else {
          cleanupFailures += 1;
          retained.push(entry);
        }
      }
      reports = retained;
    };

    const removeArtifacts = async (targets: Set<string>): Promise<void> => {
      const retained: ArtifactEntry[] = [];
      for (const entry of artifacts) {
        if (!targets.has(entry.path)) {
          retained.push(entry);
          continue;
        }
        if (await this.removePath(entry.path)) removedArtifacts += 1;
        else {
          cleanupFailures += 1;
          retained.push(entry);
        }
      }
      artifacts = retained;
    };

    await removeReports(new Set(reports
      .filter((entry) => entry.path !== protectedReportPath && reportRetentionTime(entry, nowMs) < cutoffMs)
      .map((entry) => entry.path)));
    await removeArtifacts(new Set(artifacts.filter((entry) => artifactRetentionTime(entry, nowMs) < cutoffMs).map((entry) => entry.path)));

    reports.sort((left, right) => compareNewestFirst(left, right, nowMs));
    if (reports.length > this.limits.maxReports) {
      const retainedPaths = new Set<string>();
      if (protectedReportPath && reports.some((entry) => entry.path === protectedReportPath)) {
        retainedPaths.add(protectedReportPath);
      }
      for (const entry of reports) {
        if (retainedPaths.size >= this.limits.maxReports) break;
        retainedPaths.add(entry.path);
      }
      await removeReports(new Set(reports
        .filter((entry) => !retainedPaths.has(entry.path))
        .map((entry) => entry.path)));
    }

    let totalBytes = sumDiskBytes(reports) + sumDiskBytes(artifacts);
    if (totalBytes > this.limits.maxTotalBytes && artifacts.length > 0) {
      const oldestArtifacts = [...artifacts].sort((left, right) => compareArtifactsOldestFirst(left, right, nowMs));
      const targets = new Set<string>();
      for (const artifact of oldestArtifacts) {
        if (totalBytes <= this.limits.maxTotalBytes) break;
        targets.add(artifact.path);
        totalBytes -= artifact.diskBytes;
      }
      await removeArtifacts(targets);
    }

    totalBytes = sumDiskBytes(reports) + sumDiskBytes(artifacts);
    if (totalBytes > this.limits.maxTotalBytes && reports.length > 0) {
      const oldestReports = [...reports].sort((left, right) => compareOldestFirst(left, right, nowMs));
      const targets = new Set<string>();
      for (const report of oldestReports) {
        if (totalBytes <= this.limits.maxTotalBytes) break;
        if (report.path === protectedReportPath) continue;
        targets.add(report.path);
        totalBytes -= report.diskBytes;
      }
      await removeReports(targets);
    }

    reports.sort((left, right) => compareNewestFirst(left, right, nowMs));
    const retainedBytes = sumDiskBytes(reports) + sumDiskBytes(artifacts);
    const limitsSatisfied = !scan.scanFailed
      && cleanupFailures === 0
      && reports.length <= this.limits.maxReports
      && retainedBytes <= this.limits.maxTotalBytes
      && reports.every((entry) => reportRetentionTime(entry, nowMs) >= cutoffMs)
      && artifacts.every((entry) => artifactRetentionTime(entry, nowMs) >= cutoffMs);

    return Object.freeze({
      scanComplete: !scan.scanFailed,
      inspectedCandidates: scan.inspectedCandidates,
      inspectedBytes: scan.inspectedBytes,
      skippedCandidates: scan.skippedCandidates,
      scannedReports: scan.reports.length,
      retainedReports: reports.length,
      retainedBytes,
      removedReports,
      removedArtifacts,
      corruptReports: scan.corruptReports,
      cleanupFailures,
      limitsSatisfied,
    });
  }

  private async scanDirectory(): Promise<ScanResult> {
    let listed: ListedFiles;
    try {
      listed = await this.adapter.list(AGENT_INCIDENT_STORE_PATH);
    } catch {
      return {
        reports: [],
        artifacts: [],
        corruptReports: 0,
        cleanupFailures: 1,
        removedArtifacts: 0,
        scanFailed: true,
        inspectedCandidates: 0,
        inspectedBytes: 0,
        skippedCandidates: 0,
      };
    }

    const reports: ReportEntry[] = [];
    const artifacts: ArtifactEntry[] = [];
    let corruptReports = 0;
    let cleanupFailures = 0;
    let removedArtifacts = 0;
    let inspectedCandidates = 0;
    let inspectedBytes = 0;
    const prefix = `${AGENT_INCIDENT_STORE_PATH}/`;
    let scanFailed = !Array.isArray(listed.files);
    const paths: string[] = [];
    if (Array.isArray(listed.files)) {
      const inspectedEntryCount = Math.min(listed.files.length, AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES);
      scanFailed = listed.files.length > AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES;
      for (let index = 0; index < inspectedEntryCount; index += 1) {
        const path = listed.files[index] as unknown;
        if (typeof path === "string") paths.push(path);
        else scanFailed = true;
      }
      paths.sort(compareScanPaths);
    }

    let pathIndex = 0;
    for (; pathIndex < paths.length; pathIndex += 1) {
      if (inspectedCandidates >= this.limits.maxScanCandidates) {
        scanFailed = true;
        break;
      }
      if (inspectedCandidates > 0 && inspectedCandidates % AGENT_INCIDENT_SCAN_BATCH_SIZE === 0) {
        try {
          await this.yieldToHost();
        } catch {
          scanFailed = true;
          break;
        }
      }
      const path = paths[pathIndex];
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      inspectedCandidates += 1;
      const fileName = path.slice(prefix.length);
      if (TEMP_FILE_PATTERN.test(fileName)) {
        if (await this.removePath(path)) removedArtifacts += 1;
        else {
          cleanupFailures += 1;
          artifacts.push(await this.artifactEntry(path));
        }
        continue;
      }

      if (!fileName.endsWith(".json")) {
        if (!CORRUPT_REPORT_FILE_PATTERN.test(fileName)) {
          artifacts.push(await this.artifactEntry(path));
          continue;
        }
        const stat = await this.safeStat(path);
        if (!stat || stat.type !== "file") {
          cleanupFailures += 1;
          scanFailed = true;
          continue;
        }
        const candidateBytes = boundedFileSize(stat.size, this.limits.maxReportBytes + 1);
        if (candidateBytes > this.limits.maxScanBytes - inspectedBytes) {
          scanFailed = true;
          break;
        }
        inspectedBytes += candidateBytes;
        artifacts.push(artifactFromStat(
          path,
          stat,
          this.limits.maxTotalBytes,
          await this.readArtifactReportTimestamp(path, stat),
        ));
        continue;
      }

      const reportId = fileName.slice(0, -5);
      if (!REPORT_ID_PATTERN.test(reportId)) {
        const stat = await this.safeStat(path);
        if (!stat || stat.type !== "file") {
          cleanupFailures += 1;
          scanFailed = true;
          continue;
        }
        const candidateBytes = boundedFileSize(stat.size, this.limits.maxReportBytes + 1);
        if (candidateBytes > this.limits.maxScanBytes - inspectedBytes) {
          scanFailed = true;
          break;
        }
        inspectedBytes += candidateBytes;
        corruptReports += 1;
        const artifact = await this.isolateCorrupt(path, stat, await this.readArtifactReportTimestamp(path, stat));
        if (artifact) artifacts.push(artifact);
        else if (await this.safeExists(path)) cleanupFailures += 1;
        continue;
      }

      const stat = await this.safeStat(path);
      if (!stat || stat.type !== "file") {
        cleanupFailures += 1;
        scanFailed = true;
        continue;
      }
      const candidateBytes = boundedFileSize(stat.size, this.limits.maxReportBytes + 1);
      if (candidateBytes > this.limits.maxScanBytes - inspectedBytes) {
        scanFailed = true;
        break;
      }
      inspectedBytes += candidateBytes;

      const candidate = await this.readCandidate(path, reportId, true, stat);
      if (candidate.kind === "valid") reports.push(candidate.entry);
      else if (candidate.kind === "corrupt") {
        corruptReports += 1;
        if (candidate.artifact) artifacts.push(candidate.artifact);
        else if (await this.safeExists(path)) cleanupFailures += 1;
      } else if (candidate.kind === "unavailable") {
        cleanupFailures += 1;
        scanFailed = true;
      }
    }

    const skippedCandidates = Math.max(0, paths.length - pathIndex);
    return {
      reports,
      artifacts,
      corruptReports,
      cleanupFailures,
      removedArtifacts,
      scanFailed,
      inspectedCandidates,
      inspectedBytes,
      skippedCandidates,
    };
  }

  private async readCandidate(path: string, expectedReportId: string, isolate: boolean, knownStat?: Stat): Promise<CandidateRead> {
    let exists: boolean;
    try {
      exists = await this.adapter.exists(path);
    } catch {
      return { kind: "unavailable" };
    }
    if (!exists) return { kind: "missing" };

    let stat: Stat | null = knownStat ?? null;
    if (!stat) {
      try {
        stat = await this.adapter.stat(path);
      } catch {
        return { kind: "unavailable" };
      }
    }
    if (!stat || stat.type !== "file") {
      return isolate ? { kind: "corrupt", artifact: await this.isolateCorrupt(path) } : { kind: "corrupt", artifact: null };
    }
    if (stat.size > this.limits.maxReportBytes) {
      return isolate ? { kind: "corrupt", artifact: await this.isolateCorrupt(path, stat) } : { kind: "corrupt", artifact: null };
    }

    let raw: string;
    try {
      raw = await this.adapter.read(path);
    } catch {
      return { kind: "unavailable" };
    }
    if (utf8ByteLength(raw) > this.limits.maxReportBytes) {
      return isolate ? { kind: "corrupt", artifact: await this.isolateCorrupt(path, stat) } : { kind: "corrupt", artifact: null };
    }

    try {
      const parsed = this.parseSerialized(raw);
      if (parsed.serialized !== raw) throw new Error("noncanonical-report");
      if (parsed.report.report_id !== expectedReportId) throw new Error("identity-mismatch");
      return {
        kind: "valid",
        entry: {
          ...parsed,
          path,
          reportId: parsed.report.report_id,
          incidentId: parsed.report.incident.incident_id,
          createdAtMs: Date.parse(parsed.report.created_at),
          ctimeMs: finiteTimestamp(stat.ctime),
          mtimeMs: finiteTimestamp(stat.mtime),
          diskBytes: utf8ByteLength(raw),
        },
      };
    } catch {
      return isolate
        ? { kind: "corrupt", artifact: await this.isolateCorrupt(path, stat, parseArtifactReportTimestamp(raw)) }
        : { kind: "corrupt", artifact: null };
    }
  }

  private parseSerialized<TReport extends AgentIncidentStoreReport = AgentIncidentStoreReport>(
    serialized: string,
  ): StoredAgentIncidentReport<TReport> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new AgentIncidentStoreError("invalid_report", "The incident report is not valid JSON.");
    }
    const canonical = this.serializeUnknown(parsed);
    const projected = canonicalProject(parsed, this.limits.maxReportBytes);
    const report = deepFreeze(projected) as unknown as TReport;
    return Object.freeze({ report, serialized: canonical, sizeBytes: utf8ByteLength(canonical) });
  }

  private serializeUnknown(value: unknown): string {
    let projected: CanonicalJson;
    try {
      projected = canonicalProject(value, this.limits.maxReportBytes);
      validateEnvelope(projected);
    } catch (error) {
      if (error instanceof AgentIncidentStoreError) throw error;
      throw new AgentIncidentStoreError("invalid_report", "The incident report does not match the local persistence envelope.");
    }
    const serialized = canonicalJsonStringify(projected);
    const sizeBytes = utf8ByteLength(serialized);
    if (sizeBytes > this.limits.maxReportBytes) {
      throw new AgentIncidentStoreError("report_too_large", "The incident report exceeds the local size limit.");
    }
    const captureQuality = (projected as CanonicalObject).capture_quality;
    if (!isCanonicalObject(captureQuality) || captureQuality.report_bytes !== sizeBytes) invalidReport();
    return serialized;
  }

  private async isolateCorrupt(path: string, knownStat?: Stat, reportCreatedAtMs?: number): Promise<ArtifactEntry | null> {
    const stat = knownStat ?? await this.safeStat(path);
    if (typeof this.adapter.rename !== "function") {
      await this.removePath(path);
      return null;
    }

    for (let suffix = 0; suffix < 5; suffix += 1) {
      const corruptPath = suffix === 0 ? `${path}.corrupt` : `${path}.corrupt-${String(suffix)}`;
      try {
        if (await this.adapter.exists(corruptPath)) continue;
        await this.adapter.rename(path, corruptPath);
        return artifactFromStat(corruptPath, stat, this.limits.maxTotalBytes, reportCreatedAtMs);
      } catch {
        // Try a bounded alternate name before leaving the source isolated in place.
      }
    }
    await this.removePath(path);
    return null;
  }

  private async artifactEntry(path: string): Promise<ArtifactEntry> {
    return artifactFromStat(path, await this.safeStat(path), this.limits.maxTotalBytes);
  }

  private async readArtifactReportTimestamp(path: string, stat: Stat): Promise<number | undefined> {
    if (stat.size > this.limits.maxReportBytes) return undefined;
    try {
      const raw = await this.adapter.read(path);
      if (utf8ByteLength(raw) > this.limits.maxReportBytes) return undefined;
      return parseArtifactReportTimestamp(raw);
    } catch {
      return undefined;
    }
  }

  private async safeStat(path: string): Promise<Stat | null> {
    try {
      return await this.adapter.stat(path);
    } catch {
      return null;
    }
  }

  private async safeExists(path: string): Promise<boolean> {
    try {
      return await this.adapter.exists(path);
    } catch {
      return true;
    }
  }

  private async removeIfPresent(path: string): Promise<void> {
    try {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    } catch {
      // A later persistence attempt verifies every candidate and final file.
    }
  }

  private async removePath(path: string): Promise<boolean> {
    try {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
      return true;
    } catch {
      return false;
    }
  }

  private reportPath(reportId: string): string {
    validateReportId(reportId);
    return `${AGENT_INCIDENT_STORE_PATH}/${reportId}.json`;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.coordination.tail;
    let release: (() => void) | undefined;
    this.coordination.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function validateEnvelope(value: CanonicalJson): asserts value is AgentIncidentStoreReport & CanonicalJson {
  const root = exactObject(value, [
    "schema_version",
    "report_id",
    "created_at",
    "incident",
    "correlation",
    "grouping",
    "environment",
    "run_summary",
    "tools",
    "timeline",
    "transport_segments",
    "resource_samples",
    "capture_quality",
    "privacy",
  ], ["run_state", "rendering"]);
  if (root.schema_version !== AGENT_INCIDENT_SCHEMA_VERSION) invalidReport();
  if (typeof root.report_id !== "string") invalidReport();
  validateReportId(root.report_id);
  if (!isCanonicalIsoTimestamp(root.created_at)) invalidReport();

  const incident = validateIncident(root.incident);
  const correlation = validateCorrelation(root.correlation);
  const grouping = validateGrouping(root.grouping);
  const environment = validateEnvironment(root.environment);
  const runSummary = validateRunSummary(root.run_summary);
  if (
    incident.terminal_evidence
      !== deriveAgentIncidentTerminalEvidence(
        incident.failure_authority as AgentIncidentFailureAuthority,
        runSummary.terminal_validation as AgentIncidentTerminalValidation,
      )
  ) invalidReport();
  const tools = canonicalArray(root.tools);
  const timeline = canonicalArray(root.timeline);
  const transportSegments = canonicalArray(root.transport_segments);
  const resources = canonicalArray(root.resource_samples);
  const runState = root.run_state === undefined
    ? undefined
    : validateRunState(root.run_state);
  validateGroupingConsistency(grouping, incident, runState);
  validateTerminalProvenance(incident, runSummary, runState);
  validateTools(tools, runSummary.observed_lifecycle_event_count);
  const terminal = validateTimeline(timeline, incident, runSummary);
  validateTransportSegments(transportSegments);
  validateCorrelationTimelineConsistency(
    correlation,
    timeline,
    transportSegments,
  );
  if (root.rendering !== undefined) validateRendering(root.rendering);
  validateResourceSamples(resources);
  validateCaptureQuality(
    root.capture_quality,
    incident,
    correlation,
    environment,
    runSummary,
    root.run_state,
    root.rendering,
    terminal,
    timeline,
    timeline.length,
    resources.length,
    transportSegments,
    transportSegments.length,
  );
  validatePrivacy(root.privacy);
}

function validateIncident(value: CanonicalJson): CanonicalObject {
  const incident = exactObject(
    value,
    [
      "classification",
      "impact",
      "outcome",
      "severity_text",
      "severity_number",
      "failure_authority",
      "origin",
      "terminal_evidence",
      "artifact_integrity",
      "evidence_scope",
      "causal_assessment",
      "observation_source",
      "failure_stage",
      "failure_mechanism",
    ],
    ["incident_id", "failure_code", "retryable", "http_status"],
  );
  if (incident.classification !== "operation_failure" || incident.impact !== "run_failed" || incident.outcome !== "failed") invalidReport();
  if (incident.severity_text !== "ERROR" || incident.severity_number !== 17) invalidReport();
  if (incident.failure_authority !== "server" && incident.failure_authority !== "client" && incident.failure_authority !== "unknown") invalidReport();
  if (incident.origin !== "agent_terminal" && incident.origin !== "agent_local_failure") invalidReport();
  if (
    incident.terminal_evidence !== "server_protocol_validated"
    && incident.terminal_evidence !== "client_observed"
    && incident.terminal_evidence !== "unvalidated"
  ) invalidReport();
  if (incident.artifact_integrity !== "unauthenticated_client_record") invalidReport();
  if (incident.evidence_scope !== "client_observation_only") invalidReport();
  if (incident.causal_assessment !== "not_established") invalidReport();
  if (
    incident.observation_source !== "server_protocol_terminal"
    && incident.observation_source !== "server_http_response"
    && incident.observation_source !== "client_runtime"
  ) invalidReport();
  if (
    incident.failure_stage !== "not_recorded"
    && !isAgentIncidentFailureStage(incident.failure_stage)
  ) invalidReport();
  if (
    incident.failure_mechanism !== "not_recorded"
    && !isAgentIncidentFailureMechanism(incident.failure_mechanism)
  ) invalidReport();
  if (
    (incident.failure_authority === "client")
      !== (incident.origin === "agent_local_failure")
  ) invalidReport();
  if (
    incident.terminal_evidence === "server_protocol_validated"
    && (incident.failure_authority !== "server" || incident.origin !== "agent_terminal")
  ) invalidReport();
  if (
    incident.terminal_evidence === "client_observed"
    && (incident.failure_authority !== "client" || incident.origin !== "agent_local_failure")
  ) invalidReport();
  if (incident.incident_id !== undefined) {
    if (typeof incident.incident_id !== "string") invalidReport();
    validateIncidentId(incident.incident_id);
  }
  if (
    incident.failure_code !== undefined
    && !isAgentIncidentExportedFailureCode(incident.failure_code)
  ) invalidReport();
  if (incident.retryable !== undefined && typeof incident.retryable !== "boolean") invalidReport();
  if (incident.http_status !== undefined && !isHttpStatus(incident.http_status)) invalidReport();
  const expectedObservationSource = incident.failure_authority === "server"
    ? "server_protocol_terminal"
    : incident.failure_mechanism === "http_rejection" && incident.http_status !== undefined
      ? "server_http_response"
      : "client_runtime";
  if (incident.observation_source !== expectedObservationSource) invalidReport();
  return incident;
}

function validateCorrelation(value: CanonicalJson): CanonicalObject {
  const correlation = exactObject(
    value,
    [],
    ["run_id", "server_run_id", "server_latency_correlation_id"],
  );
  validateOptionalPattern(correlation.run_id, RUN_ID_PATTERN);
  validateOptionalPattern(correlation.server_run_id, RUN_ID_PATTERN);
  validateOptionalPattern(
    correlation.server_latency_correlation_id,
    SERVER_LATENCY_CORRELATION_ID_PATTERN,
  );
  return correlation;
}

function validateGrouping(value: CanonicalJson): CanonicalObject {
  const grouping = exactObject(value, ["strategy", "fingerprint"]);
  if (grouping.strategy !== AGENT_INCIDENT_GROUPING_STRATEGY) invalidReport();
  if (typeof grouping.fingerprint !== "string") invalidReport();
  return grouping;
}

function validateGroupingConsistency(
  grouping: CanonicalObject,
  incident: CanonicalObject,
  runState: CanonicalObject | undefined,
): void {
  const expected = buildAgentIncidentGroupingFingerprint({
    failureAuthority: incident.failure_authority as AgentIncidentFailureAuthority,
    ...(incident.failure_stage === "not_recorded"
      ? {}
      : { failureStage: incident.failure_stage as AgentIncidentFailureStage }),
    ...(incident.failure_mechanism === "not_recorded"
      ? {}
      : { failureMechanism: incident.failure_mechanism as AgentIncidentFailureMechanism }),
    ...(incident.failure_code === undefined
      ? {}
      : { failureCode: incident.failure_code as AgentIncidentExportedFailureCode }),
    ...(incident.http_status === undefined
      ? {}
      : { httpStatus: incident.http_status as number }),
    ...(runState?.terminal_source === undefined
      ? {}
      : { terminalSource: runState.terminal_source as Exclude<AgentIncidentTerminalSource, "not_recorded"> }),
  });
  if (grouping.fingerprint !== expected) invalidReport();
}

function validateEnvironment(value: CanonicalJson): CanonicalObject {
  const environment = exactObject(
    value,
    [],
    ["plugin_version", "plugin_build_id", "loaded_bundle_sha256", "obsidian_version", "host_type", "os_family"],
  );
  validateOptionalVersion(environment.plugin_version);
  validateOptionalPattern(environment.plugin_build_id, PLUGIN_BUILD_ID_PATTERN);
  validateOptionalPattern(environment.loaded_bundle_sha256, SHA_256_PATTERN);
  validateOptionalVersion(environment.obsidian_version);
  validateOptionalEnum(environment.host_type, ["desktop", "mobile", "unknown"]);
  validateOptionalEnum(environment.os_family, ["macos", "windows", "linux", "ios", "android", "unknown"]);
  return environment;
}

function validateRunSummary(value: CanonicalJson): CanonicalObject {
  const summary = exactObject(
    value,
    [
      "failed_at",
      "terminal_receipt",
      "terminal_validation",
      "host_process_state",
      "chat_view_state",
      "observed_lifecycle_event_count",
      "retained_timeline_event_count",
      "partial_output",
      "lifecycle_code_counts",
      "lifecycle_phase_counts",
    ],
    ["started_at", "duration_ms", "duration_clock_domain", "snapshot_part_count"],
  );
  if (!isCanonicalIsoTimestamp(summary.failed_at)) invalidReport();
  if (summary.started_at !== undefined && !isCanonicalIsoTimestamp(summary.started_at)) invalidReport();
  if (summary.duration_ms !== undefined && !isBoundedMetric(summary.duration_ms, MAX_TIMING_MS)) invalidReport();
  if ((summary.duration_ms === undefined) !== (summary.duration_clock_domain === undefined)) invalidReport();
  if (summary.duration_clock_domain !== undefined && !isOneOf(summary.duration_clock_domain, ["client_turn_monotonic", "client_wall_clock_observed"])) invalidReport();
  if (!isOneOf(summary.terminal_receipt, [
    "client_received_server_terminal",
    "client_emitted_local_failure",
    "unknown",
  ])) invalidReport();
  if (!isOneOf(summary.terminal_validation, ["validated", "unvalidated", "validation_failed", "not_recorded"])) invalidReport();
  if (!isOneOf(summary.host_process_state, ["responsive", "unknown"])) invalidReport();
  if (!isOneOf(summary.chat_view_state, ["mounted", "detached", "unknown"])) invalidReport();
  if (!isBoundedCount(summary.observed_lifecycle_event_count) || !isBoundedCount(summary.retained_timeline_event_count)) invalidReport();
  if (summary.retained_timeline_event_count > summary.observed_lifecycle_event_count) invalidReport();
  if (summary.snapshot_part_count !== undefined && !isBoundedCount(summary.snapshot_part_count)) invalidReport();

  const partial = exactObject(summary.partial_output, [], [
    "assistant_text_part_count",
    "assistant_text_streaming_part_count",
    "assistant_text_complete_part_count",
    "assistant_text_character_count",
    "reasoning_part_count",
    "reasoning_streaming_part_count",
    "reasoning_complete_part_count",
    "reasoning_character_count",
    "assistant_output_present_before_failure",
    "assistant_output_retained_in_failed_projection",
  ]);
  for (const field of [
    partial.assistant_text_part_count,
    partial.assistant_text_streaming_part_count,
    partial.assistant_text_complete_part_count,
    partial.assistant_text_character_count,
    partial.reasoning_part_count,
    partial.reasoning_streaming_part_count,
    partial.reasoning_complete_part_count,
    partial.reasoning_character_count,
  ]) {
    if (field !== undefined && !isBoundedCount(field)) invalidReport();
  }
  for (const field of [
    partial.assistant_output_present_before_failure,
    partial.assistant_output_retained_in_failed_projection,
  ]) {
    if (field !== undefined && typeof field !== "boolean") invalidReport();
  }
  if (
    partial.assistant_output_retained_in_failed_projection === true
    && partial.assistant_output_present_before_failure !== true
  ) invalidReport();
  if (
    typeof partial.assistant_text_part_count === "number"
    && typeof partial.assistant_text_streaming_part_count === "number"
    && typeof partial.assistant_text_complete_part_count === "number"
    && partial.assistant_text_streaming_part_count
      + partial.assistant_text_complete_part_count
      !== partial.assistant_text_part_count
  ) invalidReport();
  if (
    typeof partial.reasoning_part_count === "number"
    && typeof partial.reasoning_streaming_part_count === "number"
    && typeof partial.reasoning_complete_part_count === "number"
    && partial.reasoning_streaming_part_count
      + partial.reasoning_complete_part_count
      !== partial.reasoning_part_count
  ) invalidReport();
  if (
    partial.assistant_output_present_before_failure === false
    && typeof partial.assistant_text_character_count === "number"
    && partial.assistant_text_character_count > 0
  ) invalidReport();
  if (
    partial.assistant_output_present_before_failure === true
    && partial.assistant_text_character_count === 0
  ) invalidReport();
  validateLifecycleCodeCounts(summary.lifecycle_code_counts);
  validateLifecyclePhaseCounts(summary.lifecycle_phase_counts);

  if (summary.started_at !== undefined && summary.duration_ms !== undefined && summary.duration_clock_domain === "client_wall_clock_observed") {
    const elapsed = Date.parse(summary.failed_at as string) - Date.parse(summary.started_at as string);
    if (elapsed !== summary.duration_ms) invalidReport();
  }
  return summary;
}

function validateLifecycleCodeCounts(value: CanonicalJson): void {
  const counts = canonicalArray(value);
  const seen = new Set<string>();
  for (const entryValue of counts) {
    const entry = exactObject(entryValue, ["code", "count"]);
    if (!isAgentLifecycleCode(entry.code) || !isPositiveBoundedCount(entry.count) || seen.has(entry.code)) invalidReport();
    seen.add(entry.code);
  }
}

function validateLifecyclePhaseCounts(value: CanonicalJson): void {
  const counts = canonicalArray(value);
  const seen = new Set<string>();
  for (const entryValue of counts) {
    const entry = exactObject(entryValue, ["phase", "count"]);
    if (!isAgentLifecyclePhase(entry.phase) || !isPositiveBoundedCount(entry.count) || seen.has(entry.phase)) invalidReport();
    seen.add(entry.phase);
  }
}

function validateTools(values: CanonicalJson[], observedEventCount: CanonicalJson): void {
  if (values.length > MAX_TOOLS || typeof observedEventCount !== "number") invalidReport();
  let previousOrdinal = 0;
  for (const value of values) {
    const tool = exactObject(
      value,
      [
        "ordinal",
        "result_delivery",
        "result_acknowledgement",
        "terminal_dom_committed",
        "terminal_paint_opportunity_observed",
        "lifecycle_event_count",
      ],
      [
        "tool_name",
        "started_at",
        "completed_at",
        "outcome",
        "failure_class",
        "requested_item_count",
        "completed_item_count",
        "failed_item_count",
      ],
    );
    if (!isPositiveIntegerAtMost(tool.ordinal, MAX_TOOL_ORDINAL) || tool.ordinal <= previousOrdinal) invalidReport();
    previousOrdinal = tool.ordinal;
    if (tool.tool_name !== undefined && !isFirstPartyToolName(tool.tool_name)) invalidReport();
    if (tool.started_at !== undefined && !isCanonicalIsoTimestamp(tool.started_at)) invalidReport();
    if (tool.completed_at !== undefined && !isCanonicalIsoTimestamp(tool.completed_at)) invalidReport();
    if (tool.outcome !== undefined && !isToolDiagnosticOutcome(tool.outcome)) invalidReport();
    if (tool.failure_class !== undefined && !isToolDiagnosticFailureClass(tool.failure_class)) invalidReport();
    validateOptionalEnum(tool.result_delivery, ["succeeded", "failed", "not_observed"], false);
    validateOptionalEnum(tool.result_acknowledgement, ["succeeded", "failed", "not_observed"], false);
    if (
      typeof tool.terminal_dom_committed !== "boolean"
      || typeof tool.terminal_paint_opportunity_observed !== "boolean"
    ) invalidReport();
    if (!isPositiveBoundedCount(tool.lifecycle_event_count) || tool.lifecycle_event_count > observedEventCount) invalidReport();
    validateOptionalToolItemCount(tool.requested_item_count);
    validateOptionalToolItemCount(tool.completed_item_count);
    validateOptionalToolItemCount(tool.failed_item_count);
    if (typeof tool.requested_item_count === "number") {
      const completed = typeof tool.completed_item_count === "number" ? tool.completed_item_count : 0;
      const failed = typeof tool.failed_item_count === "number" ? tool.failed_item_count : 0;
      if (completed + failed > tool.requested_item_count) invalidReport();
    }
  }
}

function validateTimeline(values: CanonicalJson[], incident: CanonicalObject, summary: CanonicalObject): CanonicalObject {
  if (values.length === 0 || values.length > MAX_TIMELINE_EVENTS) invalidReport();
  let previousOrdinal = 0;
  let terminal: CanonicalObject | null = null;
  for (const value of values) {
    const event = exactObject(
      value,
      ["ordinal", "timestamp", "code", "phase"],
      [
        "source_sequence",
        "run_id",
        "server_run_id",
        "status",
        "retryable",
        "incident_id",
        "failure_code",
        "server_latency_correlation_id",
        "command_kind",
        "command_segment_ordinal",
        "tool_execution_ordinal",
        "tool_name",
        "tool_outcome",
        "tool_failure_class",
        "tool_item_count",
        "tool_completed_item_count",
        "tool_failed_item_count",
        "history_sync_kind",
        "history_sync_ordinal",
        "response_delivery_mode",
        "client_monotonic_offset_ms",
        "client_clock_domain",
        "server_timing_app_ms",
        "server_timing_auth_ms",
        "server_timing_clock_domain",
        "credits_refresh_reason",
        "credits_refresh_sequence",
        "credits_refresh_transport",
        "credits_refresh_elapsed_ms",
        "credits_refresh_clock_domain",
        "credits_refresh_server_auth_ms",
        "credits_refresh_server_rate_limit_ms",
        "credits_refresh_server_balance_store_ms",
        "credits_refresh_server_total_ms",
        "credits_refresh_server_timing_clock_domain",
      ],
    );
    if (!isPositiveBoundedCount(event.ordinal) || event.ordinal <= previousOrdinal) invalidReport();
    previousOrdinal = event.ordinal;
    if (!isCanonicalIsoTimestamp(event.timestamp) || !isAgentLifecycleCode(event.code) || !isAgentLifecyclePhase(event.phase)) invalidReport();
    if (event.source_sequence !== undefined && !isPositiveSafeInteger(event.source_sequence)) invalidReport();
    validateOptionalPattern(event.run_id, RUN_ID_PATTERN);
    validateOptionalPattern(event.server_run_id, RUN_ID_PATTERN);
    if (event.status !== undefined && !isHttpStatus(event.status)) invalidReport();
    if (event.retryable !== undefined && typeof event.retryable !== "boolean") invalidReport();
    if (event.incident_id !== undefined && (typeof event.incident_id !== "string" || !INCIDENT_ID_PATTERN.test(event.incident_id) || isZeroPrefixedId(event.incident_id))) invalidReport();
    if (
      event.failure_code !== undefined
      && !isAgentIncidentExportedFailureCode(event.failure_code)
    ) invalidReport();
    validateOptionalPattern(
      event.server_latency_correlation_id,
      SERVER_LATENCY_CORRELATION_ID_PATTERN,
    );
    if (event.command_kind !== undefined && !isThinAgentCommandKind(event.command_kind)) invalidReport();
    validateOptionalPositiveInteger(event.command_segment_ordinal);
    if (event.tool_execution_ordinal !== undefined && !isPositiveIntegerAtMost(event.tool_execution_ordinal, MAX_TOOL_ORDINAL)) invalidReport();
    if (event.tool_name !== undefined && !isFirstPartyToolName(event.tool_name)) invalidReport();
    if (event.tool_outcome !== undefined && !isToolDiagnosticOutcome(event.tool_outcome)) invalidReport();
    if (event.tool_failure_class !== undefined && !isToolDiagnosticFailureClass(event.tool_failure_class)) invalidReport();
    validateOptionalToolItemCount(event.tool_item_count);
    validateOptionalToolItemCount(event.tool_completed_item_count);
    validateOptionalToolItemCount(event.tool_failed_item_count);
    if (event.history_sync_kind !== undefined && !isHistorySyncKind(event.history_sync_kind)) invalidReport();
    validateOptionalPositiveInteger(event.history_sync_ordinal);
    validateOptionalEnum(event.response_delivery_mode, ["fetch_stream", "request_url_buffered"]);
    validateOptionalTiming(event.client_monotonic_offset_ms);
    validateOptionalEnum(event.client_clock_domain, ["client_turn_monotonic"]);
    validateOptionalTiming(event.server_timing_app_ms);
    validateOptionalTiming(event.server_timing_auth_ms);
    validateOptionalEnum(event.server_timing_clock_domain, ["server_response_headers_monotonic_duration"]);
    if (event.credits_refresh_reason !== undefined && !isCreditsRefreshReason(event.credits_refresh_reason)) invalidReport();
    validateOptionalPositiveInteger(event.credits_refresh_sequence);
    validateOptionalEnum(event.credits_refresh_transport, ["fetch", "request_url"]);
    validateOptionalTiming(event.credits_refresh_elapsed_ms);
    validateOptionalEnum(event.credits_refresh_clock_domain, ["client_refresh_monotonic_duration"]);
    validateOptionalTiming(event.credits_refresh_server_auth_ms);
    validateOptionalTiming(event.credits_refresh_server_rate_limit_ms);
    validateOptionalTiming(event.credits_refresh_server_balance_store_ms);
    validateOptionalTiming(event.credits_refresh_server_total_ms);
    validateOptionalEnum(event.credits_refresh_server_timing_clock_domain, ["server_response_headers_monotonic_duration"]);
    terminal = event;
  }

  if (!terminal || terminal.code !== "run_finished_failed" || terminal.timestamp !== summary.failed_at) invalidReport();
  if (!sameOptionalValue(terminal.incident_id, incident.incident_id)) invalidReport();
  if (!sameOptionalValue(terminal.failure_code, incident.failure_code)) invalidReport();
  if (!sameOptionalValue(terminal.retryable, incident.retryable)) invalidReport();
  if (!sameOptionalValue(terminal.status, incident.http_status)) invalidReport();
  if (summary.retained_timeline_event_count !== values.length) invalidReport();
  return terminal;
}

function validateCorrelationTimelineConsistency(
  correlation: CanonicalObject,
  timeline: CanonicalJson[],
  transportSegments: CanonicalJson[],
): void {
  for (const field of ["run_id", "server_run_id"] as const) {
    const stableValue = correlation[field];
    let observedValue: CanonicalJson | undefined;
    for (const value of timeline) {
      if (!isCanonicalObject(value) || value[field] === undefined) continue;
      if (observedValue !== undefined && value[field] !== observedValue) invalidReport();
      observedValue = value[field];
    }
    if (stableValue !== undefined && observedValue !== undefined && stableValue !== observedValue) invalidReport();
  }

  const segmentCorrelations = new Map<number, CanonicalJson>();
  for (const value of timeline) {
    if (
      !isCanonicalObject(value)
      || value.server_latency_correlation_id === undefined
    ) continue;
    const segmentOrdinal = typeof value.command_segment_ordinal === "number"
      ? value.command_segment_ordinal
      : 0;
    const previous = segmentCorrelations.get(segmentOrdinal);
    if (
      previous !== undefined
      && previous !== value.server_latency_correlation_id
    ) invalidReport();
    segmentCorrelations.set(
      segmentOrdinal,
      value.server_latency_correlation_id,
    );
  }
  for (const value of transportSegments) {
    if (
      !isCanonicalObject(value)
      || value.server_latency_correlation_id === undefined
      || typeof value.segment_ordinal !== "number"
    ) continue;
    const previous = segmentCorrelations.get(value.segment_ordinal);
    if (
      previous !== undefined
      && previous !== value.server_latency_correlation_id
    ) invalidReport();
    segmentCorrelations.set(
      value.segment_ordinal,
      value.server_latency_correlation_id,
    );
  }

  const terminalTransport = terminalTransportReference(timeline);
  const expectedTerminalCorrelation = terminalTransport
    ? segmentCorrelations.get(terminalTransport.segmentOrdinal)
    : new Set(segmentCorrelations.values()).size === 1
      ? segmentCorrelations.values().next().value
      : undefined;
  if (
    correlation.server_latency_correlation_id !== undefined
    && correlation.server_latency_correlation_id !== expectedTerminalCorrelation
  ) invalidReport();
}

function validateRunState(value: CanonicalJson): CanonicalObject {
  const state = exactObject(value, [
    "terminal_source",
    "run_origin",
    "run_phase",
    "connection_state",
    "executing_local_tool_count",
    "pending_tool_delivery_count",
    "pending_approval_delivery_count",
    "pending_tool_task_count",
    "server_queued",
    "run_stalled",
    "awaiting_client_work",
    "pending_cancel",
    "pending_regenerate",
    "counts_truncated",
    "elapsed_ms_truncated",
  ]);
  if (!isOneOf(state.terminal_source, ["session_terminal", "message_reconstruction", "local_failure"])) invalidReport();
  if (!isOneOf(state.run_origin, ["submitted", "recovered"])) invalidReport();
  if (!isOneOf(state.run_phase, ["submitted", "thinking", "working", "waiting", "retrying", "settling", "complete"])) invalidReport();
  if (!isOneOf(state.connection_state, ["idle", "connecting", "open", "closed"])) invalidReport();
  for (const count of [
    state.executing_local_tool_count,
    state.pending_tool_delivery_count,
    state.pending_approval_delivery_count,
    state.pending_tool_task_count,
  ]) {
    if (!isBoundedCount(count)) invalidReport();
  }
  for (const flag of [
    state.server_queued,
    state.run_stalled,
    state.awaiting_client_work,
    state.pending_cancel,
    state.pending_regenerate,
    state.counts_truncated,
    state.elapsed_ms_truncated,
  ]) {
    if (typeof flag !== "boolean") invalidReport();
  }
  return state;
}

function validateTerminalProvenance(
  incident: CanonicalObject,
  summary: CanonicalObject,
  runState: CanonicalObject | undefined,
): void {
  const terminalSource = runState?.terminal_source;
  if (terminalSource === "local_failure") {
    if (
      incident.failure_authority !== "client"
      || incident.origin !== "agent_local_failure"
      || summary.terminal_receipt !== "client_emitted_local_failure"
    ) invalidReport();
    return;
  }
  if (terminalSource === "session_terminal" || terminalSource === "message_reconstruction") {
    if (incident.failure_authority === "server") {
      if (
        incident.origin !== "agent_terminal"
        || summary.terminal_receipt !== "client_received_server_terminal"
      ) invalidReport();
      return;
    }
    if (
      incident.failure_authority !== "unknown"
      || incident.origin !== "agent_terminal"
      || summary.terminal_receipt !== "unknown"
    ) invalidReport();
    return;
  }
  if (summary.terminal_receipt !== "unknown") invalidReport();
}

function validateTransportSegments(values: CanonicalJson[]): void {
  if (values.length > MAX_TRANSPORT_SEGMENTS) invalidReport();
  for (const value of values) {
    const segment = exactObject(
      value,
      [
        "command_kind",
        "segment_ordinal",
        "close_reason",
        "duration_ms",
        "received_bytes",
        "raw_chunk_count",
        "sse_event_count",
        "accepted_frame_count",
        "delivered_frame_count",
        "metrics_truncated",
      ],
      ["server_latency_correlation_id", "tool_execution_ordinal"],
    );
    if (!isThinAgentCommandKind(segment.command_kind)) invalidReport();
    if (!isPositiveIntegerAtMost(segment.segment_ordinal, MAX_COUNT)) invalidReport();
    validateOptionalPattern(
      segment.server_latency_correlation_id,
      SERVER_LATENCY_CORRELATION_ID_PATTERN,
    );
    if (segment.tool_execution_ordinal !== undefined && !isPositiveIntegerAtMost(segment.tool_execution_ordinal, MAX_TOOL_ORDINAL)) invalidReport();
    if (!isOneOf(segment.close_reason, AGENT_INCIDENT_TRANSPORT_SEGMENT_CLOSE_REASONS)) invalidReport();
    if (!isBoundedMetric(segment.duration_ms, MAX_TIMING_MS) || !hasAtMostThreeDecimalPlaces(segment.duration_ms)) invalidReport();
    if (!isIntegerMetricAtMost(segment.received_bytes, MAX_TRANSPORT_BYTES)) invalidReport();
    for (const count of [
      segment.raw_chunk_count,
      segment.sse_event_count,
      segment.accepted_frame_count,
      segment.delivered_frame_count,
    ]) {
      if (!isIntegerMetricAtMost(count, MAX_TRANSPORT_OBSERVATION_COUNT)) invalidReport();
    }
    if (typeof segment.metrics_truncated !== "boolean") invalidReport();
  }
}

function validateRendering(value: CanonicalJson): void {
  const evidence = exactObject(value, [
    "failure_surface_dom_committed",
    "failure_surface_paint_opportunity_observed",
  ], ["before_terminal_publish", "after_terminal_commit"]);
  if (
    typeof evidence.failure_surface_dom_committed !== "boolean"
    || typeof evidence.failure_surface_paint_opportunity_observed !== "boolean"
    || (evidence.failure_surface_paint_opportunity_observed
      && !evidence.failure_surface_dom_committed)
  ) invalidReport();
  if (evidence.before_terminal_publish !== undefined) {
    validateRenderingSnapshot(evidence.before_terminal_publish);
  }
  if (evidence.after_terminal_commit !== undefined) {
    validateRenderingSnapshot(evidence.after_terminal_commit);
  }
  if (
    evidence.failure_surface_dom_committed
    && evidence.after_terminal_commit === undefined
  ) invalidReport();
}

function validateRenderingSnapshot(value: CanonicalJson): void {
  const rendering = exactObject(value, [
    "render_state",
    "render_pass_count",
    "pending_render_count",
    "last_render_duration_ms",
    "max_render_duration_ms",
    "first_dom_commit_observed",
    "first_paint_opportunity_observed",
    "registered_row_count",
    "renderer",
    "scroller",
  ]);
  if (!isOneOf(rendering.render_state, ["idle", "frame_pending", "queued", "rendering", "rendering_with_pending"])) invalidReport();
  validateRenderCount(rendering.render_pass_count);
  validateRenderCount(rendering.pending_render_count);
  validateRenderDuration(rendering.last_render_duration_ms);
  validateRenderDuration(rendering.max_render_duration_ms);
  if (typeof rendering.first_dom_commit_observed !== "boolean" || typeof rendering.first_paint_opportunity_observed !== "boolean") invalidReport();
  validateRenderCount(rendering.registered_row_count);

  const renderer = exactObject(rendering.renderer, [
    "render_pass_count",
    "pending_render_pass_count",
    "last_render_duration_ms",
    "max_render_duration_ms",
    "historical_row_count",
    "historical_part_count",
    "active_part_count",
    "disclosure_count",
    "open_disclosure_count",
    "activity_disclosure_count",
    "reasoning_disclosure_count",
    "tool_disclosure_count",
    "overflow_disclosure_count",
    "pending_hydration_count",
    "rendering_enabled",
  ]);
  for (const count of [
    renderer.render_pass_count,
    renderer.pending_render_pass_count,
    renderer.historical_row_count,
    renderer.historical_part_count,
    renderer.active_part_count,
    renderer.disclosure_count,
    renderer.open_disclosure_count,
    renderer.activity_disclosure_count,
    renderer.reasoning_disclosure_count,
    renderer.tool_disclosure_count,
    renderer.overflow_disclosure_count,
    renderer.pending_hydration_count,
  ]) validateRenderCount(count);
  validateRenderDuration(renderer.last_render_duration_ms);
  validateRenderDuration(renderer.max_render_duration_ms);
  if (typeof renderer.rendering_enabled !== "boolean") invalidReport();

  const scroller = exactObject(rendering.scroller, [
    "mode",
    "distance_from_end_bucket",
    "registered_row_count",
    "pending_layout_mutation_count",
    "layout_mutation_pending",
    "geometry_update_pending",
    "programmatic_scroll_pending",
    "submitted_prompt_anchor_active",
    "destroyed",
  ]);
  if (!isOneOf(scroller.mode, ["end", "manual"])) invalidReport();
  if (!isOneOf(scroller.distance_from_end_bucket, ["at_end", "near_end", "within_viewport", "far_from_end", "unknown"])) invalidReport();
  validateRenderCount(scroller.registered_row_count);
  validateRenderCount(scroller.pending_layout_mutation_count);
  for (const flag of [
    scroller.layout_mutation_pending,
    scroller.geometry_update_pending,
    scroller.programmatic_scroll_pending,
    scroller.submitted_prompt_anchor_active,
    scroller.destroyed,
  ]) {
    if (typeof flag !== "boolean") invalidReport();
  }
}

function validateResourceSamples(values: CanonicalJson[]): void {
  if (values.length > MAX_RESOURCE_SAMPLES) invalidReport();
  let previousOrdinal = 0;
  for (const value of values) {
    const sample = exactObject(value, ["ordinal", "captured_at"], [
      "heap_used_mb",
      "heap_limit_mb",
      "rss_mb",
      "cpu_percent",
      "event_loop_lag_ms",
      "freeze_delta_ms",
    ]);
    if (!isPositiveBoundedCount(sample.ordinal) || sample.ordinal <= previousOrdinal) invalidReport();
    previousOrdinal = sample.ordinal;
    if (!isCanonicalIsoTimestamp(sample.captured_at)) invalidReport();
    validateOptionalBoundedMetric(sample.heap_used_mb, 1_000_000);
    validateOptionalBoundedMetric(sample.heap_limit_mb, 1_000_000);
    validateOptionalBoundedMetric(sample.rss_mb, 1_000_000);
    validateOptionalBoundedMetric(sample.cpu_percent, 10_000);
    validateOptionalTiming(sample.event_loop_lag_ms);
    validateOptionalTiming(sample.freeze_delta_ms);
  }
}

function validateCaptureQuality(
  value: CanonicalJson,
  incident: CanonicalObject,
  correlation: CanonicalObject,
  environment: CanonicalObject,
  summary: CanonicalObject,
  runState: CanonicalJson | undefined,
  rendering: CanonicalJson | undefined,
  terminal: CanonicalObject,
  timeline: CanonicalJson[],
  timelineLength: number,
  resourceLength: number,
  transportSegments: CanonicalJson[],
  transportSegmentLength: number,
): void {
  const capture = exactObject(value, [
    "complete",
    "truncated",
    "limits",
    "report_bytes",
    "observed_event_count",
    "retained_event_count",
    "dropped_event_count",
    "dropped_events",
    "dropped_resource_sample_count",
    "dropped_tool_summary_count",
    "dropped_transport_segment_count",
    "missing_fields",
    "collection_failures",
  ]);
  if (typeof capture.complete !== "boolean" || typeof capture.truncated !== "boolean") invalidReport();
  const limits = exactObject(capture.limits, [
    "maximum_events",
    "maximum_report_bytes",
    "maximum_resource_samples",
    "maximum_tools",
    "maximum_transport_segments",
    "maximum_render_count",
    "maximum_render_duration_ms",
  ]);
  if (
    limits.maximum_events !== MAX_TIMELINE_EVENTS
    || limits.maximum_report_bytes !== AGENT_INCIDENT_MAX_REPORT_BYTES
    || limits.maximum_resource_samples !== MAX_RESOURCE_SAMPLES
    || limits.maximum_tools !== MAX_TOOLS
    || limits.maximum_transport_segments !== MAX_TRANSPORT_SEGMENTS
    || limits.maximum_render_count !== MAX_RENDER_COUNT
    || limits.maximum_render_duration_ms !== MAX_RENDER_DURATION_MS
  ) invalidReport();
  if (!isPositiveIntegerAtMost(capture.report_bytes, AGENT_INCIDENT_MAX_REPORT_BYTES)) invalidReport();
  if (!isBoundedCount(capture.observed_event_count) || !isBoundedCount(capture.retained_event_count) || !isBoundedCount(capture.dropped_event_count) || !isBoundedCount(capture.dropped_resource_sample_count) || !isBoundedCount(capture.dropped_tool_summary_count) || !isBoundedCount(capture.dropped_transport_segment_count)) invalidReport();
  if (capture.observed_event_count !== summary.observed_lifecycle_event_count || capture.retained_event_count !== timelineLength || capture.retained_event_count !== summary.retained_timeline_event_count) invalidReport();
  const dropped = exactObject(capture.dropped_events, ["event_limit", "byte_limit", "after_terminal"]);
  if (!isBoundedCount(dropped.event_limit) || !isBoundedCount(dropped.byte_limit) || !isBoundedCount(dropped.after_terminal)) invalidReport();
  const droppedTotal = dropped.event_limit + dropped.byte_limit + dropped.after_terminal;
  if (capture.dropped_event_count !== droppedTotal || capture.observed_event_count !== timelineLength + droppedTotal) invalidReport();

  const missing = canonicalArray(capture.missing_fields);
  validateOrderedUniqueStrings(missing, AGENT_INCIDENT_MISSING_FIELD_CODES);
  const expectedMissing = recomputeMissingFields({
    incident,
    correlation,
    environment,
    summary,
    runState,
    rendering,
    terminal,
    timeline,
    resourceLength,
    transportSegments,
  });
  if (missing.length !== expectedMissing.length) invalidReport();
  for (let index = 0; index < missing.length; index += 1) {
    if (missing[index] !== expectedMissing[index]) invalidReport();
  }
  const failures = canonicalArray(capture.collection_failures);
  const seenFailures = new Set<string>();
  let previousFailureIndex = -1;
  const failureOrder: readonly string[] = AGENT_INCIDENT_CAPTURE_FAILURE_CODES;
  for (const failureValue of failures) {
    const failure = exactObject(failureValue, ["code", "count"]);
    if (typeof failure.code !== "string" || !CAPTURE_FAILURE_CODE_SET.has(failure.code) || seenFailures.has(failure.code) || !isPositiveBoundedCount(failure.count)) invalidReport();
    const index = failureOrder.indexOf(failure.code);
    if (index <= previousFailureIndex) invalidReport();
    previousFailureIndex = index;
    seenFailures.add(failure.code);
  }
  const runMetricsTruncated = runState !== undefined && isCanonicalObject(runState)
    && (runState.counts_truncated === true || runState.elapsed_ms_truncated === true);
  const transportMetricsTruncated = transportSegments.some((segment) => (
    isCanonicalObject(segment) && segment.metrics_truncated === true
  ));
  const expectedTruncated = droppedTotal > 0
    || capture.dropped_resource_sample_count > 0
    || capture.dropped_tool_summary_count > 0
    || capture.dropped_transport_segment_count > 0
    || runMetricsTruncated
    || transportMetricsTruncated;
  if (capture.truncated !== expectedTruncated) invalidReport();
  if (capture.complete !== (!expectedTruncated && missing.length === 0 && failures.length === 0)) invalidReport();
  if (resourceLength + capture.dropped_resource_sample_count > MAX_COUNT) invalidReport();
  if (transportSegmentLength + capture.dropped_transport_segment_count > MAX_COUNT) invalidReport();
}

function recomputeMissingFields(input: {
  incident: CanonicalObject;
  correlation: CanonicalObject;
  environment: CanonicalObject;
  summary: CanonicalObject;
  runState: CanonicalJson | undefined;
  rendering: CanonicalJson | undefined;
  terminal: CanonicalObject;
  timeline: CanonicalJson[];
  resourceLength: number;
  transportSegments: CanonicalJson[];
}): string[] {
  const missing = new Set<string>();
  const partial = input.summary.partial_output as CanonicalObject;
  if (input.summary.started_at === undefined) missing.add("run_started");
  if (input.incident.incident_id === undefined) missing.add("server_incident_id");
  if (input.incident.failure_code === undefined) missing.add("failure_code");
  if (input.correlation.server_run_id === undefined) missing.add("server_run_id");
  if (input.incident.failure_authority === "unknown") missing.add("failure_authority");
  if (input.incident.failure_stage === "not_recorded") missing.add("failure_stage");
  if (input.incident.failure_mechanism === "not_recorded") missing.add("failure_mechanism");
  if (input.summary.terminal_validation === "not_recorded") missing.add("terminal_validation");
  if (input.summary.host_process_state === "unknown") missing.add("host_process_state");
  if (input.summary.chat_view_state === "unknown") missing.add("chat_view_state");
  if (input.summary.duration_ms === undefined) missing.add("duration_ms");
  if (partial.assistant_text_part_count === undefined) missing.add("assistant_text_part_count");
  if (partial.assistant_text_streaming_part_count === undefined) missing.add("assistant_text_streaming_part_count");
  if (partial.assistant_text_complete_part_count === undefined) missing.add("assistant_text_complete_part_count");
  if (partial.assistant_text_character_count === undefined) missing.add("assistant_text_character_count");
  if (partial.reasoning_part_count === undefined) missing.add("reasoning_part_count");
  if (partial.reasoning_streaming_part_count === undefined) missing.add("reasoning_streaming_part_count");
  if (partial.reasoning_complete_part_count === undefined) missing.add("reasoning_complete_part_count");
  if (partial.reasoning_character_count === undefined) missing.add("reasoning_character_count");
  if (partial.assistant_output_present_before_failure === undefined) missing.add("assistant_output_present_before_failure");
  if (partial.assistant_output_retained_in_failed_projection === undefined) missing.add("assistant_output_retained_in_failed_projection");
  if (input.runState === undefined) missing.add("run_state");
  if (input.rendering === undefined) {
    missing.add("rendering");
    missing.add("rendering_before_terminal_publish");
    missing.add("rendering_after_terminal_commit");
    missing.add("failure_surface_dom_commit");
    missing.add("failure_surface_paint_opportunity");
  } else {
    const rendering = input.rendering as CanonicalObject;
    if (rendering.before_terminal_publish === undefined) {
      missing.add("rendering_before_terminal_publish");
    }
    if (rendering.after_terminal_commit === undefined) {
      missing.add("rendering_after_terminal_commit");
    }
    if (rendering.failure_surface_dom_committed !== true) {
      missing.add("failure_surface_dom_commit");
    }
    if (rendering.failure_surface_paint_opportunity_observed !== true) {
      missing.add("failure_surface_paint_opportunity");
    }
  }
  if (input.resourceLength === 0) missing.add("resource_samples");
  if (input.transportSegments.length === 0) missing.add("transport_segments");
  const terminalTransport = terminalTransportReference(input.timeline);
  if (!terminalTransport || !input.transportSegments.some((value) => (
      isCanonicalObject(value)
      && value.segment_ordinal === terminalTransport.segmentOrdinal
      && (terminalTransport.commandKind === undefined || value.command_kind === terminalTransport.commandKind)
      && (
        terminalTransport.toolExecutionOrdinal === undefined
        || value.tool_execution_ordinal === terminalTransport.toolExecutionOrdinal
      )
    ))) missing.add("terminal_transport_segment");
  if (input.environment.plugin_version === undefined) missing.add("environment_plugin_version");
  if (input.environment.plugin_build_id === undefined) missing.add("environment_plugin_build_id");
  if (input.environment.loaded_bundle_sha256 === undefined) missing.add("environment_loaded_bundle_sha256");
  if (input.environment.obsidian_version === undefined) missing.add("environment_obsidian_version");
  if (input.environment.host_type === undefined || input.environment.host_type === "unknown") missing.add("environment_host_type");
  if (input.environment.os_family === undefined || input.environment.os_family === "unknown") missing.add("environment_os_family");
  if (input.timeline.some((value) => (
    isCanonicalObject(value)
    && typeof value.code === "string"
    && isToolLifecycleCodeValue(value.code)
    && value.tool_execution_ordinal === undefined
  ))) {
    missing.add("tool_execution_ordinal");
  }
  return AGENT_INCIDENT_MISSING_FIELD_CODES.filter((field) => missing.has(field));
}

function terminalTransportReference(
  timeline: CanonicalJson[],
): Readonly<{
  segmentOrdinal: number;
  commandKind?: string;
  toolExecutionOrdinal?: number;
}> | null {
  let segmentOrdinal: number | undefined;
  let commandKind: string | undefined;
  let toolExecutionOrdinal: number | undefined;
  for (const value of timeline) {
    if (!isCanonicalObject(value)) continue;
    if (value.code !== "response_result_received_failed" && value.code !== "run_finished_failed") continue;
    if (typeof value.command_segment_ordinal !== "number") continue;
    if (segmentOrdinal !== undefined && segmentOrdinal !== value.command_segment_ordinal) return null;
    if (commandKind !== undefined && typeof value.command_kind === "string" && commandKind !== value.command_kind) return null;
    if (
      toolExecutionOrdinal !== undefined
      && typeof value.tool_execution_ordinal === "number"
      && toolExecutionOrdinal !== value.tool_execution_ordinal
    ) return null;
    segmentOrdinal = value.command_segment_ordinal;
    commandKind = commandKind ?? (typeof value.command_kind === "string" ? value.command_kind : undefined);
    toolExecutionOrdinal = toolExecutionOrdinal
      ?? (typeof value.tool_execution_ordinal === "number" ? value.tool_execution_ordinal : undefined);
  }
  return segmentOrdinal === undefined
    ? null
    : {
        segmentOrdinal,
        ...(commandKind === undefined ? {} : { commandKind }),
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      };
}

function isToolLifecycleCodeValue(code: string): boolean {
  return code.startsWith("local_tool_")
    || code.startsWith("tool_result_")
    || code.startsWith("mutation_");
}

function validatePrivacy(value: CanonicalJson): void {
  const privacy = exactObject(value, [
    "policy",
    "policy_version",
    "capture_implementation_version",
    "storage_target",
    "host_sync",
    "automatic_upload",
    "excluded_data_categories",
  ]);
  if (privacy.policy !== "strict_allowlist_content_free") invalidReport();
  if (privacy.policy_version !== "systemsculpt.incident-privacy/1") invalidReport();
  if (privacy.capture_implementation_version !== "agent-incident-recorder/1") invalidReport();
  if (
    privacy.storage_target !== "vault_local"
    || privacy.host_sync !== "may_sync_with_vault"
    || privacy.automatic_upload !== false
  ) invalidReport();
  const categories = canonicalArray(privacy.excluded_data_categories);
  if (categories.length !== AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES.length) invalidReport();
  for (let index = 0; index < categories.length; index += 1) {
    if (categories[index] !== AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES[index]) invalidReport();
  }
}

function exactObject(
  value: CanonicalJson,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): CanonicalObject {
  if (!isCanonicalObject(value)) invalidReport();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) invalidReport();
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalidReport();
  return value;
}

function canonicalArray(value: CanonicalJson): CanonicalJson[] {
  if (!Array.isArray(value)) invalidReport();
  return value;
}

function isCanonicalIsoTimestamp(value: CanonicalJson): value is string {
  if (typeof value !== "string" || !RFC3339_UTC_TIMESTAMP.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

function validateOptionalPattern(value: CanonicalJson | undefined, pattern: RegExp): void {
  if (value !== undefined && (typeof value !== "string" || !pattern.test(value))) invalidReport();
}

function validateOptionalVersion(value: CanonicalJson | undefined): void {
  if (value !== undefined && (typeof value !== "string" || value.length > 64 || !VERSION_PATTERN.test(value))) invalidReport();
}

function validateOptionalEnum(
  value: CanonicalJson | undefined,
  allowed: readonly string[],
  optional = true,
): void {
  if (value === undefined) {
    if (!optional) invalidReport();
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) invalidReport();
}

function isOneOf(value: CanonicalJson | undefined, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isHttpStatus(value: CanonicalJson): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isPositiveSafeInteger(value: CanonicalJson): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedCount(value: CanonicalJson): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isPositiveBoundedCount(value: CanonicalJson): value is number {
  return isBoundedCount(value) && value > 0;
}

function isPositiveIntegerAtMost(value: CanonicalJson, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateOptionalPositiveInteger(value: CanonicalJson | undefined): void {
  if (value !== undefined && !isPositiveSafeInteger(value)) invalidReport();
}

function validateOptionalToolItemCount(value: CanonicalJson | undefined): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TOOL_ITEM_COUNT)) invalidReport();
}

function isBoundedMetric(value: CanonicalJson, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function isIntegerMetricAtMost(value: CanonicalJson, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function hasAtMostThreeDecimalPlaces(value: number): boolean {
  return Number(value.toFixed(3)) === value;
}

function validateRenderCount(value: CanonicalJson): void {
  if (!isIntegerMetricAtMost(value, MAX_RENDER_COUNT)) invalidReport();
}

function validateRenderDuration(value: CanonicalJson): void {
  if (!isIntegerMetricAtMost(value, MAX_RENDER_DURATION_MS)) invalidReport();
}

function validateOptionalBoundedMetric(value: CanonicalJson | undefined, maximum: number): void {
  if (value !== undefined && !isBoundedMetric(value, maximum)) invalidReport();
}

function validateOptionalTiming(value: CanonicalJson | undefined): void {
  validateOptionalBoundedMetric(value, MAX_TIMING_MS);
}

function validateOrderedUniqueStrings(values: CanonicalJson[], allowed: readonly string[]): void {
  let previousIndex = -1;
  for (const value of values) {
    if (typeof value !== "string") invalidReport();
    const index = allowed.indexOf(value);
    if (index <= previousIndex) invalidReport();
    previousIndex = index;
  }
}

function sameOptionalValue(left: CanonicalJson | undefined, right: CanonicalJson | undefined): boolean {
  return left === right;
}

function isZeroPrefixedId(value: string): boolean {
  const separator = value.indexOf("_");
  return separator >= 0 && /^0+$/u.test(value.slice(separator + 1));
}

function canonicalProject(value: unknown, maximumCodeUnits: number): CanonicalJson {
  const seen = new Set<object>();
  const state = { values: 0, codeUnits: 0 };

  const visit = (current: unknown, depth: number): CanonicalJson => {
    state.values += 1;
    if (state.values > MAX_SERIALIZATION_VALUES || depth > MAX_SERIALIZATION_DEPTH) invalidReport();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      state.codeUnits += current.length;
      if (state.codeUnits > maximumCodeUnits || !hasWellFormedUtf16(current)) reportTooLargeOrInvalid(state.codeUnits > maximumCodeUnits);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidReport();
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object") invalidReport();
    if (seen.has(current)) invalidReport();

    const prototype = Object.getPrototypeOf(current) as object | null;
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) invalidReport();
      seen.add(current);
      const keys = Reflect.ownKeys(current);
      if (keys.length > MAX_SERIALIZATION_VALUES - state.values) invalidReport();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_SERIALIZATION_VALUES - state.values) invalidReport();
      if (keys.length !== lengthDescriptor.value + 1) invalidReport();
      for (const key of keys) {
        if (typeof key === "symbol") invalidReport();
        if (key === "length") continue;
        if (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= lengthDescriptor.value) invalidReport();
      }
      const projected: CanonicalJson[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidReport();
        projected.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(current);
      return projected;
    }

    if (prototype !== Object.prototype && prototype !== null) invalidReport();
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.length > MAX_SERIALIZATION_VALUES - state.values) invalidReport();
    if (keys.some((key) => typeof key === "symbol")) invalidReport();
    const names = keys as string[];
    for (const name of names) {
      state.codeUnits += name.length;
      if (state.codeUnits > maximumCodeUnits || !hasWellFormedUtf16(name)) reportTooLargeOrInvalid(state.codeUnits > maximumCodeUnits);
    }
    names.sort(compareText);
    const projected: { [key: string]: CanonicalJson } = Object.create(null) as { [key: string]: CanonicalJson };
    for (const name of names) {
      if (RESERVED_KEYS.has(name)) invalidReport();
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidReport();
      projected[name] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return projected;
  };

  try {
    return visit(value, 0);
  } catch (error) {
    if (error instanceof AgentIncidentStoreError) throw error;
    invalidReport();
  }
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function reportTooLargeOrInvalid(tooLarge: boolean): never {
  if (tooLarge) {
    throw new AgentIncidentStoreError("report_too_large", "The incident report exceeds the local size limit.");
  }
  invalidReport();
}

function deepFreeze<T extends CanonicalJson>(value: T): T {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isCanonicalObject(value: CanonicalJson): value is { [key: string]: CanonicalJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReportId(value: string): void {
  if (!REPORT_ID_PATTERN.test(value) || value === `report_${"0".repeat(32)}`) {
    throw new AgentIncidentStoreError("invalid_identifier", "The incident report ID is invalid.");
  }
}

function validateIncidentId(value: string): void {
  if (!INCIDENT_ID_PATTERN.test(value) || value === `incident_${"0".repeat(32)}`) {
    throw new AgentIncidentStoreError("invalid_identifier", "The incident correlation ID is invalid.");
  }
}

function invalidReport(): never {
  throw new AgentIncidentStoreError("invalid_report", "The incident report does not match the local persistence envelope.");
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function parseArtifactReportTimestamp(serialized: string): number | undefined {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "created_at");
    const createdAt: unknown = descriptor?.value;
    return typeof createdAt === "string" && isCanonicalIsoTimestamp(createdAt) ? Date.parse(createdAt) : undefined;
  } catch {
    return undefined;
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedFileSize(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0) return maximum;
  return Math.min(Math.floor(value), maximum);
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function artifactFromStat(path: string, stat: Stat | null, unknownSize: number, reportCreatedAtMs?: number): ArtifactEntry {
  return {
    path,
    reportCreatedAtMs,
    ctimeMs: stat ? finiteTimestamp(stat.ctime) : 0,
    mtimeMs: stat ? finiteTimestamp(stat.mtime) : 0,
    diskBytes: stat && Number.isFinite(stat.size) && stat.size >= 0 ? stat.size : unknownSize + 1,
  };
}

function compareNewestFirst(left: ReportEntry, right: ReportEntry, nowMs?: number): number {
  const leftTimestamp = nowMs === undefined ? left.createdAtMs : reportRetentionTime(left, nowMs);
  const rightTimestamp = nowMs === undefined ? right.createdAtMs : reportRetentionTime(right, nowMs);
  return rightTimestamp - leftTimestamp
    || compareText(left.reportId, right.reportId);
}

function compareOldestFirst(left: ReportEntry, right: ReportEntry, nowMs: number): number {
  return reportRetentionTime(left, nowMs) - reportRetentionTime(right, nowMs)
    || compareText(left.reportId, right.reportId);
}

function reportRetentionTime(entry: ReportEntry, nowMs: number): number {
  return boundedHistoricalTimestamp(entry.createdAtMs, nowMs)
    || safeFilesystemTimestamp(entry.mtimeMs, entry.ctimeMs, nowMs);
}

function artifactRetentionTime(entry: ArtifactEntry, nowMs: number): number {
  return boundedHistoricalTimestamp(entry.reportCreatedAtMs ?? 0, nowMs)
    || safeFilesystemTimestamp(entry.mtimeMs, entry.ctimeMs, nowMs);
}

function compareArtifactsOldestFirst(left: ArtifactEntry, right: ArtifactEntry, nowMs: number): number {
  return artifactRetentionTime(left, nowMs) - artifactRetentionTime(right, nowMs)
    || compareText(left.path, right.path);
}

function safeFilesystemTimestamp(mtimeMs: number, ctimeMs: number, nowMs: number): number {
  const boundedMtimeMs = boundedHistoricalTimestamp(mtimeMs, nowMs);
  const boundedCtimeMs = boundedHistoricalTimestamp(ctimeMs, nowMs);
  return Math.max(boundedMtimeMs, boundedCtimeMs);
}

function boundedHistoricalTimestamp(value: number, nowMs: number): number {
  return value > 0 && value <= nowMs ? value : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareScanPaths(left: string, right: string): number {
  return scanPathPriority(left) - scanPathPriority(right) || compareText(left, right);
}

function scanPathPriority(path: string): number {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName.endsWith(".json") && REPORT_ID_PATTERN.test(fileName.slice(0, -5))) return 0;
  if (TEMP_FILE_PATTERN.test(fileName) || CORRUPT_REPORT_FILE_PATTERN.test(fileName) || fileName.endsWith(".json")) return 1;
  return 2;
}

function sumDiskBytes(entries: ReadonlyArray<{ diskBytes: number }>): number {
  return entries.reduce((total, entry) => total + entry.diskBytes, 0);
}

function storedResult<TReport extends AgentIncidentStoreReport>(entry: ReportEntry): StoredAgentIncidentReport<TReport> {
  return Object.freeze({
    report: entry.report as TReport,
    serialized: entry.serialized,
    sizeBytes: entry.sizeBytes,
  });
}

function emptyRetentionResult(): AgentIncidentRetentionResult {
  return Object.freeze({
    scanComplete: true,
    inspectedCandidates: 0,
    inspectedBytes: 0,
    skippedCandidates: 0,
    scannedReports: 0,
    retainedReports: 0,
    retainedBytes: 0,
    removedReports: 0,
    removedArtifacts: 0,
    corruptReports: 0,
    cleanupFailures: 0,
    limitsSatisfied: true,
  });
}

function adapterCoordination(adapter: AgentIncidentStoreAdapter): AdapterCoordination {
  const key = adapter as object;
  const existing = ADAPTER_COORDINATION.get(key);
  if (existing) return existing;
  const created = { tail: Promise.resolve() };
  ADAPTER_COORDINATION.set(key, created);
  return created;
}
