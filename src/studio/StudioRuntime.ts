import { App, normalizePath, Platform, TFile } from "obsidian";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import type SystemSculptPlugin from "../main";
import { StudioAssetStore } from "./StudioAssetStore";
import { StudioGraphCompiler, type StudioCompiledGraph } from "./StudioGraphCompiler";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { buildNodeInputFingerprint, StudioNodeResultCacheStore } from "./StudioNodeResultCacheStore";
import { StudioPermissionManager } from "./StudioPermissionManager";
import { StudioSandboxRunner } from "./StudioSandboxRunner";
import { StudioSecretStore } from "./StudioSecretStore";
import { StudioProjectStore } from "./StudioProjectStore";
import { scopeProjectForRun } from "./StudioRunScope";
import type {
  StudioApiAdapter,
  StudioNodeCacheSnapshotV1,
  StudioNodeInputMap,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
  StudioRunOptions,
  StudioRunSnapshotV1,
  StudioRunSummary,
} from "./types";
import { deriveStudioRunsDir } from "./paths";
import { nowIso, randomId } from "./utils";
import { sha256HexFromArrayBuffer } from "./hash";

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
  private readonly projectQueues = new Map<string, PendingRun[]>();
  private readonly activeProjects = new Set<string>();
  private readonly nodeResultCacheStore: StudioNodeResultCacheStore;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    private readonly projectStore: StudioProjectStore,
    private readonly registry: StudioNodeRegistry,
    private readonly compiler: StudioGraphCompiler,
    private readonly assetStore: StudioAssetStore,
    private readonly apiAdapter: StudioApiAdapter
  ) {
    this.nodeResultCacheStore = new StudioNodeResultCacheStore(app);
  }

  private get adapter() {
    return this.app.vault.adapter as any;
  }

  private async ensureDir(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        const exists = await this.adapter.exists(current);
        if (!exists) {
          await this.adapter.mkdir(current);
        }
      } catch {}
    }
  }

  private async appendLine(path: string, line: string): Promise<void> {
    if (typeof this.adapter.append === "function") {
      await this.adapter.append(path, line);
      return;
    }

    const exists = await this.adapter.exists(path);
    const previous = exists ? await this.adapter.read(path) : "";
    await this.adapter.write(path, `${previous}${line}`);
  }

  private runIndexPath(projectPath: string): string {
    return normalizePath(`${deriveStudioRunsDir(projectPath)}/index.json`);
  }

  private async readRunIndex(projectPath: string): Promise<StudioRunSummary[]> {
    const indexPath = this.runIndexPath(projectPath);
    const exists = await this.adapter.exists(indexPath);
    if (!exists) return [];

    try {
      const raw = await this.adapter.read(indexPath);
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

  private async writeRunIndex(projectPath: string, runs: StudioRunSummary[]): Promise<void> {
    const path = this.runIndexPath(projectPath);
    await this.ensureDir(path.slice(0, path.lastIndexOf("/")));
    await this.adapter.write(path, `${JSON.stringify(runs, null, 2)}\n`);
  }

  private async pruneRunRetention(projectPath: string, maxRuns: number): Promise<void> {
    const runs = await this.readRunIndex(projectPath);
    if (runs.length <= maxRuns) return;

    const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const toDrop = sorted.slice(0, sorted.length - maxRuns);
    const keepSet = new Set(sorted.slice(sorted.length - maxRuns).map((run) => run.runId));
    const retained = runs.filter((run) => keepSet.has(run.runId));

    const runsDir = deriveStudioRunsDir(projectPath);
    for (const dropped of toDrop) {
      const runDir = normalizePath(`${runsDir}/${dropped.runId}`);
      try {
        if (typeof this.adapter.rmdir === "function") {
          await this.adapter.rmdir(runDir, true);
        } else if (typeof this.adapter.remove === "function") {
          await this.adapter.remove(runDir);
        }
      } catch {}
    }

    await this.writeRunIndex(projectPath, retained);
  }

  async getRecentRuns(projectPath: string): Promise<StudioRunSummary[]> {
    const index = await this.readRunIndex(projectPath);
    return index.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getNodeCacheSnapshot(projectPath: string): Promise<StudioNodeCacheSnapshotV1> {
    const normalizedPath = normalizePath(projectPath);
    const project = await this.projectStore.loadProject(normalizedPath);
    return this.nodeResultCacheStore.load(normalizedPath, project.projectId);
  }

  async runProject(projectPath: string, options?: StudioRunOptions): Promise<StudioRunSummary> {
    const normalizedPath = normalizePath(projectPath);
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
        execute: () =>
          this.executeRun(
            normalizedPath,
            runId,
            startedAt,
            scopedEntryNodeIds.length > 0 || scopedForceNodeIds.length > 0
              ? {
                  entryNodeIds: scopedEntryNodeIds.length > 0 ? scopedEntryNodeIds : undefined,
                  forceNodeIds: scopedForceNodeIds.length > 0 ? scopedForceNodeIds : undefined,
                  onEvent,
                }
              : onEvent
                ? { onEvent }
                : undefined
          ),
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

  private buildSnapshotHash(snapshot: StudioRunSnapshotV1): Promise<string> {
    const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
    return sha256HexFromArrayBuffer(encoded.buffer);
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
          (existing as any[]).push(value);
          inputs[edge.toPortId] = existing as any;
        } else {
          inputs[edge.toPortId] = [existing, value] as any;
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
    runId: string,
    startedAt: string,
    options?: StudioRunOptions
  ): Promise<StudioRunSummary> {
    const fullProject = await this.projectStore.loadProject(projectPath);
    const project = scopeProjectForRun(fullProject, options?.entryNodeIds);
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    const permissions = new StudioPermissionManager(policy);
    const sandbox = new StudioSandboxRunner(permissions);
    const secretStore = new StudioSecretStore();

    const preflight = await this.apiAdapter.estimateRunCredits(project);
    if (!preflight.ok) {
      throw new Error(preflight.reason || "Studio preflight credit check failed.");
    }

    const compiled = this.compiler.compile(project, this.registry);
    const runDir = normalizePath(`${deriveStudioRunsDir(projectPath)}/${runId}`);
    await this.ensureDir(runDir);

    const snapshot: StudioRunSnapshotV1 = {
      schema: "studio.run.v1",
      runId,
      projectPath,
      projectId: project.projectId,
      createdAt: startedAt,
      project,
      policy,
    };

    const snapshotHash = await this.buildSnapshotHash(snapshot);
    await this.adapter.write(normalizePath(`${runDir}/snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`);

    const eventsPath = normalizePath(`${runDir}/events.ndjson`);
    await this.adapter.write(eventsPath, "");

    const emit = async (event: StudioRunEvent): Promise<void> => {
      await this.appendLine(eventsPath, `${JSON.stringify(event)}\n`);
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

    await emit({
      type: "run.started",
      runId,
      snapshotHash,
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
    const tempRootDir = Platform.isDesktopApp
      ? await mkdtemp(joinPath(tmpdir(), "systemsculpt-studio-"))
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

    const startNode = (nodeId: string): void => {
      const compiledNode = compiled.nodesById.get(nodeId)!;
      const nodeClass = compiledNode.definition.capabilityClass;
      runningByClass[nodeClass] += 1;
      state.set(nodeId, "running");

      const promise = (async () => {
        const inputs = this.mapNodeInputs(compiled, nodeId, outputsByNode);
        const inputFingerprint = await buildNodeInputFingerprint(compiledNode.node, inputs);
        const cachePolicy = compiledNode.definition.cachePolicy || "by_inputs";

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
          runId,
          projectPath,
          node: compiledNode.node,
          inputs,
          signal: abortController.signal,
          services: {
            api: this.apiAdapter,
            secretStore,
            storeAsset: (bytes, mimeType) => this.assetStore.storeArrayBuffer(projectPath, bytes, mimeType),
            readAsset: (asset) => this.assetStore.readArrayBuffer(asset),
            resolveAbsolutePath: (path) => {
              const normalized = String(path || "").trim();
              if (!normalized) {
                throw new Error("Filesystem path cannot be empty.");
              }
              if (isAbsolute(normalized)) {
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
                return joinPath(adapter.basePath, vaultPath);
              }
              throw new Error(
                `Unable to resolve an absolute path for "${vaultPath}". Desktop FileSystemAdapter is required.`
              );
            },
            readVaultBinary: async (vaultPath: string) => {
              permissions.assertFilesystemPath(vaultPath);
              if (!Platform.isDesktopApp) {
                throw new Error("Filesystem reads are desktop-only in Studio.");
              }
              const file = this.app.vault.getAbstractFileByPath(vaultPath);
              if (!(file instanceof TFile)) {
                throw new Error(`Vault file not found: ${vaultPath}`);
              }
              return this.app.vault.readBinary(file);
            },
            readLocalFileBinary: async (absolutePath: string) => {
              const normalized = String(absolutePath || "").trim();
              if (!Platform.isDesktopApp) {
                throw new Error("Local filesystem reads are desktop-only in Studio.");
              }
              if (!normalized) {
                throw new Error("Local filesystem read path is empty.");
              }
              if (!isAbsolute(normalized)) {
                throw new Error(
                  `Local filesystem read requires an absolute path. Received "${normalized}".`
                );
              }
              permissions.assertFilesystemPath(normalized);
              const bytes = await readFile(normalized);
              return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
              ) as ArrayBuffer;
            },
            writeTempFile: async (bytes, tempOptions) => {
              if (!Platform.isDesktopApp || !tempRootDir) {
                throw new Error("Temp file writes are desktop-only in Studio.");
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
              const tempPath = joinPath(
                tempRootDir,
                `${prefix}-${randomId("tmp")}${suffix}`
              );
              await writeFile(tempPath, Buffer.from(bytes));
              return tempPath;
            },
            deleteLocalFile: async (absolutePath: string) => {
              const normalized = String(absolutePath || "").trim();
              if (!normalized) {
                return;
              }
              try {
                await unlink(normalized);
              } catch {
                // Best effort cleanup.
              }
            },
            runCli: (request) => sandbox.runCli(request),
            assertFilesystemPath: (path) => permissions.assertFilesystemPath(path),
            assertNetworkUrl: (url) => permissions.assertNetworkUrl(url),
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
        state.set(nodeId, "done");
        executedNodeIds.push(nodeId);
        if (cachePolicy === "by_inputs") {
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
        } else {
          delete nodeCacheSnapshot.entries[nodeId];
        }
        await emit({
          type: "node.output",
          runId,
          nodeId,
          outputRef: `${runId}:${nodeId}`,
          outputSource: "execution",
          outputs: result.outputs,
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
      if (compiledNode.node.disabled === true) {
        state.set(nodeId, "skipped");
        dependencyCount.set(nodeId, 0);
        markDependentsReady(nodeId);
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
      try {
        await this.nodeResultCacheStore.save(projectPath, nodeCacheSnapshot);
      } catch (error) {
        this.plugin.getLogger().warn("Failed to persist Studio node cache", {
          source: "StudioRuntime",
          metadata: {
            projectPath,
            runId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      if (tempRootDir) {
        try {
          await rm(tempRootDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
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

    await emit({
      type: "run.completed",
      runId,
      status: status === "success" ? "success" : "failed",
      at: nowIso(),
    });

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
    await this.writeRunIndex(projectPath, currentRuns);
    await this.pruneRunRetention(projectPath, project.settings.retention.maxRuns);

    if (status === "failed") {
      throw new Error(errorMessage || "Studio run failed.");
    }

    return summary;
  }
}
