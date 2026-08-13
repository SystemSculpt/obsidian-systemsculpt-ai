import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import {
  isThinAgentConversationId,
  isThinAgentRequestId,
} from "../../utils/ThinAgentLifecycleSchema";
import type {
  AgentChatTransportSegmentSummaryEvent,
  AgentRunFailureCaptureEvent,
} from "../../views/chatview/agent/ChatSession";
import {
  AGENT_INCIDENT_MAX_RESOURCE_SAMPLES,
  AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
  AgentIncidentRecorder,
  type AgentIncidentCaptureContext,
  type AgentIncidentCaptureFailureCode,
  type AgentIncidentCorrelationInput,
  type AgentIncidentEnvironmentInput,
  type AgentIncidentRenderingInput,
  type AgentIncidentReport,
  type AgentIncidentResourceSampleInput,
  type AgentIncidentTransportSegmentInput,
} from "./AgentIncidentRecorder";
import {
  AgentIncidentStore,
  type StoredAgentIncidentReport,
} from "./AgentIncidentStore";

const INCIDENT_ID = /^incident_(?!0{32}$)[a-f0-9]{32}$/u;
const REPORT_ID = /^report_(?!0{32}$)[a-f0-9]{32}$/u;
const MAX_PENDING_RUNS = 32;
const MAX_MEMORY_REPORTS = 20;
const MAX_PENDING_SAVES = 20;
const MAX_SETTLED_CORRELATIONS = 64;
const MAX_STATUS_COUNT = 100_000_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 1_500;
const DEFAULT_TERMINAL_SEGMENT_WAIT_MS = 50;
const MAX_TERMINAL_SEGMENT_WAIT_MS = 250;
const DEFAULT_FAILURE_SURFACE_WAIT_MS = 1_000;
const MAX_FAILURE_SURFACE_WAIT_MS = 2_000;
const MAX_LOOKUP_SERIALIZATION_ATTEMPTS = 3;

export type AgentIncidentCaptureReceipt = Readonly<{
  reportId: string;
}>;

export type AgentIncidentCopyReport = Readonly<{
  serialized: string;
  durability: "persisted" | "memory_fallback";
}>;

export type AgentIncidentCoordinatorStatus = Readonly<{
  admissionState: "open" | "closed";
  initializationState: "not_started" | "pending" | "settled";
  pendingRunCount: number;
  memoryReportCount: number;
  pendingSaveCount: number;
  pendingRunEvictionCount: number;
  droppedSaveCount: number;
  saveFailureCount: number;
  serializationFailureCount: number;
  finalizationFailureCount: number;
  initializationFailureCount: number;
  reportReservationFailureCount: number;
}>;

export type AgentIncidentCoordinatorOptions = Readonly<{
  recorder: AgentIncidentRecorder;
  store: AgentIncidentStore;
  environmentProvider?: () => AgentIncidentEnvironmentInput | null | undefined;
  resourceSamplesProvider?: (
    event: AgentRunFailureCaptureEvent,
  ) => readonly AgentIncidentResourceSampleInput[] | null | undefined;
  drainTimeoutMs?: number;
  terminalSegmentWaitMs?: number;
  failureSurfaceWaitMs?: number;
}>;

export type AgentIncidentFailureSurfaceRenderingEvent = Readonly<{
  conversationId: string;
  requestId: string;
  milestone: "dom_committed" | "paint_opportunity_observed";
  rendering: AgentIncidentRenderingInput;
}>;

export type AgentIncidentCaptureFailureOptions = Readonly<{
  chatViewState?: "mounted" | "detached" | "unknown";
}>;

type PendingCapture = {
  readonly context: AgentIncidentCaptureContext;
  readonly beforeTerminalPublishRendering?: AgentIncidentRenderingInput;
  afterTerminalCommitRendering?: AgentIncidentRenderingInput;
  failureSurfaceDomCommitted: boolean;
  failureSurfacePaintOpportunityObserved: boolean;
  readonly environment?: AgentIncidentEnvironmentInput;
  readonly resourceSamples?: readonly AgentIncidentResourceSampleInput[];
  readonly incidentId?: string;
  reportId?: string;
  readonly collectionFailures: AgentIncidentCaptureFailureCode[];
  evidenceAttached: boolean;
  finalContext?: AgentIncidentCaptureContext;
};

type PendingRun = {
  readonly correlation: AgentIncidentCorrelationInput;
  readonly transportSegments: AgentIncidentTransportSegmentInput[];
  readonly observedTransportSegmentOrdinals: Set<number>;
  terminalAccepted: boolean;
  terminalObservationSettled: boolean;
  expectedTerminalSegmentOrdinal?: number;
  terminalSegmentWaitExpired: boolean;
  terminalSegmentTimer?: number;
  failureSurfaceWaitExpired: boolean;
  failureSurfaceTimer?: number;
  capture?: PendingCapture;
  report?: AgentIncidentReport;
  processing?: Promise<void>;
};

type MemoryReport = {
  readonly reportId: string;
  readonly incidentId?: string;
  readonly serialized: string;
  durability: "persisted" | "memory_fallback";
};

type PendingSave = Readonly<{
  report: AgentIncidentReport;
}>;

type LookupKind = "incident" | "report";

type ProjectedFailureCapture = Readonly<{
  correlation: AgentIncidentCorrelationInput;
  event: AgentRunFailureCaptureEvent;
}>;

type ProjectedTransport = Readonly<{
  correlation: AgentIncidentCorrelationInput;
  segment: AgentIncidentTransportSegmentInput;
}>;

/**
 * Coordinates content-free failure evidence without blocking run settlement.
 * All persistence is local, bounded, best-effort, and detached from callers.
 */
