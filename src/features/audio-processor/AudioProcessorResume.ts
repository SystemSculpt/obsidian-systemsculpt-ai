import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { registerRunTeardown } from "../../core/plugin/lifecycle/RunTeardown";
import { AudioProcessorApiError } from "./AudioProcessorApiClient";
import { getAudioProcessorAvailability } from "./AudioProcessorAvailability";
import { AudioProcessorPanel } from "./AudioProcessorPanel";
import { AudioProcessorService } from "./AudioProcessorService";
import type { AudioProcessorJob } from "./types";

export interface ResumeAudioProcessorOptions {
  notifyOnDiscoveryFailure?: boolean;
}

const resumeTasks = new WeakMap<SystemSculptPlugin, Promise<void>>();
const resumeShutdownSignals = new WeakMap<SystemSculptPlugin, AbortSignal>();
const RESUME_CONCURRENCY = 2;

function resumeShutdownSignal(plugin: SystemSculptPlugin): AbortSignal {
  const existing = resumeShutdownSignals.get(plugin);
  if (existing) return existing;
  const controller = new AbortController();
  // Component cleanup runs synchronously while main.onunload may still be
  // draining producers and logs, before isPluginUnloading becomes true.
  plugin.register(() => controller.abort());
  resumeShutdownSignals.set(plugin, controller.signal);
  return controller.signal;
}

/**
 * Reconnects the thin plugin client to server-owned work. The single-flight
 * guard prevents command opens and startup initialization from polling the
 * same tenant jobs twice.
 */
export function resumeAudioProcessorJobs(
  plugin: SystemSculptPlugin,
  options: ResumeAudioProcessorOptions = {},
): Promise<void> {
  if (plugin.isPluginUnloading?.()) return Promise.resolve();
  const shutdownSignal = resumeShutdownSignal(plugin);
  if (shutdownSignal.aborted) return Promise.resolve();
  const current = resumeTasks.get(plugin);
  if (current) return current;

  const task = runResume(plugin, options, shutdownSignal);
  trackResumeTask(plugin, task);
  return task;
}

async function runResume(
  plugin: SystemSculptPlugin,
  options: ResumeAudioProcessorOptions,
  shutdownSignal: AbortSignal,
): Promise<void> {
  // Startup command registration can run before a legacy/test settings
  // object has been fully normalized. Recovery is optional at this boundary;
  // an absent license must be a no-op rather than an unhandled startup error.
  const licenseKey = plugin.settings?.licenseKey;
  if (typeof licenseKey !== "string" || !licenseKey.trim()) return;
  const controller = new AbortController();
  const releaseUnload = registerRunTeardown(plugin, () => controller.abort());
  try {
    await discoverAndResume(plugin, options, controller.signal, shutdownSignal);
  } finally {
    releaseUnload();
  }
}

