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
  hasDeferredExternalSync: boolean;
  saveTimerMode: StudioProjectSessionAutosaveMode | null;
  saveInFlight: boolean;
};

type StudioProjectSessionOptions = {
  projectPath: string;
  project: StudioProjectV1;
  saveProject: (projectPath: string, project: StudioProjectV1) => Promise<void>;
  readProjectRawText?: (projectPath: string) => Promise<string | null>;
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
  private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private saveTimerMode: StudioProjectSessionAutosaveMode | null = null;
  private saveInFlight = false;
  private saveInFlightPromise: Promise<void> | null = null;
  private saveQueued = false;
  private saveQueuedMode: StudioProjectSessionAutosaveMode | null = null;
  private dirtyRevision = 0;
  private persistedRevision = 0;
  private pendingExternalSync = false;
  private lastAcceptedSignature: string | null = null;
  private lastRejectedSignature: string | null = null;
  private expectedProjectWriteSignatures = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly discreteDelayMs: number;
  private readonly continuousDelayMs: number;

  constructor(private readonly options: StudioProjectSessionOptions) {
    this.projectPath = String(options.projectPath || "").trim();
    this.project = cloneStudioProjectSnapshot(options.project);
    this.discreteDelayMs = Math.max(0, Math.floor(options.discreteDelayMs ?? DEFAULT_DISCRETE_DELAY_MS));
    this.continuousDelayMs = Math.max(
      this.discreteDelayMs,
      Math.floor(options.continuousDelayMs ?? DEFAULT_CONTINUOUS_DELAY_MS)
    );
  }

  getProjectPath(): string {
    return this.projectPath;
  }

  getProject(): StudioProjectV1 {
    return this.project;
  }

  getProjectSnapshot(): StudioProjectV1 {
    return cloneStudioProjectSnapshot(this.project);
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
      hasDeferredExternalSync: this.hasDeferredExternalSync(),
      saveTimerMode: this.saveTimerMode,
      saveInFlight: this.saveInFlight,
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
    const changed = (await mutator(this.project)) !== false;
    if (!changed) {
      return false;
    }
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
    this.project = cloneStudioProjectSnapshot(project);
    this.projectPath = String(options?.projectPath || this.projectPath || "").trim();
    this.clearSaveTimer();
    this.saveQueued = false;
    this.saveQueuedMode = null;
    this.dirtyRevision = 0;
    this.persistedRevision = 0;
    this.clearLiveSyncState();
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

  hasPendingLocalSaveWork(): boolean {
    return (
      this.saveTimer !== null ||
      this.saveInFlight ||
      this.saveQueued ||
      this.dirtyRevision !== this.persistedRevision
    );
  }

  hasDeferredExternalSync(): boolean {
    return this.pendingExternalSync;
  }

  consumeDeferredExternalSync(): boolean {
    const pending = this.pendingExternalSync;
    this.pendingExternalSync = false;
    return pending;
  }

  clearLiveSyncState(): void {
    this.pendingExternalSync = false;
    this.lastAcceptedSignature = null;
    this.lastRejectedSignature = null;
    this.expectedProjectWriteSignatures.clear();
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
    this.lastRejectedSignature = normalized;
  }

  markRejectedProjectText(rawText: string): void {
    this.markRejectedProjectSignature(computeStudioProjectTextSignature(rawText));
  }

  resolveExternalProjectTextUpdate(
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
      hasPendingLocalSaveWork: this.hasPendingLocalSaveWork(),
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

    if (decision.kind === "defer") {
      this.pendingExternalSync = true;
    }

    return { signature, decision };
  }

  schedulePersist(options?: {
    mode?: StudioProjectSessionAutosaveMode;
    reason?: StudioProjectSessionMutationReason;
  }): void {
    const mode = options?.mode || "discrete";
    this.dirtyRevision += 1;

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
    await this.flushPendingSaveWork({ force: true });
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
      globalThis.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveTimerMode = null;
    }
  }

  private startSaveTimer(mode: StudioProjectSessionAutosaveMode): void {
    this.saveTimerMode = mode;
    const delayMs = mode === "continuous" ? this.continuousDelayMs : this.discreteDelayMs;
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = null;
      this.saveTimerMode = null;
      void this.flushSave();
    }, delayMs);
  }

  private async flushSave(): Promise<void> {
    if (!this.projectPath) {
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
    const savePromise = (async () => {
      try {
        await this.options.saveProject(this.projectPath, this.project);
        const rawText = this.options.readProjectRawText
          ? await this.options.readProjectRawText(this.projectPath)
          : null;
        if (rawText != null) {
          this.markAcceptedProjectText(rawText, { trackExpectedWrite: true });
        }
        this.persistedRevision = Math.max(this.persistedRevision, revisionToPersist);
      } finally {
        this.saveInFlight = false;
        if (this.saveQueued || this.dirtyRevision !== this.persistedRevision) {
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