export class AgentIncidentCoordinator {
  private readonly recorder: AgentIncidentRecorder;
  private readonly store: AgentIncidentStore;
  private readonly environmentProvider?: AgentIncidentCoordinatorOptions["environmentProvider"];
  private readonly resourceSamplesProvider?: AgentIncidentCoordinatorOptions["resourceSamplesProvider"];
  private readonly drainTimeoutMs: number;
  private readonly terminalSegmentWaitMs: number;
  private readonly failureSurfaceWaitMs: number;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly settledCorrelations = new Map<string, true>();
  private readonly memoryByIncidentId = new Map<string, MemoryReport>();
  private readonly memoryByReportId = new Map<string, MemoryReport>();
  private readonly memoryOrder: MemoryReport[] = [];
  private readonly lookupWaiters = new Map<string, Set<() => void>>();
  private readonly processingTasks = new Set<Promise<void>>();
  private readonly saveQueue: PendingSave[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  private initializationSettled = false;
  private admissionOpen = true;
  private activeSave: PendingSave | null = null;
  private pendingRunEvictionCount = 0;
  private droppedSaveCount = 0;
  private saveFailureCount = 0;
  private serializationFailureCount = 0;
  private finalizationFailureCount = 0;
  private initializationFailureCount = 0;
  private reportReservationFailureCount = 0;

  public constructor(options: AgentIncidentCoordinatorOptions) {
    this.recorder = options.recorder;
    this.store = options.store;
    this.environmentProvider = options.environmentProvider;
    this.resourceSamplesProvider = options.resourceSamplesProvider;
    this.drainTimeoutMs = boundedTimeout(
      options.drainTimeoutMs,
      DEFAULT_DRAIN_TIMEOUT_MS,
      DEFAULT_DRAIN_TIMEOUT_MS,
    );
    this.terminalSegmentWaitMs = boundedTimeout(
      options.terminalSegmentWaitMs,
      DEFAULT_TERMINAL_SEGMENT_WAIT_MS,
      MAX_TERMINAL_SEGMENT_WAIT_MS,
    );
    this.failureSurfaceWaitMs = boundedTimeout(
      options.failureSurfaceWaitMs,
      DEFAULT_FAILURE_SURFACE_WAIT_MS,
      MAX_FAILURE_SURFACE_WAIT_MS,
    );
  }

  public initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    try {
      this.initialization = Promise.resolve(this.store.initialize()).then(
        () => {
          this.initializationSettled = true;
          this.notifyDrainWaiters();
        },
        () => {
          this.initializationFailureCount = incrementCount(this.initializationFailureCount);
          this.initializationSettled = true;
          this.notifyDrainWaiters();
        },
      );
    } catch {
      this.initializationFailureCount = incrementCount(this.initializationFailureCount);
      this.initializationSettled = true;
      this.initialization = Promise.resolve();
      this.notifyDrainWaiters();
    }
    return this.initialization;
  }

  public recordLifecycle(event: SupportDiagnosticEvent): void {
    if (!this.admissionOpen) return;
    try {
      const safeEvent = copyLifecycleEvent(event);
      if (!safeEvent) return;
      const correlation = safeCorrelation(
        safeEvent.conversation_id,
        safeEvent.request_id,
      );
      if (!correlation) return;
      const recorded = this.recorder.record(safeEvent);
      if (!recorded) return;
      if (
        safeEvent.code === "run_finished_completed"
        || safeEvent.code === "run_finished_cancelled"
      ) {
        this.settleCorrelation(correlation);
        return;
      }
      if (safeEvent.code !== "run_finished_failed") return;
      const state = this.getOrCreatePendingRun(correlation);
      if (!state) return;
      state.terminalAccepted = true;
      state.expectedTerminalSegmentOrdinal = positiveOrdinal(
        safeEvent.command_segment_ordinal,
      );
      this.armTerminalSegmentWait(state);
      this.notifyLookupStateChanged(state);
      this.scheduleFinalize(state);
    } catch {
      // Diagnostics are observational and cannot affect the product lifecycle.
    }
  }

  public captureFailure(
    event: AgentRunFailureCaptureEvent,
    rendering?: AgentIncidentRenderingInput,
    options: AgentIncidentCaptureFailureOptions = {},
  ): AgentIncidentCaptureReceipt | null {
    if (!this.admissionOpen) return null;
    try {
      const projected = projectFailureCapture(event);
      if (!projected) return null;
      const existing = this.pendingRuns.get(correlationKey(projected.correlation));
      if (existing?.capture) return receiptFor(existing.capture.reportId);
      const state = existing ?? this.getOrCreatePendingRun(projected.correlation);
      if (!state) return null;
      const collectionFailures: AgentIncidentCaptureFailureCode[] = [];
      const safeRendering = rendering === undefined
        ? undefined
        : copyRenderingInput(rendering);
      if (rendering !== undefined && safeRendering === undefined) {
        pushFailure(collectionFailures, "rendering_snapshot_invalid");
      }
      const chatViewState = safeChatViewState(options.chatViewState);
      const context = failureContext(
        projected.event,
        chatViewState,
      );
      if (!context) return null;
      const environment = this.captureEnvironment(collectionFailures);
      const resourceSamples = this.captureResourceSamples(
        projected.event,
        collectionFailures,
      );
      let reservedReportId: string | undefined;
      try {
        const candidate = this.recorder.reserveReportId(projected.correlation);
        if (isReportId(candidate)) reservedReportId = candidate;
        else this.reportReservationFailureCount = incrementCount(this.reportReservationFailureCount);
      } catch {
        this.reportReservationFailureCount = incrementCount(this.reportReservationFailureCount);
      }
      const incidentId = isIncidentId(projected.event.incidentId)
        ? projected.event.incidentId
        : undefined;
      state.capture = {
        context,
        ...(safeRendering
          ? { beforeTerminalPublishRendering: safeRendering }
          : {}),
        failureSurfaceDomCommitted: false,
        failureSurfacePaintOpportunityObserved: false,
        ...(environment ? { environment } : {}),
        ...(resourceSamples ? { resourceSamples } : {}),
        ...(incidentId ? { incidentId } : {}),
        ...(reservedReportId ? { reportId: reservedReportId } : {}),
        collectionFailures,
        evidenceAttached: false,
      };
      this.armFailureSurfaceWait(state);
      this.settleTerminalObservationAfterTurn(state);
      this.notifyLookupStateChanged(state);
      this.scheduleFinalize(state);
      return receiptFor(reservedReportId);
    } catch {
      return null;
    }
  }

