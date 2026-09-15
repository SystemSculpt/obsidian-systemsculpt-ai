import { studioAgentExecution } from './StudioCommandExecution';
import type { StudioAgentRuns } from '../services/codex/StudioAgentRuns';
import { codexOptionsFromSettings, codexWorkingDirectory } from "../services/codex/CodexExecutionSettings";
import { StudioCodexRuns, codexRunKey } from '../services/codex/StudioCodexRuns';
import { answerCodexRequest } from '../services/codex/CodexRequestModal';
import { App, normalizePath, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { desktopHost } from "../platform/desktopOnly";
import { hasHostCapability } from "../platform/hostCapabilities";
import { StudioAssetStore } from "./StudioAssetStore";
import { StudioGraphCompiler, type StudioCompiledGraph } from "./StudioGraphCompiler";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { buildNodeInputFingerprint, StudioNodeResultCacheStore } from "./StudioNodeResultCacheStore";
import { StudioPermissionManager } from "./StudioPermissionManager";
import { StudioSandboxRunner } from "./StudioSandboxRunner";
import { StudioProjectStore } from "./StudioProjectStore";
import { planStudioRun } from "./StudioRunScope";
import type {
  StudioApiAdapter,
  StudioNodeCacheSnapshotV1,
  StudioManagedOperationRef,
  StudioNodeInputMap,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
  StudioRunOptions,
  StudioRunSnapshotV1,
  StudioRunSummary,
} from "./types";
import { deriveStudioRunsDir } from "./paths";
import { cloneStudioProjectSnapshot } from "./StudioProjectSnapshots";
import { nowIso, randomId } from "./utils";
import { StudioRunObserver } from "./StudioRunObserver";
import { assertStudioNodeHostAvailable } from "./StudioHostCapabilities";

type PendingRun = {
  runId: string;
  startedAt: string;
  execute: () => Promise<StudioRunSummary>;
  resolve: (summary: StudioRunSummary) => void;
  reject: (error: unknown) => void;
};

const CONCURRENCY_LIMITS = {
  api: 2,
  local_io: 2,
  local_cpu: 1,
} as const;

const MAX_RECOVERY_EVENT_LOG_BYTES = 8 * 1024 * 1024;

const PREVIEWABLE_MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".avif",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".mpeg",
  ".mpg",
]);

