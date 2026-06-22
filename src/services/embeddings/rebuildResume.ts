/**
 * rebuildResume - decide whether (and when) to resume a bulk embeddings rebuild
 * that was interrupted by a non-license fatal error (e.g. a sustained rate
 * limit). This is #208's final slice over #127.
 *
 * Most of "checkpoint/resume" already exists: the per-file `complete`/`mtime`/
 * `contentHash` markers are durable (IndexedDB), PR-3 absorbs transient 429s with
 * backoff, and any re-run skips already-embedded files — so a resumed run never
 * restarts from ~0%. The one gap is that every auto-resume path is gated behind
 * `autoProcess`: when autoProcess is OFF, a sustained-429 stop neither
 * reschedules in-session nor survives a restart, so a manual rebuild silently
 * stalls until the user notices.
 *
 * The manager persists a tiny intent (`embeddingsRebuildPending` +
 * `embeddingsRebuildRetryAt`) when a rebuild is interrupted. On the next load it
 * asks this pure function whether to re-arm one vault run. Keeping the decision
 * pure (no timers, no `Date.now()`) makes the policy fully unit-testable.
 */

export interface RebuildResumeState {
  /** Embeddings feature enabled. */
  enabled: boolean;
  /** Background auto-processing enabled. When true, the normal startup
   *  scheduleAutoProcessing already resumes, so this defers to avoid double-run. */
  autoProcess: boolean;
  /** Persisted "a rebuild was interrupted" intent. */
  rebuildPending: boolean;
  /** Persisted earliest epoch-ms to resume (server cooldown). 0 = ASAP. */
  retryAt: number;
  /** Current epoch-ms. */
  now: number;
}

export interface RebuildResumeDecision {
  resume: boolean;
  /** Delay before the resumed run, in ms (never below `minDelayMs`). */
  delayMs: number;
  reason: "disabled" | "not-pending" | "auto-process-covers" | "resume";
}

/**
 * A small startup delay before the resumed run, matching scheduleAutoProcessing,
 * so init is never blocked and the store is ready.
 */
export const MIN_REBUILD_RESUME_DELAY_MS = 3000;

/**
 * Decide whether to force-resume an interrupted rebuild on load.
 *
 *  - feature off / nothing pending          -> no resume.
 *  - autoProcess on                          -> no resume here (the normal
 *    startup path covers it; forcing would double-schedule).
 *  - autoProcess off + pending               -> resume after
 *    `max(minDelayMs, retryAt - now)`, so we wait out a server cooldown but
 *    never block startup.
 */
export function computeRebuildResume(
  state: RebuildResumeState,
  minDelayMs: number = MIN_REBUILD_RESUME_DELAY_MS,
): RebuildResumeDecision {
  if (!state.enabled) {
    return { resume: false, delayMs: 0, reason: "disabled" };
  }
  if (!state.rebuildPending) {
    return { resume: false, delayMs: 0, reason: "not-pending" };
  }
  if (state.autoProcess) {
    return { resume: false, delayMs: 0, reason: "auto-process-covers" };
  }

  const floor = Math.max(0, minDelayMs);
  const wait = Number.isFinite(state.retryAt) ? state.retryAt - state.now : 0;
  const delayMs = Math.max(floor, wait);
  return { resume: true, delayMs, reason: "resume" };
}