  public recordFailureSurfaceRendering(
    event: AgentIncidentFailureSurfaceRenderingEvent,
  ): void {
    if (!this.admissionOpen) return;
    try {
      const correlation = safeCorrelation(event.conversationId, event.requestId);
      if (!correlation) return;
      if (
        event.milestone !== "dom_committed"
        && event.milestone !== "paint_opportunity_observed"
      ) {
        return;
      }
      const rendering = copyRenderingInput(event.rendering);
      if (!rendering) return;
      const state = this.pendingRuns.get(correlationKey(correlation));
      const capture = state?.capture;
      if (!state || !capture || state.report) return;
      capture.afterTerminalCommitRendering = rendering;
      capture.failureSurfaceDomCommitted = true;
      if (event.milestone === "paint_opportunity_observed") {
        capture.failureSurfacePaintOpportunityObserved = true;
        this.clearFailureSurfaceTimer(state);
      }
      this.scheduleFinalize(state);
      this.notifyLookupStateChanged(state);
    } catch {
      // Failure-surface evidence is observational.
    }
  }

  public recordTransport(event: AgentChatTransportSegmentSummaryEvent): void {
    if (!this.admissionOpen) return;
    try {
      const projected = projectTransport(event);
      if (!projected) return;
      const key = correlationKey(projected.correlation);
      if (this.settledCorrelations.has(key)) return;
      const state = this.getOrCreatePendingRun(projected.correlation);
      if (!state) return;
      state.observedTransportSegmentOrdinals.add(
        projected.segment.commandSegmentOrdinal,
      );
      let attached = false;
      try {
        attached = this.recorder.attachTransportSegment(
          projected.correlation,
          projected.segment,
        );
      } catch {
        attached = false;
      }
      if (!attached) {
        state.transportSegments.push(projected.segment);
        while (state.transportSegments.length > AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS) {
          const removalIndex = Math.min(16, state.transportSegments.length - 1);
          state.transportSegments.splice(removalIndex, 1);
        }
      }
      this.clearSatisfiedTerminalSegmentWait(state);
      this.scheduleFinalize(state);
    } catch {
      // Transport diagnostics are observational.
    }
  }

  public loadSerializedByIncidentId(incidentId: string): Promise<string | null> {
    return isIncidentId(incidentId)
      ? this.loadSerialized("incident", incidentId)
      : Promise.resolve(null);
  }

  public loadSerializedByReportId(reportId: string): Promise<string | null> {
    return isReportId(reportId)
      ? this.loadSerialized("report", reportId)
      : Promise.resolve(null);
  }

  public async loadReportForCopy(reportId: string): Promise<AgentIncidentCopyReport | null> {
    if (!isReportId(reportId)) return null;
    const memory = await this.loadMemoryReport("report", reportId);
    return memory ? copyResult(memory) : null;
  }

  public getStatus(): AgentIncidentCoordinatorStatus {
    return Object.freeze({
      admissionState: this.admissionOpen ? "open" : "closed",
      initializationState: this.initialization === null
        ? "not_started"
        : this.initializationSettled ? "settled" : "pending",
      pendingRunCount: this.pendingRuns.size,
      memoryReportCount: this.memoryOrder.length,
      pendingSaveCount: this.saveQueue.length + (this.activeSave ? 1 : 0),
      pendingRunEvictionCount: this.pendingRunEvictionCount,
      droppedSaveCount: this.droppedSaveCount,
      saveFailureCount: this.saveFailureCount,
      serializationFailureCount: this.serializationFailureCount,
      finalizationFailureCount: this.finalizationFailureCount,
      initializationFailureCount: this.initializationFailureCount,
      reportReservationFailureCount: this.reportReservationFailureCount,
    });
  }

  public async drain(): Promise<void> {
    try {
      for (const state of [...this.pendingRuns.values()]) {
        this.scheduleFinalize(state);
      }
      await this.waitForStableWork();
    } catch {
      // Local diagnostics cannot block plugin teardown.
    }
  }

  public async closeAdmissionAndDrain(): Promise<void> {
    this.admissionOpen = false;
    try {
      for (const state of [...this.pendingRuns.values()]) {
        if (state.terminalAccepted && state.capture) {
          state.terminalSegmentWaitExpired = true;
          state.failureSurfaceWaitExpired = true;
          this.clearTerminalSegmentTimer(state);
          this.clearFailureSurfaceTimer(state);
        }
        this.scheduleFinalize(state);
      }
      await this.waitForStableWork();
    } catch {
      // Diagnostics teardown is bounded and cannot block plugin unload.
    } finally {
      for (const [key, state] of [...this.pendingRuns.entries()]) {
        if (state.processing) continue;
        this.pendingRuns.delete(key);
        this.clearTerminalSegmentTimer(state);
        this.clearFailureSurfaceTimer(state);
        this.notifyLookupStateChanged(state);
      }
    }
  }

  private captureEnvironment(
    failures: AgentIncidentCaptureFailureCode[],
  ): AgentIncidentEnvironmentInput | undefined {
    if (!this.environmentProvider) return undefined;
    try {
      const environment = copyEnvironmentInput(this.environmentProvider());
      if (environment) return environment;
    } catch {
      // The failure is recorded below.
    }
    pushFailure(failures, "environment_unavailable");
    return undefined;
  }

  private captureResourceSamples(
    event: AgentRunFailureCaptureEvent,
    failures: AgentIncidentCaptureFailureCode[],
  ): readonly AgentIncidentResourceSampleInput[] | undefined {
    if (!this.resourceSamplesProvider) return undefined;
    try {
      const samples = copyResourceSamplesInput(this.resourceSamplesProvider(event));
      if (samples) return samples;
    } catch {
      // The failure is recorded below.
    }
    pushFailure(failures, "resource_sample_unavailable");
    return undefined;
  }

