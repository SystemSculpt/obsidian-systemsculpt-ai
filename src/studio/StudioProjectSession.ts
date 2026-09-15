import {
  cloneStudioProjectSnapshot,
  readonlyStudioProjectSnapshot,
  type ReadonlyStudioProjectSnapshot,
} from "./StudioProjectSnapshots";
import {
  computeStudioProjectTextSignature,
  consumeExpectedStudioProjectWriteSignature,
  resolveStudioProjectModifyDecision,
  trackExpectedStudioProjectWriteSignature,
  type StudioProjectModifyDecision,
} from "./StudioProjectLiveSync";
import type { StudioProjectV1 } from "./types";
import { reconcileStudioProject, type StudioProjectReconciliation } from "./StudioProjectReconciliation";
import { serializeStudioProject } from "./schema";

export type StudioProjectSessionAutosaveMode = "discrete" | "continuous";

export type StudioProjectSessionMutationReason =
  | "node.config"
  | "node.geometry"
  | "node.position"
  | "node.title"
  | "graph.connection"
  | "graph.group"
  | "graph.node.create"
  | "graph.node.remove"
  | "diagram.shape.create"
  | "diagram.shape.move"
  | "diagram.shape.resize"
  | "diagram.shape.label"
  | "diagram.arrow.create"
  | "diagram.arrow.label"
  | "diagram.remove"
  | "media.editor"
  | "runtime.projector"
  | "vault.sync"
  | "history.apply"
  | "project.load"
  | "project.reload"
  | "project.repair"
  | "unknown";

export type StudioProjectSessionExternalUpdateResult = {
  signature: string;
  decision: StudioProjectModifyDecision;
};

export type StudioProjectSessionMutateOptions = {
  mode?: StudioProjectSessionAutosaveMode;
  notifyListeners?: boolean;
};

export type StudioProjectSessionReplaceProjectOptions = {
  projectPath?: string;
  acceptedRawText?: string | null;
  notifyListeners?: boolean;
};

export type StudioProjectSessionDebugState = {
  projectPath: string;
  dirtyRevision: number;
  persistedRevision: number;
  hasPendingLocalSaveWork: boolean;
  saveTimerMode: StudioProjectSessionAutosaveMode | null;
  saveInFlight: boolean;
  saveFailurePaused: boolean;
};

type StudioProjectSessionOptions = {
  projectPath: string;
  project: StudioProjectV1;
  saveProject: (
    projectPath: string,
    project: StudioProjectV1,
    onBeforeProjectWrite?: (rawText: string) => void,
    baseProject?: StudioProjectV1
  ) => Promise<void | StudioProjectReconciliation>;
  readProjectRawText?: (projectPath: string) => Promise<string | null>;
  saveBlockedProjectRecovery?: (
    projectPath: string,
    project: StudioProjectV1
  ) => Promise<void>;
  discreteDelayMs?: number;
  continuousDelayMs?: number;
};

const DEFAULT_DISCRETE_DELAY_MS = 40;
const DEFAULT_CONTINUOUS_DELAY_MS = 120;

type StudioProjectSessionMutator = (project: StudioProjectV1) => boolean | void;
type StudioProjectSessionAsyncMutator = (project: StudioProjectV1) => Promise<boolean | void>;

export class StudioProjectSession {
  private projectPath: string;
  private project: StudioProjectV1;
  private baseProject: StudioProjectV1;
  private conflictRecovery: { revision: number; project: StudioProjectV1; fields: string[] } | null = null;
  private saveTimer: number | null = null;
  private saveTimerMode: StudioProjectSessionAutosaveMode | null = null;
  private saveInFlight = false;
  private saveInFlightPromise: Promise<void> | null = null;
  private saveQueued = false;
  private saveQueuedMode: StudioProjectSessionAutosaveMode | null = null;
  private saveFailurePaused = false;
  private dirtyRevision = 0;
  private persistedRevision = 0;
  private projectFileWriteBlocked = false;
  private disposed = false;
  private lastAcceptedSignature: string | null = null;
  private lastRejectedSignature: string | null = null;
  private expectedProjectWriteSignatures = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly discreteDelayMs: number;
  private readonly continuousDelayMs: number;