export class StudioRuntime {
  private readonly codexRuns = new StudioCodexRuns();
  dispose(): void { this.codexRuns.dispose(); }
  private readonly projectQueues = new Map<string, PendingRun[]>();
  private readonly activeProjects = new Set<string>();
  private readonly nodeResultCacheStore: StudioNodeResultCacheStore;
  readonly runs = new StudioRunObserver((error) => {
    this.plugin.getLogger().warn("Studio run observer failed", { source: "StudioRuntime", metadata: { error: String(error) } });
  });

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    private readonly projectStore: StudioProjectStore,
    private readonly registry: StudioNodeRegistry,
    private readonly compiler: StudioGraphCompiler,
    private readonly assetStore: StudioAssetStore,
    private readonly apiAdapter: StudioApiAdapter,
    private readonly agentRuns?: StudioAgentRuns
  ) {
    this.nodeResultCacheStore = new StudioNodeResultCacheStore(projectStore);
  }

  private runIndexPath(projectPath: string): string {
    return normalizePath(`${deriveStudioRunsDir(projectPath)}/index.json`);
  }

  private async readRunIndex(projectPath: string): Promise<StudioRunSummary[]> {
    const indexPath = this.runIndexPath(projectPath);
    const bytes = await this.projectStore.readSupportFile(projectPath, indexPath);
    if (!bytes) return [];

    try {
      const raw = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          runId: String(entry.runId || ""),
          status: String(entry.status || "failed") as StudioRunSummary["status"],
          startedAt: String(entry.startedAt || ""),
          finishedAt: entry.finishedAt ? String(entry.finishedAt) : null,
          error: entry.error ? String(entry.error) : null,
          executedNodeIds: Array.isArray(entry.executedNodeIds)
            ? entry.executedNodeIds.map((nodeId: unknown) => String(nodeId || "")).filter(Boolean)
            : [],
          cachedNodeIds: Array.isArray(entry.cachedNodeIds)
            ? entry.cachedNodeIds.map((nodeId: unknown) => String(nodeId || "")).filter(Boolean)
            : [],
        }))
        .filter((entry) => entry.runId.length > 0);
    } catch {
      return [];
    }
  }

  async getRecentRuns(projectPath: string): Promise<StudioRunSummary[]> {
    const index = await this.readRunIndex(projectPath);
    await this.retryPublishedTranscriptionCleanup(projectPath, index);
    return index.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private async retryPublishedTranscriptionCleanup(
    projectPath: string,
    index: readonly StudioRunSummary[] = [],
  ): Promise<void> {
    const runs = index.length > 0 ? index : await this.readRunIndex(projectPath);
    const operations = new Map<string, StudioManagedOperationRef>();
    for (const run of runs) {
      const eventsPath = normalizePath(
        `${deriveStudioRunsDir(projectPath)}/${run.runId}/events.ndjson`,
      );
      const bytes = await this.projectStore.readSupportFile(projectPath, eventsPath);
      if (!bytes || bytes.byteLength > MAX_RECOVERY_EVENT_LOG_BYTES) continue;
      for (const line of new TextDecoder().decode(bytes).split("\n")) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !event
          || typeof event !== "object"
          || (event as { type?: unknown }).type !== "node.output"
          || !Array.isArray((event as { managedOperations?: unknown }).managedOperations)
        ) continue;
        for (const operation of (event as { managedOperations: unknown[] }).managedOperations) {
          if (
            !operation
            || typeof operation !== "object"
            || (operation as { capability?: unknown }).capability !== "transcription"
          ) continue;
          const operationId = (operation as { operationId?: unknown }).operationId;
          if (
            typeof operationId !== "string"
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)
          ) continue;
          operations.set(operationId, { capability: "transcription", operationId });
        }
      }
    }
    if (operations.size === 0) return;
    try {
      await this.apiAdapter.completeLocalCommit([...operations.values()]);
    } catch (error) {
      this.plugin.getLogger().warn("Studio published transcription cleanup remains pending", {
        source: "StudioRuntime",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * The most recent output each node produced in a retained run. Covers
   * projects whose never-cached nodes ran before every node's latest output
   * was recorded in the cache: a generated image already on the canvas must
   * feed a single-node run instead of being regenerated.
   */
  private async recordedOutputsFromRuns(projectPath: string, nodeIds: Set<string>): Promise<Map<string, StudioNodeOutputMap>> {
    const found = new Map<string, StudioNodeOutputMap>();
    if (nodeIds.size === 0) return found;
    const runs = (await this.readRunIndex(projectPath)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const run of runs) {
      if (found.size === nodeIds.size) break;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(run.runId)) continue;
      const bytes = await this.projectStore.readSupportFile(projectPath, normalizePath(`${deriveStudioRunsDir(projectPath)}/${run.runId}/events.ndjson`));
      if (!bytes || bytes.byteLength > MAX_RECOVERY_EVENT_LOG_BYTES) continue;
      const lines = new TextDecoder().decode(bytes).split("\n");
      // Newest event first: the last output a node produced in that run wins.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].trim()) continue;
        let event: { type?: unknown; nodeId?: unknown; outputs?: unknown };
        try { event = JSON.parse(lines[index]); } catch { continue; }
        if (event?.type !== "node.output" || typeof event.nodeId !== "string" || !nodeIds.has(event.nodeId) || found.has(event.nodeId)) continue;
        if (!event.outputs || typeof event.outputs !== "object" || Array.isArray(event.outputs)) continue;
        found.set(event.nodeId, event.outputs as StudioNodeOutputMap);
      }
    }
    return found;
  }

  async getNodeCacheSnapshot(projectPath: string): Promise<StudioNodeCacheSnapshotV1> {
    const normalizedPath = normalizePath(projectPath);
    const project = await this.projectStore.loadProject(normalizedPath);
    return this.nodeResultCacheStore.load(normalizedPath, project.projectId);
  }

  async getLatestRunEvents(projectPath: string): Promise<StudioRunEvent[]> {
    const path = normalizePath(projectPath);
    const latest = (await this.readRunIndex(path)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!latest || !/^[A-Za-z0-9_-]{1,128}$/.test(latest.runId)) return [];
    const bytes = await this.projectStore.readSupportFile(path, normalizePath(`${deriveStudioRunsDir(path)}/${latest.runId}/events.ndjson`));
    if (!bytes || bytes.byteLength > MAX_RECOVERY_EVENT_LOG_BYTES) return [];
    const events: StudioRunEvent[] = [];
    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StudioRunEvent;
        if (event?.runId !== latest.runId || typeof event.at !== "string") continue;
        if (!["run.started", "run.failed", "run.completed", "node.started", "node.progress", "node.cache_hit", "node.output", "node.failed"].includes(event.type)) continue;
        if (event.type.startsWith("node.") && !("nodeId" in event && typeof event.nodeId === "string")) continue;
        events.push(event);
      } catch { /* A damaged history line must not hide intact outputs. */ }
    }
    return events;
  }

  private async enqueueRun(
    projectPath: string,
    project: StudioProjectV1,
    options?: StudioRunOptions
  ): Promise<StudioRunSummary> {
    const normalizedPath = normalizePath(projectPath);
    const queuedProject = cloneStudioProjectSnapshot(project);
    const runId = randomId("run");
    const startedAt = nowIso();
    const scopedEntryNodeIds = Array.from(
      new Set((options?.entryNodeIds || []).map((nodeId) => String(nodeId || "").trim()).filter(Boolean))
    );
    const scopedForceNodeIds = Array.from(
      new Set((options?.forceNodeIds || []).map((nodeId) => String(nodeId || "").trim()).filter(Boolean))
    );
    const onEvent = typeof options?.onEvent === "function" ? options.onEvent : undefined;

    return await new Promise<StudioRunSummary>((resolve, reject) => {
      const pending: PendingRun = {
        runId,
        startedAt,
        execute: async () => {
          const plan = planStudioRun(queuedProject, scopedEntryNodeIds, (node) => this.registry.get(node.kind, node.version)?.cachePolicy);
          this.runs.begin({
            projectPath: normalizedPath, runId,
            nodeIds: plan.executeNodeIds,
            fromNodeId: scopedEntryNodeIds[0] || null,
          });
          try {
            return await this.executeRun(normalizedPath, queuedProject, runId, startedAt, {
              entryNodeIds: scopedEntryNodeIds.length > 0 ? scopedEntryNodeIds : undefined,
              forceNodeIds: scopedForceNodeIds.length > 0 ? scopedForceNodeIds : undefined,
              onEvent,
            });
          } catch (error) {
            // Includes validation and local publication failures before a terminal event.
            this.runs.publish(normalizedPath, { type: "run.failed", runId, error: String(error instanceof Error ? error.message : error), at: nowIso() });
            this.runs.publish(normalizedPath, { type: "run.completed", runId, status: "failed", at: nowIso() });
            throw error;
          }
        },
        resolve,
        reject,
      };

      const queue = this.projectQueues.get(normalizedPath) || [];
      queue.push(pending);
      this.projectQueues.set(normalizedPath, queue);
      this.drainQueue(normalizedPath).catch((error) => {
        this.plugin.getLogger().error("Studio queue drain failed", error, {
          source: "StudioRuntime",
        });
      });
    });
  }

  async runProject(projectPath: string, options?: StudioRunOptions): Promise<StudioRunSummary> {
    const normalizedPath = normalizePath(projectPath);
    const project = await this.projectStore.loadProject(normalizedPath);
    return await this.enqueueRun(normalizedPath, project, options);
  }

  async runProjectSnapshot(
    projectPath: string,
    project: StudioProjectV1,
    options?: StudioRunOptions
  ): Promise<StudioRunSummary> {
    return await this.enqueueRun(projectPath, project, options);
  }

  private async drainQueue(projectPath: string): Promise<void> {
    if (this.activeProjects.has(projectPath)) return;
    const queue = this.projectQueues.get(projectPath);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    this.activeProjects.add(projectPath);
    try {
      const summary = await next.execute();
      next.resolve(summary);
    } catch (error) {
      next.reject(error);
    } finally {
      this.activeProjects.delete(projectPath);
      if (queue.length === 0) {
        this.projectQueues.delete(projectPath);
      }
      await this.drainQueue(projectPath);
    }
  }

  private mapNodeInputs(compiled: StudioCompiledGraph, nodeId: string, outputsByNode: Map<string, StudioNodeOutputMap>): StudioNodeInputMap {
    const current = compiled.nodesById.get(nodeId);
    if (!current) return {};
    const inputs: StudioNodeInputMap = {};
    for (const edge of current.inboundEdges) {
      const fromOutputs = outputsByNode.get(edge.fromNodeId);
      if (!fromOutputs) continue;
      const value = fromOutputs[edge.fromPortId];
      if (typeof value === "undefined") continue;

      if (Object.prototype.hasOwnProperty.call(inputs, edge.toPortId)) {
        const existing = inputs[edge.toPortId];
        if (Array.isArray(existing)) {
          (existing as unknown[]).push(value);
          inputs[edge.toPortId] = existing;
        } else {
          inputs[edge.toPortId] = [existing, value];
        }
      } else {
        inputs[edge.toPortId] = value;
      }
    }
    return inputs;
  }

  private isAbsoluteFilesystemPath(path: string): boolean {
    const normalized = String(path || "").trim().replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  }

  private isPreviewableMediaPath(path: string): boolean {
    const normalized = String(path || "").trim();
    if (!normalized) {
      return false;
    }
    const withoutQuery = normalized.split(/[?#]/, 1)[0];
    const dot = withoutQuery.lastIndexOf(".");
    if (dot < 0) {
      return false;
    }
    const extension = withoutQuery.slice(dot).toLowerCase();
    return PREVIEWABLE_MEDIA_EXTENSIONS.has(extension);
  }

  private shouldBypassCacheForMediaIngestPreview(options: {
    nodeKind: string;
    outputs: StudioNodeOutputMap | null | undefined;
  }): boolean {
    if (options.nodeKind !== "studio.media_ingest") {
      return false;
    }
    const outputs = options.outputs || {};
    const previewPath = typeof outputs.preview_path === "string" ? outputs.preview_path.trim() : "";
    if (previewPath) {
      return false;
    }
    const previewError = typeof outputs.preview_error === "string" ? outputs.preview_error.trim() : "";
    if (previewError) {
      return false;
    }
    const outputPath = typeof outputs.path === "string" ? outputs.path.trim() : "";
    if (!outputPath) {
      return false;
    }
    if (!this.isAbsoluteFilesystemPath(outputPath)) {
      return false;
    }
    return this.isPreviewableMediaPath(outputPath);
  }

  private async executeRun(
    projectPath: string,
    fullProject: StudioProjectV1,
    runId: string,
    startedAt: string,
    options?: StudioRunOptions
  ): Promise<StudioRunSummary> {
    await this.retryPublishedTranscriptionCleanup(projectPath);
    const plan = planStudioRun(cloneStudioProjectSnapshot(fullProject), options?.entryNodeIds, (node) => this.registry.get(node.kind, node.version)?.cachePolicy);
    const project = plan.project;
    const providedNodeIds = new Set(plan.providedNodeIds);
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    const permissions = new StudioPermissionManager(policy);
    const sandbox = new StudioSandboxRunner(permissions);
    const compiled = this.compiler.compile(project, this.registry);

    const snapshot: StudioRunSnapshotV1 = {
      schema: "studio.run.v1",
      runId,
      projectPath,
      projectId: project.projectId,
      createdAt: startedAt,
      project,
      policy,
    };

    const persistedEvents: string[] = [];
    const stagedAssetFiles = new Map<string, Uint8Array>();
    const stagedAssetBytesByProjectionPath = new Map<string, Uint8Array>();

    const notify = async (event: StudioRunEvent): Promise<void> => {
      this.runs.publish(projectPath, event);
      if (typeof options?.onEvent === "function") {
        try {
          await options.onEvent(event);
        } catch (callbackError) {
          this.plugin.getLogger().warn("Studio run event callback failed", {
            source: "StudioRuntime",
            metadata: {
              runId,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            },
          });
        }
      }
    };

    const emit = async (event: StudioRunEvent): Promise<void> => {
      persistedEvents.push(`${JSON.stringify(event)}\n`);
      await notify(event);
    };

    await emit({
      type: "run.started",
      runId,
      at: nowIso(),
    });

    const nodeCacheSnapshot = await this.nodeResultCacheStore.load(projectPath, project.projectId);
    const forceNodeIds = new Set(
      (options?.forceNodeIds || [])
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0 && compiled.nodesById.has(nodeId))
    );
    const executedNodeIds: string[] = [];
    const cachedNodeIds: string[] = [];
    const managedOperations = new Map<string, StudioManagedOperationRef>();

    const outputsByNode = new Map<string, StudioNodeOutputMap>();
    const dependencyCount = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const state = new Map<string, "pending" | "running" | "done" | "failed" | "skipped">();
    const runningByClass = {
      api: 0,
      local_io: 0,
      local_cpu: 0,
    };
    const runningPromises = new Map<string, Promise<void>>();
    const abortController = new AbortController();
    const desktop = hasHostCapability("local-filesystem")
      ? await (async () => {
          const [fs, path, os] = await Promise.all([
            desktopHost.fs(),
            desktopHost.path(),
            desktopHost.os(),
          ]);
          return { fs, path, os };
        })()
      : null;
    const tempRootDir = desktop
      ? await desktop.fs.mkdtemp(desktop.path.join(desktop.os.tmpdir(), "systemsculpt-studio-"))
      : "";

    for (const [nodeId, node] of compiled.nodesById.entries()) {
      dependencyCount.set(nodeId, node.dependencyNodeIds.length);
      state.set(nodeId, "pending");
      for (const depId of node.dependencyNodeIds) {
        const list = dependents.get(depId) || [];
        list.push(nodeId);
        dependents.set(depId, list);
      }
    }

    let fatalError: unknown = null;

    const markDependentsReady = (nodeId: string): void => {
      const next = dependents.get(nodeId) || [];
      for (const dependentNodeId of next) {
        const prev = dependencyCount.get(dependentNodeId) || 0;
        dependencyCount.set(dependentNodeId, Math.max(0, prev - 1));
      }
    };

    // Nodes that produce nothing because they are disabled, or because a
    // disabled node starved one of their required inputs. Provided nodes are
    // parked in the same "skipped" state but carry recorded outputs, so they
    // are deliberately not tracked here.
    const skippedUpstream = new Set<string>();

    const skipNode = (nodeId: string): void => {
      state.set(nodeId, "skipped");
      skippedUpstream.add(nodeId);
      dependencyCount.set(nodeId, 0);
      markDependentsReady(nodeId);
    };

    /**
     * The required input port, if any, whose every producer was skipped.
     *
     * A disabled node used to leave its downstream port simply absent from the
     * input map, so the dependent ran on partial data: it either failed deep
     * inside an adapter with an unrelated message, or produced output from an
     * input the user had switched off. Skips propagate instead.
     */
    const starvedRequiredPort = (nodeId: string): string | null => {
      const compiledNode = compiled.nodesById.get(nodeId);
      if (!compiledNode) return null;
      for (const port of compiledNode.definition.inputPorts) {
        if (port.required !== true) continue;
        const feeding = compiledNode.inboundEdges.filter((edge) => edge.toPortId === port.id);
        if (feeding.length === 0) continue;
        if (feeding.every((edge) => skippedUpstream.has(edge.fromNodeId))) return port.id;
      }
      return null;
    };

    // Provided nodes never execute here: their latest recorded outputs stand
    // in, exactly as they were produced last time. A missing record surfaces
    // when a dependent starts, naming the node to run first.
    const unrecorded = new Set<string>();
    for (const nodeId of providedNodeIds) {
      if (!compiled.nodesById.has(nodeId)) continue;
      const entry = nodeCacheSnapshot.entries[nodeId];
      if (entry) outputsByNode.set(nodeId, entry.outputs || {});
      else unrecorded.add(nodeId);
      state.set(nodeId, "skipped");
      markDependentsReady(nodeId);
    }
    for (const [nodeId, outputs] of await this.recordedOutputsFromRuns(projectPath, unrecorded)) {
      outputsByNode.set(nodeId, outputs);
    }

    const startNode = (nodeId: string): void => {
      const compiledNode = compiled.nodesById.get(nodeId)!;
      const nodeClass = compiledNode.definition.capabilityClass;
      runningByClass[nodeClass] += 1;
      state.set(nodeId, "running");

      const promise = (async () => {
        assertStudioNodeHostAvailable(compiledNode.definition);
        for (const edge of compiledNode.inboundEdges) {
          if (!providedNodeIds.has(edge.fromNodeId) || outputsByNode.has(edge.fromNodeId)) continue;
          const upstream = compiled.nodesById.get(edge.fromNodeId)?.node;
          throw new Error(`Run "${upstream?.title || edge.fromNodeId}" first. It has no output yet, and Studio does not rerun it on your behalf.`);
        }
        const inputs = this.mapNodeInputs(compiled, nodeId, outputsByNode);
        const cachePolicy = compiledNode.definition.cachePolicy || "by_inputs";
        // Every node records its latest outputs; only by-inputs nodes reuse them.
        const inputFingerprint = await buildNodeInputFingerprint(compiledNode.node, inputs);

        if (cachePolicy === "by_inputs" && !forceNodeIds.has(nodeId)) {
          const cacheEntry = nodeCacheSnapshot.entries[nodeId];
          if (
            cacheEntry &&
            cacheEntry.nodeKind === compiledNode.node.kind &&
            cacheEntry.nodeVersion === compiledNode.node.version &&
            cacheEntry.inputFingerprint === inputFingerprint &&
            !this.shouldBypassCacheForMediaIngestPreview({
              nodeKind: compiledNode.node.kind,
              outputs: cacheEntry.outputs || {},
            })
          ) {
            outputsByNode.set(nodeId, cacheEntry.outputs || {});
            state.set(nodeId, "done");
            cachedNodeIds.push(nodeId);
            await emit({
              type: "node.cache_hit",
              runId,
              nodeId,
              cacheUpdatedAt: cacheEntry.updatedAt,
              at: nowIso(),
            });
            await emit({
              type: "node.output",
              runId,
              nodeId,
              outputRef: `${runId}:${nodeId}:cache`,
              outputSource: "cache",
              outputs: cacheEntry.outputs || {},
              at: nowIso(),
            });
            markDependentsReady(nodeId);
            return;
          }
        }

        await emit({ type: "node.started", runId, nodeId, at: nowIso() });
        const result = await compiledNode.definition.execute({
          projectId: project.projectId,
          runId,
          projectPath,
          node: compiledNode.node,
          inputs,
          signal: abortController.signal,
          services: {
            codex: (input, signal, log) => this.agentRuns ? this.agentRuns.run({ projectId: project.projectId, projectPath, nodeId, title: compiledNode.node.title, request: { ...input, ...studioAgentExecution(project.graph.nodes, nodeId, { ...codexOptionsFromSettings(this.plugin.settings), ...input }) } }, signal) : this.codexRuns.run(codexRunKey(project.projectId, nodeId), { ...input, ...studioAgentExecution(project.graph.nodes, nodeId, { ...codexOptionsFromSettings(this.plugin.settings), ...input }), workingDirectory: codexWorkingDirectory(this.app, input.workingDirectory) }, signal, { log, thread: () => {}, request: (method, params, requestSignal) => answerCodexRequest(this.app, method, params, requestSignal) }),
            api: this.apiAdapter,
            storeAsset: async (bytes, mimeType) => {
              const staged = await this.assetStore.stageArrayBuffer(projectPath, bytes, mimeType);
              stagedAssetFiles.set(staged.generationFile.contentAddressedPath, staged.generationFile.bytes);
              stagedAssetBytesByProjectionPath.set(staged.asset.path, staged.generationFile.bytes);
              return staged.asset;
            },
            readAsset: (asset) => {
              const staged = stagedAssetBytesByProjectionPath.get(asset.path);
              return staged ? Promise.resolve(staged.slice().buffer) : this.assetStore.readArrayBuffer(asset);
            },
            resolveAbsolutePath: (path) => {
              if (!desktop) {
                throw new Error("Local filesystem paths require Obsidian Desktop.");
              }
              const normalized = String(path || "").trim();
              if (!normalized) {
                throw new Error("Filesystem path cannot be empty.");
              }
              if (desktop.path.isAbsolute(normalized)) {
                permissions.assertFilesystemPath(normalized);
                return normalized;
              }

              const vaultPath = normalizePath(normalized);
              permissions.assertFilesystemPath(vaultPath);
              const adapter = this.app.vault.adapter as {
                getFullPath?: (relativePath: string) => string;
                basePath?: unknown;
              };
              if (typeof adapter.getFullPath === "function") {
                return adapter.getFullPath(vaultPath);
              }
              if (typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
                return desktop.path.join(adapter.basePath, vaultPath);
              }
              throw new Error(
                `Unable to resolve an absolute path for "${vaultPath}". Desktop FileSystemAdapter is required.`
              );
            },
            readVaultText: async (vaultPath: string) => {
              permissions.assertFilesystemPath(vaultPath);
              const file = this.app.vault.getAbstractFileByPath(vaultPath);
              if (!(file instanceof TFile)) {
                throw new Error(`Vault file not found: ${vaultPath}`);
              }
              if (!file.path.toLowerCase().endsWith(".md")) {
                throw new Error(`Vault markdown file required: ${vaultPath}`);
              }
              return this.app.vault.cachedRead(file);
            },
            statVaultFileSize: async (vaultPath: string) => {
              permissions.assertFilesystemPath(vaultPath);
              const staged = stagedAssetBytesByProjectionPath.get(normalizePath(vaultPath));
              if (staged) return staged.byteLength;
              const file = this.app.vault.getAbstractFileByPath(vaultPath);
              if (!(file instanceof TFile)) {
                throw new Error(`Vault file not found: ${vaultPath}`);
              }
              const size = Number(file.stat?.size);
              if (!Number.isFinite(size)) {
                throw new Error(`Unable to determine vault file size: ${vaultPath}`);
              }
              return size;
            },
            readVaultBinary: async (vaultPath: string) => {
              permissions.assertFilesystemPath(vaultPath);
              const staged = stagedAssetBytesByProjectionPath.get(normalizePath(vaultPath));
              if (staged) return staged.slice().buffer;
              const file = this.app.vault.getAbstractFileByPath(vaultPath);
              if (!(file instanceof TFile)) {
                throw new Error(`Vault file not found: ${vaultPath}`);
              }
              return this.app.vault.readBinary(file);
            },
            statLocalFileSize: async (absolutePath: string) => {
              const normalized = String(absolutePath || "").trim();
              if (!desktop) {
                throw new Error("Local filesystem reads require Obsidian Desktop.");
              }
              if (!normalized) {
                throw new Error("Local filesystem read path is empty.");
              }
              if (!desktop.path.isAbsolute(normalized)) {
                throw new Error(
                  `Local filesystem read requires an absolute path. Received "${normalized}".`
                );
              }
              permissions.assertFilesystemPath(normalized);
              const stat = await desktop.fs.stat(normalized);
              const size = Number(stat.size);
              if (!Number.isFinite(size)) {
                throw new Error(`Unable to determine local file size: ${normalized}`);
              }
              return size;
            },
            readLocalFileBinary: async (absolutePath: string, maxBytes?: number) => {
              const normalized = String(absolutePath || "").trim();
              if (!desktop) {
                throw new Error("Local filesystem reads require Obsidian Desktop.");
              }
              if (!normalized) {
                throw new Error("Local filesystem read path is empty.");
              }
              if (!desktop.path.isAbsolute(normalized)) {
                throw new Error(
                  `Local filesystem read requires an absolute path. Received "${normalized}".`
                );
              }
              permissions.assertFilesystemPath(normalized);
              // Bounded process manifests/artifacts: read at most limit+1, even if a writer grows the file after stat.
              if (typeof maxBytes === "number") {
                if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error("Invalid local file read limit.");
                const handle = await desktop.fs.open(normalized, "r");
                try {
                  const stat = await handle.stat();
                  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Local file exceeds the configured size limit or is not a regular file.");
                  const bytes = new Uint8Array(Math.min(maxBytes + 1, stat.size + 1));
                  let offset = 0;
                  while (offset < bytes.length) {
                    const result = await handle.read(bytes, offset, bytes.length - offset, null);
                    if (result.bytesRead === 0) break;
                    offset += result.bytesRead;
                  }
                  if (offset > maxBytes || offset > stat.size) throw new Error("Local file changed or exceeds the configured size limit.");
                  return bytes.slice(0, offset).buffer;
                } finally { await handle.close(); }
              }
              const bytes = await desktop.fs.readFile(normalized);
              return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
              ) as ArrayBuffer;
            },
            writeTempFile: async (bytes, tempOptions) => {
              if (!desktop || !tempRootDir) {
                throw new Error("Temporary local files require Obsidian Desktop.");
              }
              const prefix = String(tempOptions?.prefix || "studio-node")
                .trim()
                .replace(/[^a-zA-Z0-9-_]+/g, "-")
                .replace(/^-+|-+$/g, "") || "studio-node";
              const ext = String(tempOptions?.extension || "")
                .trim()
                .replace(/^[.]+/, "")
                .replace(/[^a-zA-Z0-9]+/g, "");
              const suffix = ext ? `.${ext}` : "";
              const tempPath = desktop.path.join(
                tempRootDir,
                `${prefix}-${randomId("tmp")}${suffix}`
              );
              await desktop.fs.writeFile(tempPath, new Uint8Array(bytes));
              return tempPath;
            },
            deleteLocalFile: async (absolutePath: string) => {
              const normalized = String(absolutePath || "").trim();
              if (!normalized) {
                return;
              }
              if (!desktop) {
                return;
              }
              try {
                await desktop.fs.unlink(normalized);
              } catch {
                // Best effort cleanup.
              }
            },
            runCli: (request) => sandbox.runCli(request),
            assertFilesystemPath: (path) => permissions.assertFilesystemPath(path),
          },
          reportProgress: (percent, message) => {
            void emit({ type: "node.progress", runId, nodeId, percent, message, at: nowIso() }).catch((error) => {
              this.plugin.getLogger().debug("Studio progress could not be recorded", { source: "StudioRuntime", metadata: { error: String(error) } });
            });
          },
          log: (message) => {
            this.plugin.getLogger().debug("Studio node log", {
              source: "StudioRuntime",
              metadata: {
                runId,
                nodeId,
                message,
              },
            });
          },
        });

        outputsByNode.set(nodeId, result.outputs);
        for (const operation of result.managedOperations || []) {
          managedOperations.set(`${operation.capability}:${operation.operationId}`, operation);
        }
        state.set(nodeId, "done");
        executedNodeIds.push(nodeId);
        nodeCacheSnapshot.entries[nodeId] = {
          nodeId,
          nodeKind: compiledNode.node.kind,
          nodeVersion: compiledNode.node.version,
          inputFingerprint,
          outputs: result.outputs,
          artifacts: result.artifacts,
          updatedAt: nowIso(),
          runId,
        };
        await emit({
          type: "node.output",
          runId,
          nodeId,
          outputRef: `${runId}:${nodeId}`,
          outputSource: "execution",
          outputs: result.outputs,
          ...(result.managedOperations?.length
            ? { managedOperations: result.managedOperations }
            : {}),
          at: nowIso(),
        });

        markDependentsReady(nodeId);
      })()
        .catch(async (error) => {
          state.set(nodeId, "failed");
          const message = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? (error.stack || undefined) : undefined;
          await emit({
            type: "node.failed",
            runId,
            nodeId,
            error: message,
            errorStack,
            at: nowIso(),
          });

          if (compiledNode.node.continueOnError === true) {
            outputsByNode.set(nodeId, {});
            state.set(nodeId, "done");
            markDependentsReady(nodeId);
            return;
          }

          if (fatalError === null) {
            fatalError = error instanceof Error ? error : new Error(String(error));
            abortController.abort();
          }
        })
        .finally(() => {
          runningByClass[nodeClass] -= 1;
          runningPromises.delete(nodeId);
        });

      runningPromises.set(nodeId, promise);
    };

    const canStartNode = (nodeId: string): boolean => {
      const compiledNode = compiled.nodesById.get(nodeId)!;
      if (compiledNode.node.disabled === true || starvedRequiredPort(nodeId) !== null) {
        skipNode(nodeId);
        return false;
      }
      const classLimit = CONCURRENCY_LIMITS[compiledNode.definition.capabilityClass];
      const current = runningByClass[compiledNode.definition.capabilityClass];
      return current < classLimit;
    };

    try {
      while (true) {
        if (fatalError) break;

        let startedAny = false;
        for (const nodeId of compiled.executionOrder) {
          const currentState = state.get(nodeId);
          if (currentState !== "pending") continue;
          if ((dependencyCount.get(nodeId) || 0) > 0) continue;
          if (!canStartNode(nodeId)) continue;
          startedAny = true;
          startNode(nodeId);
        }

        if (runningPromises.size === 0) {
          if (!startedAny) {
            break;
          }
        }

        if (runningPromises.size > 0) {
          await Promise.race(Array.from(runningPromises.values()));
          continue;
        }

        const unfinished = Array.from(state.values()).some(
          (value) => value === "pending" || value === "running"
        );
        if (!unfinished) {
          break;
        }
      }

      await Promise.allSettled(Array.from(runningPromises.values()));
    } finally {
      if (tempRootDir) {
        try {
          await desktop!.fs.rm(tempRootDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
      }
    }

    // The scheduler only exits with work outstanding when nothing was
    // runnable — a dependency it can never satisfy. Reporting that as a
    // success would hide a stuck graph behind a green run.
    if (fatalError === null) {
      const stalled = Array.from(state.entries())
        .filter(([, nodeState]) => nodeState === "pending" || nodeState === "running")
        .map(([nodeId]) => compiled.nodesById.get(nodeId)?.node.title || nodeId);
      if (stalled.length > 0) {
        fatalError = new Error(
          `Studio run stopped before finishing: ${stalled.join(", ")} never ran. `
          + "The graph has a dependency the scheduler cannot satisfy.",
        );
      }
    }

    let status: StudioRunSummary["status"] = "success";
    let errorMessage: string | null = null;
    if (fatalError !== null) {
      const fatalMessage =
        fatalError instanceof Error ? fatalError.message : String(fatalError);
      const fatalStack = fatalError instanceof Error ? (fatalError.stack || undefined) : undefined;
      status = "failed";
      errorMessage = fatalMessage;
      await emit({
        type: "run.failed",
        runId,
        error: fatalMessage,
        errorStack: fatalStack,
        at: nowIso(),
      });
    }

    const completedEvent: StudioRunEvent = {
      type: "run.completed",
      runId,
      status: status === "success" ? "success" : "failed",
      at: nowIso(),
    };
    // Save the terminal record with its assets, then announce that they are ready.
    persistedEvents.push(`${JSON.stringify(completedEvent)}\n`);

    const summary: StudioRunSummary = {
      runId,
      status,
      startedAt,
      finishedAt: nowIso(),
      error: errorMessage,
      executedNodeIds,
      cachedNodeIds,
    };

    const currentRuns = await this.readRunIndex(projectPath);
    currentRuns.push(summary);
    const sortedRuns = [...currentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const retainedRuns = sortedRuns.slice(Math.max(0, sortedRuns.length - project.settings.retention.maxRuns));
    const retainedIds = new Set(retainedRuns.map((run) => run.runId));
    nodeCacheSnapshot.updatedAt = nowIso();
    const managedOperationRefs = [...managedOperations.values()];
    await this.apiAdapter.beginLocalCommit(managedOperationRefs);
    await this.projectStore.publishRun(projectPath, {
      projectId: project.projectId,
      runId,
      snapshotDocument: new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`),
      eventsDocument: new TextEncoder().encode(persistedEvents.join("")),
      runIndexDocument: new TextEncoder().encode(`${JSON.stringify(retainedRuns, null, 2)}\n`),
      cacheDocument: new TextEncoder().encode(`${JSON.stringify(nodeCacheSnapshot, null, 2)}\n`),
      assets: [...stagedAssetFiles].map(([contentAddressedPath, bytes]) => ({ contentAddressedPath, bytes })),
      removeRunIds: currentRuns.filter((run) => !retainedIds.has(run.runId)).map((run) => run.runId),
    });
    try {
      await this.apiAdapter.completeLocalCommit(managedOperationRefs);
    } catch (error) {
      this.plugin.getLogger().warn("Studio managed-operation cleanup remains pending after run publication", {
        source: "StudioRuntime",
        metadata: {
          runId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    await notify(completedEvent);
    if (status === "failed") {
      throw new Error(errorMessage || "Studio run failed.");
    }

    return summary;
  }
}