  private getOrCreatePendingRun(
    correlation: AgentIncidentCorrelationInput,
  ): PendingRun | null {
    const key = correlationKey(correlation);
    if (this.settledCorrelations.has(key)) return null;
    const existing = this.pendingRuns.get(key);
    if (existing) return existing;
    while (this.pendingRuns.size >= MAX_PENDING_RUNS) {
      const oldestKey = this.pendingRuns.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.pendingRuns.get(oldestKey);
      this.pendingRuns.delete(oldestKey);
      this.pendingRunEvictionCount = incrementCount(this.pendingRunEvictionCount);
      if (oldest) {
        this.clearTerminalSegmentTimer(oldest);
        this.clearFailureSurfaceTimer(oldest);
        this.notifyLookupStateChanged(oldest);
      }
    }
    const state: PendingRun = {
      correlation,
      transportSegments: [],
      observedTransportSegmentOrdinals: new Set<number>(),
      terminalAccepted: false,
      terminalObservationSettled: false,
      terminalSegmentWaitExpired: false,
      failureSurfaceWaitExpired: false,
    };
    this.pendingRuns.set(key, state);
    return state;
  }

  private scheduleFinalize(state: PendingRun): Promise<void> | null {
    if (!state.capture || !state.terminalAccepted) return null;
    if (!this.terminalSegmentReady(state)) return null;
    if (!this.failureSurfaceReady(state)) return null;
    const key = correlationKey(state.correlation);
    if (this.pendingRuns.get(key) !== state) return null;
    if (state.processing) return state.processing;
    let task: Promise<void>;
    task = Promise.resolve().then(() => {
      this.processPendingRun(state);
    }).catch(() => {
      this.finalizationFailureCount = incrementCount(this.finalizationFailureCount);
    }).then(() => {
      if (state.processing === task) state.processing = undefined;
      this.processingTasks.delete(task);
      this.notifyLookupStateChanged(state);
      this.notifyDrainWaiters();
    });
    state.processing = task;
    this.processingTasks.add(task);
    this.notifyDrainWaiters();
    return task;
  }

  private processPendingRun(state: PendingRun): void {
    const key = correlationKey(state.correlation);
    if (this.pendingRuns.get(key) !== state || !state.capture || !state.terminalAccepted) return;
    if (!this.terminalSegmentReady(state)) return;
    if (!this.failureSurfaceReady(state)) return;
    this.clearTerminalSegmentTimer(state);
    this.clearFailureSurfaceTimer(state);
    const capture = state.capture;
    if (!capture.reportId) {
      try {
        const reserved = this.recorder.reserveReportId(state.correlation);
        if (isReportId(reserved)) capture.reportId = reserved;
        else this.reportReservationFailureCount = incrementCount(this.reportReservationFailureCount);
      } catch {
        this.reportReservationFailureCount = incrementCount(this.reportReservationFailureCount);
      }
    }
    if (!capture.evidenceAttached) {
      this.attachCaptureEvidence(state, capture);
      capture.evidenceAttached = true;
      capture.finalContext = captureContextWithFailures(
        Object.freeze({
          ...capture.context,
          rendering: Object.freeze({
            beforeTerminalPublish: capture.beforeTerminalPublishRendering,
            afterTerminalCommit: capture.afterTerminalCommitRendering,
            failureSurfaceDomCommitted: capture.failureSurfaceDomCommitted,
            failureSurfacePaintOpportunityObserved:
              capture.failureSurfacePaintOpportunityObserved,
          }),
        }) as AgentIncidentCaptureContext,
        capture.collectionFailures,
      );
    }
    if (!state.report) {
      try {
        const report = this.recorder.finalize(
          state.correlation,
          capture.finalContext ?? capture.context,
        );
        if (!report) {
          this.finalizationFailureCount = incrementCount(this.finalizationFailureCount);
          return;
        }
        state.report = report;
        if (!capture.reportId && isReportId(report.report_id)) {
          capture.reportId = report.report_id;
        }
      } catch {
        this.finalizationFailureCount = incrementCount(this.finalizationFailureCount);
        return;
      }
    }
    let serialized: string;
    try {
      serialized = this.store.serialize(state.report);
      if (typeof serialized !== "string") throw new Error("invalid serialization");
    } catch {
      this.serializationFailureCount = incrementCount(this.serializationFailureCount);
      return;
    }
    this.rememberSerialized(state.report, serialized);
    this.pendingRuns.delete(key);
    this.rememberSettledCorrelation(key);
    this.notifyLookupStateChanged(state);
    this.enqueueSave(state.report);
  }

  private attachCaptureEvidence(state: PendingRun, capture: PendingCapture): void {
    if (capture.environment) {
      try {
        if (!this.recorder.attachEnvironment(state.correlation, capture.environment)) {
          pushFailure(capture.collectionFailures, "environment_unavailable");
        }
      } catch {
        pushFailure(capture.collectionFailures, "environment_unavailable");
      }
    }
    if (capture.resourceSamples) {
      try {
        if (!this.recorder.attachResourceSamples(state.correlation, capture.resourceSamples)) {
          pushFailure(capture.collectionFailures, "resource_sample_unavailable");
        }
      } catch {
        pushFailure(capture.collectionFailures, "resource_sample_unavailable");
      }
    }
    for (const segment of state.transportSegments) {
      try {
        if (!this.recorder.attachTransportSegment(state.correlation, segment)) {
          pushFailure(capture.collectionFailures, "transport_segment_invalid");
        }
      } catch {
        pushFailure(capture.collectionFailures, "transport_segment_invalid");
      }
    }
    state.transportSegments.length = 0;
  }

  private enqueueSave(report: AgentIncidentReport): void {
    const pending: PendingSave = Object.freeze({ report });
    if (!this.activeSave) {
      this.activeSave = pending;
      this.startActiveSave(pending);
      this.notifyDrainWaiters();
      return;
    }
    while (this.saveQueue.length + 1 >= MAX_PENDING_SAVES) {
      if (this.saveQueue.length === 0) break;
      this.saveQueue.shift();
      this.droppedSaveCount = incrementCount(this.droppedSaveCount);
    }
    this.saveQueue.push(pending);
    this.notifyDrainWaiters();
  }

  private startActiveSave(pending: PendingSave): void {
    let save: Promise<unknown>;
    try {
      save = Promise.resolve(this.store.save(pending.report));
    } catch {
      save = Promise.reject(new Error("incident save unavailable"));
    }
    void save.then(
      () => this.completeActiveSave(pending, false),
      () => this.completeActiveSave(pending, true),
    );
  }

