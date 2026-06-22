import { describe, expect, it } from "@jest/globals";
import {
  MIN_REBUILD_RESUME_DELAY_MS,
  computeRebuildResume,
  type RebuildResumeState,
} from "../rebuildResume";

function state(overrides: Partial<RebuildResumeState> = {}): RebuildResumeState {
  return {
    enabled: true,
    autoProcess: false,
    rebuildPending: true,
    retryAt: 0,
    now: 1_000_000,
    ...overrides,
  };
}

describe("computeRebuildResume", () => {
  it("does not resume when embeddings are disabled", () => {
    expect(computeRebuildResume(state({ enabled: false }))).toEqual({
      resume: false,
      delayMs: 0,
      reason: "disabled",
    });
  });

  it("does not resume when no rebuild is pending", () => {
    expect(computeRebuildResume(state({ rebuildPending: false }))).toEqual({
      resume: false,
      delayMs: 0,
      reason: "not-pending",
    });
  });

  it("defers to the normal startup path when autoProcess is ON (no double-schedule)", () => {
    // autoProcess ON => scheduleAutoProcessing already resumes; forcing here
    // would schedule a second, redundant vault run.
    expect(computeRebuildResume(state({ autoProcess: true }))).toEqual({
      resume: false,
      delayMs: 0,
      reason: "auto-process-covers",
    });
  });

  it("resumes (the #127 gap) when pending + autoProcess OFF", () => {
    const decision = computeRebuildResume(state({ autoProcess: false, retryAt: 0 }));
    expect(decision.resume).toBe(true);
    expect(decision.reason).toBe("resume");
    // No specific cooldown -> the startup floor, never blocking init.
    expect(decision.delayMs).toBe(MIN_REBUILD_RESUME_DELAY_MS);
  });

  it("honors a future retry-at (waits out the server cooldown)", () => {
    const now = 1_000_000;
    const decision = computeRebuildResume(state({ now, retryAt: now + 90_000 }));
    expect(decision.resume).toBe(true);
    expect(decision.delayMs).toBe(90_000);
  });

  it("floors a past or zero retry-at at the startup delay", () => {
    const now = 1_000_000;
    expect(computeRebuildResume(state({ now, retryAt: now - 50_000 })).delayMs).toBe(
      MIN_REBUILD_RESUME_DELAY_MS,
    );
    expect(computeRebuildResume(state({ now, retryAt: 0 })).delayMs).toBe(
      MIN_REBUILD_RESUME_DELAY_MS,
    );
  });

  it("honors a custom minimum delay", () => {
    const now = 1_000_000;
    expect(computeRebuildResume(state({ now, retryAt: 0 }), 500).delayMs).toBe(500);
    // A future cooldown still wins over the floor.
    expect(computeRebuildResume(state({ now, retryAt: now + 10_000 }), 500).delayMs).toBe(10_000);
  });

  it("treats a non-finite retry-at as ASAP (floored)", () => {
    const decision = computeRebuildResume(state({ retryAt: Number.NaN }));
    expect(decision.resume).toBe(true);
    expect(decision.delayMs).toBe(MIN_REBUILD_RESUME_DELAY_MS);
  });
});