  constructor(private readonly options: StudioProjectSessionOptions) {
    this.projectPath = String(options.projectPath || "").trim();
    this.project = cloneStudioProjectSnapshot(options.project);
    this.baseProject = cloneStudioProjectSnapshot(options.project);
    this.discreteDelayMs = Math.max(0, Math.floor(options.discreteDelayMs ?? DEFAULT_DISCRETE_DELAY_MS));
    this.continuousDelayMs = Math.max(
      this.discreteDelayMs,
      Math.floor(options.continuousDelayMs ?? DEFAULT_CONTINUOUS_DELAY_MS)
    );
  }

  getProjectPath(): string {
    return this.projectPath;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private warnDisposedWrite(operation: string): void {
    console.warn("[SystemSculpt Studio] Ignored write to disposed project session", {
      projectPath: this.projectPath,
      operation,
    });
  }

  getProject(): StudioProjectV1 {
    return this.project;
  }

  getProjectSnapshot(): StudioProjectV1 {
    return cloneStudioProjectSnapshot(this.project);
  }

  getEditingSnapshot(): { base: StudioProjectV1; project: StudioProjectV1 } {
    return { base: cloneStudioProjectSnapshot(this.baseProject), project: this.getProjectSnapshot() };
  }

  getConflictRecovery(): { revision: number; project: StudioProjectV1; fields: string[] } | null {
    return this.conflictRecovery ? { ...this.conflictRecovery, project: cloneStudioProjectSnapshot(this.conflictRecovery.project), fields: [...this.conflictRecovery.fields] } : null;
  }

  async restoreEditingSnapshot(snapshot: { base: StudioProjectV1; project: StudioProjectV1 }): Promise<void> {
    const reconciled = reconcileStudioProject(snapshot.base, snapshot.project, this.project);
    if (reconciled.conflicts.length > 0) {
      if (!this.options.saveBlockedProjectRecovery) throw new Error("Studio could not preserve edits from before the reload.");
      await this.options.saveBlockedProjectRecovery(this.projectPath, snapshot.project);
    }
    if (serializeStudioProject(reconciled.project) === serializeStudioProject(this.project)) return;
    this.project = reconciled.project;
    this.schedulePersist({ reason: "project.reload" });
    this.notifyListeners();
    await this.flushPendingSaveWork();
  }

  getReadonlyProjectSnapshot(): ReadonlyStudioProjectSnapshot {
    return readonlyStudioProjectSnapshot(this.project);
  }

  getDebugState(): StudioProjectSessionDebugState {
    return {
      projectPath: this.projectPath,
      dirtyRevision: this.dirtyRevision,
      persistedRevision: this.persistedRevision,
      hasPendingLocalSaveWork: this.hasPendingLocalSaveWork(),
      saveTimerMode: this.saveTimerMode,
      saveInFlight: this.saveInFlight,
      saveFailurePaused: this.saveFailurePaused,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  mutate(
    reason: StudioProjectSessionMutationReason,
    mutator: StudioProjectSessionMutator,
    options?: StudioProjectSessionMutateOptions
  ): boolean {
    if (this.disposed) {
      this.warnDisposedWrite(`mutate:${reason}`);
      return false;
    }
    const changed = mutator(this.project) !== false;
    if (!changed) {
      return false;
    }
    this.schedulePersist({ mode: options?.mode || "discrete", reason });
    if (options?.notifyListeners !== false) {
      this.notifyListeners();
    }
    return true;
  }

  async mutateAsync(
    reason: StudioProjectSessionMutationReason,
    mutator: StudioProjectSessionAsyncMutator,
    options?: StudioProjectSessionMutateOptions
  ): Promise<boolean> {
    if (this.disposed) {
      this.warnDisposedWrite(`mutateAsync:${reason}`);
      return false;
    }
    const before = this.getProjectSnapshot();
    const draft = cloneStudioProjectSnapshot(before);
    const changed = (await mutator(draft)) !== false;
    if (this.disposed) return false;
    if (!changed || serializeStudioProject(before) === serializeStudioProject(draft)) {
      return false;
    }
    const reconciled = reconcileStudioProject(before, draft, this.project);
    if (reconciled.conflicts.length > 0) await this.options.saveBlockedProjectRecovery?.(this.projectPath, draft);
    this.project = reconciled.project;
    this.schedulePersist({ mode: options?.mode || "discrete", reason });
    if (options?.notifyListeners !== false) {
      this.notifyListeners();
    }
    return true;
  }

  async mutateAndFlush(
    reason: StudioProjectSessionMutationReason,
    mutator: StudioProjectSessionMutator,
    options?: StudioProjectSessionMutateOptions
  ): Promise<boolean> {
    const changed = this.mutate(reason, mutator, options);
    if (!changed) {
      return false;
    }
    await this.flushPendingSaveWork({ force: true });
    return true;
  }

  replaceProject(project: StudioProjectV1, options?: StudioProjectSessionReplaceProjectOptions): void {
    if (this.disposed) {
      this.warnDisposedWrite("replaceProject");
      return;
    }
    this.project = cloneStudioProjectSnapshot(project);
    this.baseProject = cloneStudioProjectSnapshot(project);
    this.projectPath = String(options?.projectPath || this.projectPath || "").trim();
    this.clearSaveTimer();
    this.saveQueued = false;
    this.saveQueuedMode = null;
    this.dirtyRevision = 0;
    this.persistedRevision = 0;
    this.saveFailurePaused = false;
    if (typeof options?.acceptedRawText === "string") {
      this.projectFileWriteBlocked = false;
    }
    this.clearProjectFileState();
    if (typeof options?.acceptedRawText === "string" && options.acceptedRawText.length > 0) {
      this.markAcceptedProjectText(options.acceptedRawText);
    }
    if (options?.notifyListeners !== false) {
      this.notifyListeners();
    }
  }

  replaceProjectSnapshot(project: StudioProjectV1, options?: StudioProjectSessionReplaceProjectOptions): void {
    this.replaceProject(project, options);
  }

  async reconcileExternalProject(project: StudioProjectV1, rawText: string | null): Promise<void> {
    if (this.disposed) return;
    const reconciled = reconcileStudioProject(this.baseProject, this.project, project);
    if (reconciled.conflicts.length > 0) {
      if (!this.options.saveBlockedProjectRecovery) throw new Error("Studio could not preserve conflicting canvas edits.");
      await this.options.saveBlockedProjectRecovery(this.projectPath, this.getProjectSnapshot());
    }
    this.replaceProject(project, { acceptedRawText: rawText, notifyListeners: false });
    this.project = reconciled.project;
    this.projectFileWriteBlocked = false;
    if (serializeStudioProject(this.project) !== serializeStudioProject(project)) {
      this.schedulePersist({ reason: "vault.sync" });
    }
    this.notifyListeners();
  }

  hasPendingLocalSaveWork(): boolean {
    return (
      this.saveTimer !== null ||
      this.saveInFlight ||
      this.saveQueued ||
      this.dirtyRevision !== this.persistedRevision
    );
  }

  clearProjectFileState(): void {
    this.lastAcceptedSignature = null;
    this.lastRejectedSignature = null;
    this.expectedProjectWriteSignatures.clear();
  }

  blockProjectFileWrites(): void {
    this.projectFileWriteBlocked = true;
    this.clearSaveTimer();
    this.saveQueued = false;
    this.saveQueuedMode = null;
  }

  resumeProjectFileWrites(): void {
    if (!this.projectFileWriteBlocked || this.disposed) {
      return;
    }
    this.projectFileWriteBlocked = false;
    this.saveFailurePaused = false;
    if (
      !this.saveInFlight &&
      this.saveTimer === null &&
      this.dirtyRevision !== this.persistedRevision
    ) {
      this.startSaveTimer("discrete");
    }
  }

  async waitForInFlightSave(): Promise<void> {
    await (this.saveInFlightPromise || Promise.resolve());
  }

  matchesLastAcceptedProjectText(rawText: string): boolean {
    return computeStudioProjectTextSignature(rawText) === this.lastAcceptedSignature;
  }

  markAcceptedProjectSignature(signature: string, options?: { trackExpectedWrite?: boolean }): void {
    const normalized = String(signature || "").trim();
    if (!normalized) {
      return;
    }
    this.lastAcceptedSignature = normalized;
    this.lastRejectedSignature = null;
    if (options?.trackExpectedWrite === true) {
      trackExpectedStudioProjectWriteSignature(this.expectedProjectWriteSignatures, normalized);
    }
  }

  markAcceptedProjectText(rawText: string, options?: { trackExpectedWrite?: boolean }): void {
    this.markAcceptedProjectSignature(computeStudioProjectTextSignature(rawText), options);
  }

  markRejectedProjectSignature(signature: string): void {
    const normalized = String(signature || "").trim();
    if (!normalized) {
      return;
    }
    this.lastAcceptedSignature = null;
    this.lastRejectedSignature = normalized;
  }

  markRejectedProjectText(rawText: string): void {
    this.markRejectedProjectSignature(computeStudioProjectTextSignature(rawText));
  }

  resolveProjectFileTextUpdate(
    rawText: string,
    options?: {
      isActiveProjectFile?: boolean;
    }
  ): StudioProjectSessionExternalUpdateResult {
    const signature = computeStudioProjectTextSignature(rawText);
    const isExpectedSelfWrite = consumeExpectedStudioProjectWriteSignature(
      this.expectedProjectWriteSignatures,
      signature
    );
    const decision = resolveStudioProjectModifyDecision({
      isActiveProjectFile: options?.isActiveProjectFile !== false,
      isExpectedSelfWrite,
      signature,
      lastAcceptedSignature: this.lastAcceptedSignature,
      lastRejectedSignature: this.lastRejectedSignature,
    });

    if (decision.kind === "ignore") {
      if (decision.reason === "self_write" || decision.reason === "duplicate_accepted") {
        this.lastAcceptedSignature = signature;
        this.lastRejectedSignature = null;
      }
      return { signature, decision };
    }

    return { signature, decision };
  }

  schedulePersist(options?: {
    mode?: StudioProjectSessionAutosaveMode;
    reason?: StudioProjectSessionMutationReason;
  }): void {
    if (this.disposed) {
      this.warnDisposedWrite(`schedulePersist:${options?.reason || "unknown"}`);
      return;
    }
    const mode = options?.mode || "discrete";
    // A new edit is an explicit retry signal. A failed save pauses automatic
    // retry churn, but it must never make later user work permanently inert.
    this.saveFailurePaused = false;
    this.dirtyRevision += 1;

    if (this.projectFileWriteBlocked) {
      return;
    }

    if (this.saveInFlight) {
      this.saveQueued = true;
      this.saveQueuedMode = this.mergeModes(this.saveQueuedMode, mode);
      return;
    }

    if (this.saveTimer !== null) {
      if (this.saveTimerMode === "continuous" && mode === "discrete") {
        this.clearSaveTimer();
        this.startSaveTimer("discrete");
      }
      return;
    }

    this.startSaveTimer(mode);
  }

  async flushPendingSaveWork(options?: { force?: boolean }): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.projectFileWriteBlocked) {
      return;
    }
    if (this.saveFailurePaused && options?.force !== true) {
      return;
    }
    if (options?.force === true) {
      this.saveFailurePaused = false;
    }
    if (options?.force !== true && !this.hasPendingLocalSaveWork()) {
      return;
    }

    while (true) {
      this.clearSaveTimer();
      if (this.saveInFlight) {
        await (this.saveInFlightPromise || Promise.resolve());
      } else {
        await this.flushSave();
      }
      if (!this.saveInFlight && !this.saveQueued && this.saveTimer === null) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let flushError: unknown = null;
    try {
      await this.flushPendingSaveWork({ force: true });
    } catch (error) {
      // A competing file edit can make the final canvas CAS fail. Stop further
      // writes and preserve that canvas snapshot as Undo instead of dropping it
      // during teardown.
      flushError = error;
      this.blockProjectFileWrites();
    }
    const needsRecovery = this.projectFileWriteBlocked && this.hasPendingLocalSaveWork();
    if (needsRecovery) {
      if (!this.options.saveBlockedProjectRecovery) {
        throw flushError instanceof Error
          ? flushError
          : new Error("Studio could not preserve unsaved canvas work.");
      }
      // Recovery persistence is a close gate. If it fails, this session stays
      // alive so the only remaining copy of the canvas is never discarded.
      await this.options.saveBlockedProjectRecovery(this.projectPath, this.getProjectSnapshot());
    }
    if (flushError) {
      console.warn("[SystemSculpt Studio] Preserved a canvas version that lost a file-edit race", {
        projectPath: this.projectPath,
        error: flushError instanceof Error ? flushError.message : String(flushError),
      });
    }
    this.disposed = true;
    this.clearSaveTimer();
    this.listeners.clear();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Session listeners must never break the persistence pipeline.
      }
    }
  }