  private completeActiveSave(pending: PendingSave, failed: boolean): void {
    if (this.activeSave !== pending) return;
    if (failed) {
      this.saveFailureCount = incrementCount(this.saveFailureCount);
    } else {
      const memory = this.memoryByReportId.get(pending.report.report_id);
      if (memory) memory.durability = "persisted";
    }
    this.activeSave = null;
    const next = this.saveQueue.shift();
    if (next) {
      this.activeSave = next;
      this.startActiveSave(next);
      this.notifyDrainWaiters();
      return;
    }
    this.notifyDrainWaiters();
  }

  private rememberSerialized(
    report: AgentIncidentReport,
    serialized: string,
    durability: MemoryReport["durability"] = "memory_fallback",
  ): void {
    try {
      const reportId = report.report_id;
      if (!isReportId(reportId) || typeof serialized !== "string") return;
      const existing = this.memoryByReportId.get(reportId);
      if (existing !== undefined) return;
      const rawIncidentId = report.incident.incident_id;
      const incidentId = isIncidentId(rawIncidentId) ? rawIncidentId : undefined;
      const memory: MemoryReport = {
        reportId,
        ...(incidentId ? { incidentId } : {}),
        serialized,
        durability,
      };
      this.memoryByReportId.set(reportId, memory);
      if (incidentId) this.memoryByIncidentId.set(incidentId, memory);
      this.memoryOrder.push(memory);
      while (this.memoryOrder.length > MAX_MEMORY_REPORTS) {
        const oldest = this.memoryOrder.shift();
        if (!oldest) break;
        if (this.memoryByReportId.get(oldest.reportId) === oldest) {
          this.memoryByReportId.delete(oldest.reportId);
        }
        if (
          oldest.incidentId
          && this.memoryByIncidentId.get(oldest.incidentId) === oldest
        ) {
          this.memoryByIncidentId.delete(oldest.incidentId);
        }
      }
      this.notifyLookup("report", reportId);
      if (incidentId) this.notifyLookup("incident", incidentId);
    } catch {
      // A malformed restored report cannot escape the coordinator.
    }
  }

  private async loadSerialized(kind: LookupKind, id: string): Promise<string | null> {
    const memory = await this.loadMemoryReport(kind, id);
    return memory?.serialized ?? null;
  }

  private async loadMemoryReport(kind: LookupKind, id: string): Promise<MemoryReport | null> {
    try {
      const immediate = this.memoryReport(kind, id);
      if (immediate !== undefined) return immediate;
      for (let attempt = 0; attempt < MAX_LOOKUP_SERIALIZATION_ATTEMPTS; attempt += 1) {
        const pending = this.pendingForLookup(kind, id);
        if (!pending) break;
        if (!pending.terminalAccepted && pending.terminalObservationSettled) break;
        const task = this.scheduleFinalize(pending);
        if (task) {
          await task;
        } else {
          const signal = this.waitForLookup(kind, id);
          const afterRegistration = this.pendingForLookup(kind, id);
          if (afterRegistration) this.scheduleFinalize(afterRegistration);
          await signal;
        }
        const ready = this.memoryReport(kind, id);
        if (ready !== undefined) return ready;
      }
      const stored = await this.loadStored(kind, id);
      const afterStore = this.memoryReport(kind, id);
      if (afterStore !== undefined) return afterStore;
      if (!stored) return null;
      this.rememberSerialized(stored.report, stored.serialized, "persisted");
      return this.memoryReport(kind, id) ?? restoredMemory(stored);
    } catch {
      return null;
    }
  }

  private loadStored(
    kind: LookupKind,
    id: string,
  ): Promise<StoredAgentIncidentReport<AgentIncidentReport> | null> {
    try {
      const loaded = kind === "incident"
        ? this.store.loadByIncidentId<AgentIncidentReport>(id)
        : this.store.loadByReportId<AgentIncidentReport>(id);
      return Promise.resolve(loaded).then(
        (value) => value,
        () => null,
      );
    } catch {
      return Promise.resolve(null);
    }
  }

  private pendingForLookup(kind: LookupKind, id: string): PendingRun | null {
    for (const state of this.pendingRuns.values()) {
      const capture = state.capture;
      if (!capture) continue;
      if (kind === "incident" && capture.incidentId === id) return state;
      if (
        kind === "report"
        && (capture.reportId === id || state.report?.report_id === id)
      ) return state;
    }
    return null;
  }

  private memoryReport(kind: LookupKind, id: string): MemoryReport | undefined {
    return kind === "incident"
      ? this.memoryByIncidentId.get(id)
      : this.memoryByReportId.get(id);
  }

  private memoryValue(kind: LookupKind, id: string): string | undefined {
    return this.memoryReport(kind, id)?.serialized;
  }

