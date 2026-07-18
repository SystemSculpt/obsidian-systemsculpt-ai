import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { AudioProcessorApiError } from "./AudioProcessorApiClient";
import { getAudioProcessorAvailability } from "./AudioProcessorAvailability";
import { AudioProcessorPanel } from "./AudioProcessorPanel";
import { AudioProcessorService } from "./AudioProcessorService";
import type { AudioProcessorJob } from "./types";

export interface ResumeAudioProcessorOptions {
  notifyOnDiscoveryFailure?: boolean;
}

const resumeTasks = new WeakMap<SystemSculptPlugin, Promise<void>>();
const RESUME_CONCURRENCY = 2;

/**
 * Reconnects the thin plugin client to server-owned work. The single-flight
 * guard prevents command opens and startup initialization from polling the
 * same tenant jobs twice.
 */
export function resumeAudioProcessorJobs(
  plugin: SystemSculptPlugin,
  options: ResumeAudioProcessorOptions = {},
): Promise<void> {
  const current = resumeTasks.get(plugin);
  if (current) return current;

  const task = runResume(plugin, options);
  trackResumeTask(plugin, task);
  return task;
}

async function runResume(
  plugin: SystemSculptPlugin,
  options: ResumeAudioProcessorOptions,
): Promise<void> {
  // Startup command registration can run before a legacy/test settings
  // object has been fully normalized. Recovery is optional at this boundary;
  // an absent license must be a no-op rather than an unhandled startup error.
  const licenseKey = plugin.settings?.licenseKey;
  if (typeof licenseKey !== "string" || !licenseKey.trim()) return;
  const controller = new AbortController();
  plugin.register(() => controller.abort());
  const availability = await getAudioProcessorAvailability(plugin, {}, controller.signal);
  if (controller.signal.aborted) return;
  if (availability.authoritative && !availability.canOpen) return;

  const service = new AudioProcessorService(plugin);
  let jobs: AudioProcessorJob[];
  try {
    jobs = await service.listActiveJobs(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
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
    controller.signal,
  ).catch((error) => {
    if (controller.signal.aborted) return;
    plugin.getLogger().warn("Audio Processor staging cleanup deferred", {
      source: "AudioProcessorResume",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
  });

  const terminalJobs = jobs.filter(isTerminalDeliveryJob);
  const watcherJobs = jobs.filter((job) => !isTerminalDeliveryJob(job) && job.status !== "uploading");
  const uploadJobs = jobs.filter((job) => job.status === "uploading");

  await runWithConcurrencyLimit(terminalJobs, RESUME_CONCURRENCY, async (job) => {
    await resumeObservedJob(plugin, service, job, { resumeAwaitingFundsOnce: true });
  });

  for (const job of jobs) {
    if (job.status === "uploading") continue;
    await service.clearUploadRecovery(job.id).catch(() => undefined);
  }

  if (controller.signal.aborted || (watcherJobs.length === 0 && uploadJobs.length === 0)) return;
  const background = runWithConcurrencyLimit(
    [...uploadJobs.map((job) => ({ kind: "upload" as const, job })), ...watcherJobs.map((job) => ({ kind: "watch" as const, job }))],
    RESUME_CONCURRENCY,
    async (task) => {
      if (task.kind === "upload") {
        if (!await service.hasUploadRecovery(task.job.id)) {
          plugin.getLogger().warn("Skipping upload recovery without a durable checkpoint", {
            source: "AudioProcessorResume",
            metadata: { jobId: task.job.id },
          });
          return;
        }
        await resumeUploadJob(plugin, service, task.job);
        return;
      }
      await resumeObservedJob(plugin, service, task.job, { resumeAwaitingFundsOnce: true });
    },
  );
  trackResumeTask(plugin, background);
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  if (concurrency === 0) return;

  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }));
}

async function resumeObservedJob(
  plugin: SystemSculptPlugin,
  service: AudioProcessorService,
  job: AudioProcessorJob,
  options: Readonly<{ resumeAwaitingFundsOnce?: boolean }>,
): Promise<void> {
  const jobController = new AbortController();
  plugin.register(() => jobController.abort());
  let userCancelled = false;
  const panel = new AudioProcessorPanel(
    plugin,
    job.result?.filename ?? job.transcriptArtifact?.filename ?? "Active audio",
    () => {
      userCancelled = true;
      jobController.abort();
    },
  );
  try {
    const note = await service.resume(job, {
      signal: jobController.signal,
      onProgress: (event) => panel.update(event),
    }, options);
    panel.succeed(note);
  } catch (error) {
    if (userCancelled || !jobController.signal.aborted) panel.fail(error);
  }
}

async function resumeUploadJob(
  plugin: SystemSculptPlugin,
  service: AudioProcessorService,
  job: AudioProcessorJob,
): Promise<void> {
  const jobController = new AbortController();
  plugin.register(() => jobController.abort());
  let userCancelled = false;
  const panel = new AudioProcessorPanel(
    plugin,
    "Resuming audio upload",
    () => {
      userCancelled = true;
      jobController.abort();
    },
  );
  try {
    const note = await service.resumeUpload(job, {
      signal: jobController.signal,
      onProgress: (event) => panel.update(event),
    });
    panel.succeed(note);
  } catch (error) {
    if (userCancelled || !jobController.signal.aborted) panel.fail(error);
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
