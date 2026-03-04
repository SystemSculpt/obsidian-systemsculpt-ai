import {
  computeStudioProjectTextSignature,
  consumeExpectedStudioProjectWriteSignature,
  resolveStudioProjectModifyDecision,
  trackExpectedStudioProjectWriteSignature,
} from "../systemsculpt-studio-view/StudioProjectLiveSync";

describe("StudioProjectLiveSync", () => {
  it("computes deterministic signatures", () => {
    const signatureA = computeStudioProjectTextSignature('{"nodes":1}');
    const signatureB = computeStudioProjectTextSignature('{"nodes":1}');
    const signatureC = computeStudioProjectTextSignature('{"nodes":2}');

    expect(signatureA).toBe(signatureB);
    expect(signatureA).not.toBe(signatureC);
  });

  it("tracks expected signatures with bounded set size", () => {
    const signatures = new Set<string>();
    trackExpectedStudioProjectWriteSignature(signatures, "one", { maxEntries: 2 });
    trackExpectedStudioProjectWriteSignature(signatures, "two", { maxEntries: 2 });
    trackExpectedStudioProjectWriteSignature(signatures, "three", { maxEntries: 2 });

    expect(Array.from(signatures)).toEqual(["two", "three"]);
  });

  it("consumes tracked signatures exactly once", () => {
    const signatures = new Set<string>(["abc"]);
    expect(consumeExpectedStudioProjectWriteSignature(signatures, "abc")).toBe(true);
    expect(consumeExpectedStudioProjectWriteSignature(signatures, "abc")).toBe(false);
  });

  it("resolves project modify decisions with stable precedence", () => {
    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: false,
        hasPendingLocalSaveWork: false,
        isExpectedSelfWrite: false,
        signature: "sig",
        lastAcceptedSignature: null,
        lastRejectedSignature: null,
      })
    ).toEqual({ kind: "ignore", reason: "inactive_project" });

    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: true,
        hasPendingLocalSaveWork: false,
        isExpectedSelfWrite: true,
        signature: "sig",
        lastAcceptedSignature: null,
        lastRejectedSignature: null,
      })
    ).toEqual({ kind: "ignore", reason: "self_write" });

    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: true,
        hasPendingLocalSaveWork: true,
        isExpectedSelfWrite: false,
        signature: "sig",
        lastAcceptedSignature: null,
        lastRejectedSignature: null,
      })
    ).toEqual({ kind: "defer", reason: "local_save_pending" });

    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: true,
        hasPendingLocalSaveWork: false,
        isExpectedSelfWrite: false,
        signature: "accepted",
        lastAcceptedSignature: "accepted",
        lastRejectedSignature: null,
      })
    ).toEqual({ kind: "ignore", reason: "duplicate_accepted" });

    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: true,
        hasPendingLocalSaveWork: false,
        isExpectedSelfWrite: false,
        signature: "rejected",
        lastAcceptedSignature: null,
        lastRejectedSignature: "rejected",
      })
    ).toEqual({ kind: "ignore", reason: "duplicate_rejected" });

    expect(
      resolveStudioProjectModifyDecision({
        isActiveProjectFile: true,
        hasPendingLocalSaveWork: false,
        isExpectedSelfWrite: false,
        signature: "fresh",
        lastAcceptedSignature: "accepted",
        lastRejectedSignature: "rejected",
      })
    ).toEqual({ kind: "evaluate" });
  });
});