  private waitForLookup(kind: LookupKind, id: string): Promise<void> {
    const key = lookupKey(kind, id);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const waiters = this.lookupWaiters.get(key);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.lookupWaiters.delete(key);
        resolve();
      };
      const waiters = this.lookupWaiters.get(key) ?? new Set<() => void>();
      waiters.add(finish);
      this.lookupWaiters.set(key, waiters);
      if (this.memoryValue(kind, id) !== undefined) finish();
    });
  }

  private notifyLookup(kind: LookupKind, id: string): void {
    const waiters = this.lookupWaiters.get(lookupKey(kind, id));
    if (!waiters) return;
    for (const finish of [...waiters]) finish();
  }

  private notifyLookupStateChanged(state: PendingRun): void {
    const capture = state.capture;
    if (!capture) return;
    if (capture.incidentId) this.notifyLookup("incident", capture.incidentId);
    if (capture.reportId) this.notifyLookup("report", capture.reportId);
    if (state.report && isReportId(state.report.report_id)) {
      this.notifyLookup("report", state.report.report_id);
    }
  }

  private waitForStableWork(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== 0) window.clearTimeout(timer);
        this.drainWaiters.delete(check);
        resolve();
      };
      const check = () => {
        if (
          this.initialization !== null
          && !this.initializationSettled
        ) return;
        if (
          this.processingTasks.size !== 0
          || this.activeSave
          || this.saveQueue.length !== 0
          || [...this.pendingRuns.values()].some(
            (state) => state.terminalSegmentTimer !== undefined
              || state.failureSurfaceTimer !== undefined,
          )
        ) return;
        finish();
      };
      this.drainWaiters.add(check);
      timer = window.setTimeout(finish, this.drainTimeoutMs);
      check();
    });
  }

  private notifyDrainWaiters(): void {
    for (const check of [...this.drainWaiters]) check();
  }

  private settleCorrelation(correlation: AgentIncidentCorrelationInput): void {
    const key = correlationKey(correlation);
    const state = this.pendingRuns.get(key);
    this.pendingRuns.delete(key);
    this.rememberSettledCorrelation(key);
    if (state) {
      this.clearTerminalSegmentTimer(state);
      this.clearFailureSurfaceTimer(state);
      this.notifyLookupStateChanged(state);
    }
  }

  private rememberSettledCorrelation(key: string): void {
    this.settledCorrelations.delete(key);
    this.settledCorrelations.set(key, true);
    while (this.settledCorrelations.size > MAX_SETTLED_CORRELATIONS) {
      const oldest = this.settledCorrelations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.settledCorrelations.delete(oldest);
    }
  }

  private settleTerminalObservationAfterTurn(state: PendingRun): void {
    void Promise.resolve().then(() => {
      const key = correlationKey(state.correlation);
      if (this.pendingRuns.get(key) !== state) return;
      state.terminalObservationSettled = true;
      this.notifyLookupStateChanged(state);
    });
  }

  private armFailureSurfaceWait(state: PendingRun): void {
    if (this.failureSurfaceReady(state) || state.failureSurfaceTimer !== undefined) {
      return;
    }
    state.failureSurfaceTimer = window.setTimeout(() => {
      state.failureSurfaceTimer = undefined;
      state.failureSurfaceWaitExpired = true;
      this.scheduleFinalize(state);
      this.notifyLookupStateChanged(state);
      this.notifyDrainWaiters();
    }, this.failureSurfaceWaitMs);
    this.notifyDrainWaiters();
  }

  private failureSurfaceReady(state: PendingRun): boolean {
    return state.capture?.failureSurfacePaintOpportunityObserved === true
      || state.failureSurfaceWaitExpired;
  }

  private clearFailureSurfaceTimer(state: PendingRun): void {
    if (state.failureSurfaceTimer === undefined) return;
    window.clearTimeout(state.failureSurfaceTimer);
    state.failureSurfaceTimer = undefined;
    this.notifyDrainWaiters();
  }

  private armTerminalSegmentWait(state: PendingRun): void {
    if (this.terminalSegmentReady(state) || state.terminalSegmentTimer !== undefined) {
      return;
    }
    state.terminalSegmentTimer = window.setTimeout(() => {
      state.terminalSegmentTimer = undefined;
      state.terminalSegmentWaitExpired = true;
      this.scheduleFinalize(state);
      this.notifyDrainWaiters();
    }, this.terminalSegmentWaitMs);
    this.notifyDrainWaiters();
  }

  private clearSatisfiedTerminalSegmentWait(state: PendingRun): void {
    const expected = state.expectedTerminalSegmentOrdinal;
    if (
      expected === undefined
      || !state.observedTransportSegmentOrdinals.has(expected)
    ) return;
    this.clearTerminalSegmentTimer(state);
  }

  private terminalSegmentReady(state: PendingRun): boolean {
    const expected = state.expectedTerminalSegmentOrdinal;
    return expected === undefined
      || state.observedTransportSegmentOrdinals.has(expected)
      || state.terminalSegmentWaitExpired;
  }

  private clearTerminalSegmentTimer(state: PendingRun): void {
    if (state.terminalSegmentTimer === undefined) return;
    window.clearTimeout(state.terminalSegmentTimer);
    state.terminalSegmentTimer = undefined;
    this.notifyDrainWaiters();
  }
}

function copyLifecycleEvent(event: SupportDiagnosticEvent): SupportDiagnosticEvent | null {
  try {
    if (!event) return null;
    return Object.freeze({
      timestamp: event.timestamp,
      severity: event.severity,
      code: event.code,
      phase: event.phase,
      origin: event.origin,
      cause: event.cause,
      sequence: event.sequence,
      conversation_id: event.conversation_id,
      request_id: event.request_id,
      client_instance_id: event.client_instance_id,
      plugin_build_id: event.plugin_build_id,
      run_id: event.run_id,
      server_run_id: event.server_run_id,
      tool_name: event.tool_name,
      status: event.status,
      retryable: event.retryable,
      incident_id: event.incident_id,
      failure_code: event.failure_code,
      latency_trace_id: event.latency_trace_id,
      command_kind: event.command_kind,
      command_segment_ordinal: event.command_segment_ordinal,
      tool_execution_ordinal: event.tool_execution_ordinal,
      tool_outcome: event.tool_outcome,
      tool_failure_class: event.tool_failure_class,
      tool_item_count: event.tool_item_count,
      tool_completed_item_count: event.tool_completed_item_count,
      tool_failed_item_count: event.tool_failed_item_count,
      history_sync_kind: event.history_sync_kind,
      history_sync_ordinal: event.history_sync_ordinal,
      response_delivery_mode: event.response_delivery_mode,
      client_monotonic_offset_ms: event.client_monotonic_offset_ms,
      client_clock_domain: event.client_clock_domain,
      server_timing_app_ms: event.server_timing_app_ms,
      server_timing_auth_ms: event.server_timing_auth_ms,
      server_timing_clock_domain: event.server_timing_clock_domain,
      credits_refresh_reason: event.credits_refresh_reason,
      credits_refresh_sequence: event.credits_refresh_sequence,
      credits_refresh_transport: event.credits_refresh_transport,
      credits_refresh_elapsed_ms: event.credits_refresh_elapsed_ms,
      credits_refresh_clock_domain: event.credits_refresh_clock_domain,
      credits_refresh_server_auth_ms: event.credits_refresh_server_auth_ms,
      credits_refresh_server_rate_limit_ms: event.credits_refresh_server_rate_limit_ms,
      credits_refresh_server_balance_store_ms: event.credits_refresh_server_balance_store_ms,
      credits_refresh_server_total_ms: event.credits_refresh_server_total_ms,
      credits_refresh_server_timing_clock_domain: event.credits_refresh_server_timing_clock_domain,
    });
  } catch {
    return null;
  }
}