/** Discovery releases its own signal; the plugin shutdown signal also covers queued recovery. */
async function discoverAndResume(
  plugin: SystemSculptPlugin,
  options: ResumeAudioProcessorOptions,
  signal: AbortSignal,
  shutdownSignal: AbortSignal,
): Promise<void> {
  const availability = await getAudioProcessorAvailability(plugin, {}, signal);
  if (signal.aborted) return;
  if (availability.authoritative && !availability.canOpen) return;

  const service = new AudioProcessorService(plugin);
  let jobs: AudioProcessorJob[];
  try {
    jobs = await service.listActiveJobs(signal);
  } catch (error) {
    if (signal.aborted) return;
    if (isExpectedAudioProcessorUnavailability(error)) return;
    plugin.getLogger().warn("Active Audio Processor job discovery failed", {
      source: "AudioProcessorResume",
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (options.notifyOnDiscoveryFailure) {
      new Notice(
        error instanceof Error ? error.message : "Unable to check active Audio Processor jobs.",
        6000,
      );
    }
    return;
  }

  await service.cleanupStaleStaging(
    jobs.filter((job) => job.status === "uploading").map((job) => job.id),
    signal,
  ).catch((error) => {
    if (signal.aborted) return;
    plugin.getLogger().warn("Audio Processor staging cleanup deferred", {
      source: "AudioProcessorResume",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
  });

  const terminalJobs = jobs.filter(isTerminalDeliveryJob);
  const watcherJobs = jobs.filter((job) => !isTerminalDeliveryJob(job) && job.status !== "uploading");
  const uploadJobs = jobs.filter((job) => job.status === "uploading");

  await runWithConcurrencyLimit(terminalJobs, RESUME_CONCURRENCY, shutdownSignal, async (job) => {
    await resumeJob(plugin, service, job, "watch", shutdownSignal);
  });

  for (const job of jobs) {
    if (signal.aborted || shutdownSignal.aborted) return;
    if (job.status === "uploading") continue;
    await service.clearUploadRecovery(job.id).catch(() => undefined);
  }

  if (signal.aborted || shutdownSignal.aborted || (watcherJobs.length === 0 && uploadJobs.length === 0)) return;
  const background = runWithConcurrencyLimit(
    [...uploadJobs.map((job) => ({ kind: "upload" as const, job })), ...watcherJobs.map((job) => ({ kind: "watch" as const, job }))],
    RESUME_CONCURRENCY,
    shutdownSignal,
    async (task) => {
      if (task.kind === "upload") {
        const hasRecovery = await service.hasUploadRecovery(task.job.id);
        if (shutdownSignal.aborted) return;
        if (!hasRecovery) {
          plugin.getLogger().warn("Skipping upload recovery without a durable checkpoint", {
            source: "AudioProcessorResume",
            metadata: { jobId: task.job.id },
          });
          return;
        }
        await resumeJob(plugin, service, task.job, "upload", shutdownSignal);
        return;
      }
      await resumeJob(plugin, service, task.job, "watch", shutdownSignal);
    },
  );
  trackResumeTask(plugin, background);
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  shutdownSignal: AbortSignal,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.min(limit, items.length));

  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!shutdownSignal.aborted && index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }));
}

async function resumeJob(
  plugin: SystemSculptPlugin,
  service: AudioProcessorService,
  job: AudioProcessorJob,
  kind: "upload" | "watch",
  shutdownSignal: AbortSignal,
): Promise<void> {
  if (shutdownSignal.aborted) return;
  const jobController = new AbortController();
  const releaseUnload = registerRunTeardown(plugin, () => jobController.abort());
  let userCancelled = false;
  const panel = new AudioProcessorPanel(
    plugin,
    kind === "upload" ? "Resuming audio upload" : job.result?.filename ?? job.transcriptArtifact?.filename ?? "Active audio",
    () => {
      userCancelled = true;
      jobController.abort();
    },
  );
  try {
    const options = {
      signal: jobController.signal,
      onProgress: (event: Parameters<AudioProcessorPanel["update"]>[0]) => panel.update(event),
    };
    const note = kind === "upload"
      ? await service.resumeUpload(job, options)
      : await service.resume(job, options, { resumeAwaitingFundsOnce: true });
    panel.succeed(note);
  } catch (error) {
    if (userCancelled || !jobController.signal.aborted) panel.fail(error);
  } finally {
    releaseUnload();
  }
}

function isTerminalDeliveryJob(job: AudioProcessorJob): boolean {
  return job.status === "succeeded" || (job.status === "failed" && job.transcriptArtifact !== null);
}

function isExpectedAudioProcessorUnavailability(error: unknown): boolean {
  if (!(error instanceof AudioProcessorApiError)) return false;
  if ([404, 405, 501].includes(error.status)) return true;
  return [
    "capability_unavailable",
    "not_found",
    "not_implemented",
    "route_not_found",
    "unsupported_capability",
  ].includes(error.code);
}

function trackResumeTask(plugin: SystemSculptPlugin, task: Promise<void>): void {
  resumeTasks.set(plugin, task);
  void task.finally(() => {
    if (resumeTasks.get(plugin) === task) resumeTasks.delete(plugin);
  });
}