  private mergeModes(
    left: StudioProjectSessionAutosaveMode | null,
    right: StudioProjectSessionAutosaveMode | null
  ): StudioProjectSessionAutosaveMode {
    if (left === "discrete" || right === "discrete") {
      return "discrete";
    }
    return "continuous";
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveTimerMode = null;
    }
  }

  private startSaveTimer(mode: StudioProjectSessionAutosaveMode): void {
    this.saveTimerMode = mode;
    const delayMs = mode === "continuous" ? this.continuousDelayMs : this.discreteDelayMs;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveTimerMode = null;
      void this.flushSave().catch((error) => {
        console.warn("[SystemSculpt Studio] Unable to persist project session", {
          projectPath: this.projectPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  }

  private async flushSave(): Promise<void> {
    if (this.disposed || this.projectFileWriteBlocked || !this.projectPath) {
      return;
    }

    if (this.saveInFlight) {
      this.saveQueued = true;
      this.saveQueuedMode = this.mergeModes(this.saveQueuedMode, "discrete");
      await (this.saveInFlightPromise || Promise.resolve());
      return;
    }

    if (this.dirtyRevision === this.persistedRevision) {
      return;
    }

    this.saveInFlight = true;
    const revisionToPersist = this.dirtyRevision;
    const snapshotToPersist = this.getProjectSnapshot();
    const baseToPersist = cloneStudioProjectSnapshot(this.baseProject);
    let expectedWriteSignature: string | null = null;
    const savePromise = (async () => {
      try {
        const result = await this.options.saveProject(this.projectPath, cloneStudioProjectSnapshot(snapshotToPersist), (rawText) => {
          expectedWriteSignature = computeStudioProjectTextSignature(rawText);
          trackExpectedStudioProjectWriteSignature(
            this.expectedProjectWriteSignatures,
            expectedWriteSignature
          );
        }, baseToPersist);
        const persistedProject = result?.project || snapshotToPersist;
        if (result?.conflicts.length) this.conflictRecovery = { revision: (this.conflictRecovery?.revision || 0) + 1, project: snapshotToPersist, fields: result.conflicts };
        // An edit made while I/O was pending belongs to the next save. Rebase
        // only that new intent onto the committed result; never replace it with
        // the earlier snapshot or replay already accepted edits.
        const rebased = reconcileStudioProject(snapshotToPersist, this.project, persistedProject, { preferLocalConflicts: true }).project;
        if (serializeStudioProject(rebased) !== serializeStudioProject(this.project)) this.project = rebased;
        this.baseProject = cloneStudioProjectSnapshot(persistedProject);
        this.saveFailurePaused = false;
        if (expectedWriteSignature) {
          this.markAcceptedProjectSignature(expectedWriteSignature);
        } else {
          const rawText = this.options.readProjectRawText
            ? await this.options.readProjectRawText(this.projectPath)
            : null;
          if (rawText != null) {
            this.markAcceptedProjectText(rawText);
          }
        }
        this.persistedRevision = Math.max(this.persistedRevision, revisionToPersist);
      } catch (error) {
        if (expectedWriteSignature) {
          this.expectedProjectWriteSignatures.delete(expectedWriteSignature);
        }
        const newerEditArrived = this.dirtyRevision > revisionToPersist;
        this.saveFailurePaused = !newerEditArrived;
        if (!newerEditArrived) {
          this.saveQueued = false;
          this.saveQueuedMode = null;
        }
        throw error;
      } finally {
        this.saveInFlight = false;
        if (
          !this.projectFileWriteBlocked
          && !this.saveFailurePaused
          && (this.saveQueued || this.dirtyRevision !== this.persistedRevision)
        ) {
          const queuedMode = this.saveQueuedMode || "discrete";
          this.saveQueued = false;
          this.saveQueuedMode = null;
          this.startSaveTimer(queuedMode);
        }
        this.notifyListeners();
      }
    })();
    this.saveInFlightPromise = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.saveInFlightPromise === savePromise) {
        this.saveInFlightPromise = null;
      }
    }
  }
}