function projectFailureCapture(event: AgentRunFailureCaptureEvent): ProjectedFailureCapture | null {
  try {
    if (!event) return null;
    const safeEvent: AgentRunFailureCaptureEvent = Object.freeze({
      kind: event.kind,
      conversationId: event.conversationId,
      requestId: event.requestId,
      failureAuthority: event.failureAuthority,
      failureStage: event.failureStage,
      failureMechanism: event.failureMechanism,
      terminalValidation: event.terminalValidation,
      terminalSource: event.terminalSource,
      hostProcessState: event.hostProcessState,
      chatViewState: event.chatViewState,
      runOrigin: event.runOrigin,
      runPhase: event.runPhase,
      connectionState: event.connectionState,
      elapsedMs: event.elapsedMs,
      elapsedMsTruncated: event.elapsedMsTruncated,
      serverRunId: event.serverRunId,
      incidentId: event.incidentId,
      failureCode: event.failureCode,
      retryable: event.retryable,
      assistantTextPartCount: event.assistantTextPartCount,
      assistantTextStreamingPartCount: event.assistantTextStreamingPartCount,
      assistantTextCompletePartCount: event.assistantTextCompletePartCount,
      assistantTextCharacterCount: event.assistantTextCharacterCount,
      reasoningPartCount: event.reasoningPartCount,
      reasoningStreamingPartCount: event.reasoningStreamingPartCount,
      reasoningCompletePartCount: event.reasoningCompletePartCount,
      reasoningCharacterCount: event.reasoningCharacterCount,
      assistantOutputPresentBeforeFailure: event.assistantOutputPresentBeforeFailure,
      assistantOutputRetainedInFailedProjection:
        event.assistantOutputRetainedInFailedProjection,
      snapshotPartCount: event.snapshotPartCount,
      executingLocalToolCount: event.executingLocalToolCount,
      pendingToolDeliveryCount: event.pendingToolDeliveryCount,
      pendingApprovalDeliveryCount: event.pendingApprovalDeliveryCount,
      pendingToolTaskCount: event.pendingToolTaskCount,
      serverQueued: event.serverQueued,
      runStalled: event.runStalled,
      awaitingClientWork: event.awaitingClientWork,
      pendingCancel: event.pendingCancel,
      pendingRegenerate: event.pendingRegenerate,
      countsTruncated: event.countsTruncated,
    });
    if (safeEvent.kind !== "agent_run_failed") return null;
    const correlation = safeCorrelation(
      safeEvent.conversationId,
      safeEvent.requestId,
    );
    return correlation ? Object.freeze({ correlation, event: safeEvent }) : null;
  } catch {
    return null;
  }
}

function projectTransport(event: AgentChatTransportSegmentSummaryEvent): ProjectedTransport | null {
  try {
    if (!event) return null;
    const conversationId = event.conversationId;
    const requestId = event.requestId;
    const correlation = safeCorrelation(conversationId, requestId);
    if (!correlation) return null;
    const toolExecutionOrdinal = event.toolExecutionOrdinal;
    const segment: AgentIncidentTransportSegmentInput = Object.freeze({
      commandKind: event.commandKind,
      commandSegmentOrdinal: event.commandSegmentOrdinal,
      ...(event.serverLatencyCorrelationId
        ? { serverLatencyCorrelationId: event.serverLatencyCorrelationId }
        : {}),
      ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      closeReason: event.closeReason,
      durationMs: event.durationMs,
      receivedBytes: event.receivedBytes,
      nonEmptyRawChunkCount: event.nonEmptyRawChunkCount,
      sseEventCount: event.sseEventCount,
      acceptedFrameCount: event.acceptedFrameCount,
      deliveredFrameCount: event.deliveredFrameCount,
      metricsTruncated: event.metricsTruncated,
    });
    return Object.freeze({ correlation, segment });
  } catch {
    return null;
  }
}

function safeCorrelation(
  conversationId: unknown,
  requestId: unknown,
): AgentIncidentCorrelationInput | null {
  if (
    !isThinAgentConversationId(conversationId)
    || !isThinAgentRequestId(requestId)
  ) return null;
  return Object.freeze({ conversationId, requestId });
}

function correlationKey(correlation: AgentIncidentCorrelationInput): string {
  return `${correlation.conversationId}\n${correlation.requestId}`;
}

function lookupKey(kind: LookupKind, id: string): string {
  return `${kind}:${id}`;
}

function isIncidentId(value: unknown): value is string {
  return typeof value === "string" && INCIDENT_ID.test(value);
}

function isReportId(value: unknown): value is string {
  return typeof value === "string" && REPORT_ID.test(value);
}

function receiptFor(reportId: string | undefined): AgentIncidentCaptureReceipt | null {
  return reportId ? Object.freeze({ reportId }) : null;
}

function copyResult(memory: MemoryReport): AgentIncidentCopyReport {
  return Object.freeze({
    serialized: memory.serialized,
    durability: memory.durability,
  });
}

function restoredMemory(
  stored: StoredAgentIncidentReport<AgentIncidentReport>,
): MemoryReport {
  const rawIncidentId = stored.report.incident.incident_id;
  return {
    reportId: stored.report.report_id,
    ...(isIncidentId(rawIncidentId) ? { incidentId: rawIncidentId } : {}),
    serialized: stored.serialized,
    durability: "persisted",
  };
}

function safeChatViewState(
  value: unknown,
): "mounted" | "detached" | "unknown" | undefined {
  return value === "mounted" || value === "detached" || value === "unknown"
    ? value
    : undefined;
}

