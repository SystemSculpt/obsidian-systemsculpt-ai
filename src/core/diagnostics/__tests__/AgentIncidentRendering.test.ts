import { copyRenderingInput, projectRenderingSnapshot, isRenderingSnapshot } from "../AgentIncidentRendering";
import type { AgentIncidentRenderingInput } from "../AgentIncidentRecorder";

function completeRendering(
  extra: Partial<AgentIncidentRenderingInput> = {},
): AgentIncidentRenderingInput {
  return {
    renderState: "idle",
    renderPassCount: 8,
    pendingRenderCount: 0,
    lastRenderDurationMs: 7,
    maxRenderDurationMs: 12,
    firstDomCommitObserved: true,
    firstPaintOpportunityObserved: true,
    registeredRowCount: 2,
    renderer: {
      renderPassCount: 8,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 7,
      maxRenderDurationMs: 12,
      historicalRowCount: 1,
      historicalPartCount: 3,
      activePartCount: 2,
      disclosureCount: 3,
      openDisclosureCount: 0,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 1,
      overflowDisclosureCount: 0,
      pendingHydrationCount: 0,
      renderingEnabled: true,
    },
    scroller: {
      mode: "end",
      distanceFromEndBucket: "at_end",
      registeredRowCount: 2,
      pendingLayoutMutationCount: 0,
      layoutMutationPending: false,
      geometryUpdatePending: false,
      programmaticScrollPending: false,
      submittedPromptAnchorActive: false,
      destroyed: false,
    },
    ...extra,
  };
}


describe("incident rendering field policy", () => {
  it.each([copyRenderingInput, projectRenderingSnapshot])("reads each allowed live field once without enumerating private content", project => {
    const reads = new Map<string, number>();
    const protect = (value: object, path: string): object => new Proxy(value, {
      ownKeys() { throw new Error("private-content-enumerated"); },
      get(target, key) {
        if (typeof key !== "string" || !(key in target)) throw new Error("private-content-read");
        const name = `${path}.${key}`;
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) throw new Error("field-read-twice");
        const next: unknown = Reflect.get(target, key);
        return next && typeof next === "object" ? protect(next, name) : next;
      },
    });
    const projected = project(protect(completeRendering(), "root") as AgentIncidentRenderingInput);
    expect(projected).toBeTruthy();
    expect(reads.size).toBe(34);
    expect([...reads.values()].every(count => count === 1)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected!.renderer)).toBe(true);
    expect(Object.isFrozen(projected!.scroller)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("private-content");
  });

  it("rejects a revoked live proxy without exposing its error", () => {
    const revocable = Proxy.revocable(completeRendering(), {});
    revocable.revoke();
    expect(copyRenderingInput(revocable.proxy)).toBeUndefined();
    expect(projectRenderingSnapshot(revocable.proxy)).toBeNull();
  });

  it("rejects missing, extra, or wrongly typed persisted fields at every level", () => {
    const valid = projectRenderingSnapshot(completeRendering())!;
    expect(isRenderingSnapshot(valid)).toBe(true);
    for (const section of [null, "renderer", "scroller"]) {
      const source = (section ? valid[section as "renderer" | "scroller"] : valid) as unknown as Record<string, unknown>;
      for (const key of Object.keys(source).filter(key => key !== "renderer" && key !== "scroller")) {
        for (const mutation of ["missing", "wrong-type"] as const) {
          const candidate = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
          const record = section ? candidate[section] as Record<string, unknown> : candidate;
          if (mutation === "missing") delete record[key];
          else record[key] = null;
          expect(isRenderingSnapshot(candidate)).toBe(false);
        }
      }
      const candidate = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      const record = section ? candidate[section] as Record<string, unknown> : candidate;
      record.private_content = "privacy-canary";
      expect(isRenderingSnapshot(candidate)).toBe(false);
    }
  });
});