function failureContext(
  event: AgentRunFailureCaptureEvent,
  chatViewState: "mounted" | "detached" | "unknown" | undefined,
): AgentIncidentCaptureContext | null {
  try {
    return Object.freeze({
      failureAuthority: event.failureAuthority,
      failureStage: event.failureStage,
      failureMechanism: event.failureMechanism,
      terminalValidation: event.terminalValidation,
      hostProcessState: event.hostProcessState,
      chatViewState: chatViewState ?? event.chatViewState,
      assistantTextPartCount: event.assistantTextPartCount,
      assistantTextStreamingPartCount: event.assistantTextStreamingPartCount,
      assistantTextCompletePartCount: event.assistantTextCompletePartCount,
      assistantTextCharacterCount: event.assistantTextCharacterCount,
      reasoningPartCount: event.reasoningPartCount,
      reasoningStreamingPartCount: event.reasoningStreamingPartCount,
      reasoningCompletePartCount: event.reasoningCompletePartCount,
      reasoningCharacterCount: event.reasoningCharacterCount,
      assistantOutputPresentBeforeFailure: event.assistantOutputPresentBeforeFailure,
      assistantOutputRetainedInFailedProjection:
        event.assistantOutputRetainedInFailedProjection,
      snapshotPartCount: event.snapshotPartCount,
      ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
      runState: Object.freeze({
        terminalSource: event.terminalSource,
        runOrigin: event.runOrigin,
        runPhase: event.runPhase,
        connectionState: event.connectionState,
        executingLocalToolCount: event.executingLocalToolCount,
        pendingToolDeliveryCount: event.pendingToolDeliveryCount,
        pendingApprovalDeliveryCount: event.pendingApprovalDeliveryCount,
        pendingToolTaskCount: event.pendingToolTaskCount,
        serverQueued: event.serverQueued,
        runStalled: event.runStalled,
        awaitingClientWork: event.awaitingClientWork,
        pendingCancel: event.pendingCancel,
        pendingRegenerate: event.pendingRegenerate,
        countsTruncated: event.countsTruncated,
        elapsedMsTruncated: event.elapsedMsTruncated,
      }),
    });
  } catch {
    return null;
  }
}

function captureContextWithFailures(
  context: AgentIncidentCaptureContext,
  failures: readonly AgentIncidentCaptureFailureCode[],
): AgentIncidentCaptureContext {
  return failures.length === 0
    ? context
    : Object.freeze({
        ...context,
        collectionFailures: Object.freeze([...failures]),
      });
}

function copyEnvironmentInput(
  input: AgentIncidentEnvironmentInput | null | undefined,
): AgentIncidentEnvironmentInput | undefined {
  if (!input) return undefined;
  try {
    return Object.freeze({
      pluginVersion: input.pluginVersion,
      pluginBuildId: input.pluginBuildId,
      loadedBundleSha256: input.loadedBundleSha256,
      obsidianVersion: input.obsidianVersion,
      hostType: input.hostType,
      osFamily: input.osFamily,
    });
  } catch {
    return undefined;
  }
}

function copyResourceSamplesInput(
  input: readonly AgentIncidentResourceSampleInput[] | null | undefined,
): readonly AgentIncidentResourceSampleInput[] | undefined {
  if (!Array.isArray(input)) return undefined;
  try {
    const samples: AgentIncidentResourceSampleInput[] = [];
    const start = Math.max(0, input.length - AGENT_INCIDENT_MAX_RESOURCE_SAMPLES);
    for (let index = start; index < input.length; index += 1) {
      const sample = input[index];
      if (!sample) continue;
      samples.push(Object.freeze({
        captured_at: sample.captured_at,
        heap_used_mb: sample.heap_used_mb,
        heap_limit_mb: sample.heap_limit_mb,
        rss_mb: sample.rss_mb,
        cpu_percent: sample.cpu_percent,
        event_loop_lag_ms: sample.event_loop_lag_ms,
        freeze_delta_ms: sample.freeze_delta_ms,
      }));
    }
    return Object.freeze(samples);
  } catch {
    return undefined;
  }
}

function copyRenderingInput(
  input: AgentIncidentRenderingInput,
): AgentIncidentRenderingInput | undefined {
  try {
    const renderer = input.renderer;
    const scroller = input.scroller;
    return Object.freeze({
      renderState: input.renderState,
      renderPassCount: input.renderPassCount,
      pendingRenderCount: input.pendingRenderCount,
      lastRenderDurationMs: input.lastRenderDurationMs,
      maxRenderDurationMs: input.maxRenderDurationMs,
      firstDomCommitObserved: input.firstDomCommitObserved,
      firstPaintOpportunityObserved: input.firstPaintOpportunityObserved,
      registeredRowCount: input.registeredRowCount,
      renderer: Object.freeze({
        renderPassCount: renderer.renderPassCount,
        pendingRenderPassCount: renderer.pendingRenderPassCount,
        lastRenderDurationMs: renderer.lastRenderDurationMs,
        maxRenderDurationMs: renderer.maxRenderDurationMs,
        historicalRowCount: renderer.historicalRowCount,
        historicalPartCount: renderer.historicalPartCount,
        activePartCount: renderer.activePartCount,
        disclosureCount: renderer.disclosureCount,
        openDisclosureCount: renderer.openDisclosureCount,
        activityDisclosureCount: renderer.activityDisclosureCount,
        reasoningDisclosureCount: renderer.reasoningDisclosureCount,
        toolDisclosureCount: renderer.toolDisclosureCount,
        overflowDisclosureCount: renderer.overflowDisclosureCount,
        pendingHydrationCount: renderer.pendingHydrationCount,
        renderingEnabled: renderer.renderingEnabled,
      }),
      scroller: Object.freeze({
        mode: scroller.mode,
        distanceFromEndBucket: scroller.distanceFromEndBucket,
        registeredRowCount: scroller.registeredRowCount,
        pendingLayoutMutationCount: scroller.pendingLayoutMutationCount,
        layoutMutationPending: scroller.layoutMutationPending,
        geometryUpdatePending: scroller.geometryUpdatePending,
        programmaticScrollPending: scroller.programmaticScrollPending,
        submittedPromptAnchorActive: scroller.submittedPromptAnchorActive,
        destroyed: scroller.destroyed,
      }),
    });
  } catch {
    return undefined;
  }
}

function pushFailure(
  failures: AgentIncidentCaptureFailureCode[],
  failure: AgentIncidentCaptureFailureCode,
): void {
  if (!failures.includes(failure)) failures.push(failure);
}

function boundedTimeout(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, maximum)
    : fallback;
}

function incrementCount(value: number): number {
  return Math.min(MAX_STATUS_COUNT, value + 1);
}

function positiveOrdinal(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined;
}
