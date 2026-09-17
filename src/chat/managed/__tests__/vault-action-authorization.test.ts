import { VaultActionAuthorization } from "../VaultActionAuthorization";

const write = { callId: "write-1", name: "write", input: { path: "Note.md", content: "hello" } };

function pendingWrite() {
  const authority = new VaultActionAuthorization();
  expect(authority.observe(write)).toBe(true);
  expect(authority.bindApproval(write.callId, "approve-1")).toBe(true);
  return authority;
}

describe("VaultActionAuthorization", () => {
  it("requires a local decision for the exact observed mutation", () => {
    const authority = pendingWrite();
    expect(authority.allows(write)).toBe(false);
    expect(authority.callForApproval("approve-1")).toBe(write.callId);
    expect(authority.decide("approve-1", true, "manual")).toEqual({
      approvalId: "approve-1", approved: true, source: "manual",
    });
    expect(authority.allows(write)).toBe(true);
    expect(authority.allows({ ...write, input: { ...write.input, content: "changed" } })).toBe(false);
    expect(authority.allows({ ...write, callId: "write-2" })).toBe(false);
    expect(authority.matches({ ...write, name: "trash" })).toBe(false);
  });

  it("retains canonical identity when the original input object is later mutated", () => {
    const authority = new VaultActionAuthorization();
    const call = { ...write, input: { ...write.input } };
    authority.observe(call);
    call.input.content = "changed";
    expect(authority.observe(call)).toBe(false);
    expect(authority.matches(write)).toBe(true);
    expect(authority.observe({ ...write, input: { content: "hello", path: "Note.md" } })).toBe(true);
  });

  it("rejects missing, rebound, and shared approval identities without altering the original binding", () => {
    const authority = pendingWrite();
    expect(authority.bindApproval("unknown", "approval")).toBe(false);
    expect(authority.bindApproval(write.callId, "")).toBe(false);
    expect(authority.bindApproval(write.callId, "approve-2")).toBe(false);
    expect(authority.bindApproval(write.callId, "approve-1")).toBe(true);
    authority.observe({ ...write, callId: "write-2" });
    expect(authority.bindApproval("write-2", "approve-1")).toBe(false);
    expect(authority.state(write.callId)).toEqual({ approvalId: "approve-1", decision: undefined });
    expect(authority.state("write-2").approvalId).toBeUndefined();
  });

  it("makes both allow and deny decisions final and immutable", () => {
    for (const approved of [true, false]) {
      const authority = pendingWrite();
      const decision = authority.decide("approve-1", approved, "policy");
      expect(authority.decide("approve-1", !approved, "manual")).toBeUndefined();
      expect(authority.state(write.callId).decision).toEqual(decision);
      expect(Object.isFrozen(decision)).toBe(true);
      expect(authority.allows(write)).toBe(approved);
    }
  });

  it("does not create authority through an unknown approval or a mutable presentation snapshot", () => {
    const authority = pendingWrite();
    expect(authority.decide("unknown", true, "manual")).toBeUndefined();
    expect(authority.callForApproval("unknown")).toBeUndefined();
    expect(authority.state("unknown").decision).toBeUndefined();
    const snapshot = authority.state(write.callId);
    Object.assign(snapshot, { decision: { approved: true }, approvalId: "forged" });
    expect(authority.allows(write)).toBe(false);
    expect(authority.state(write.callId).approvalId).toBe("approve-1");
  });

  it("allows read-only actions without granting authority to another run", () => {
    const authority = pendingWrite();
    authority.decide("approve-1", true, "manual");
    expect(authority.allows({ callId: "read-1", name: "read", input: { paths: ["Note.md"] } })).toBe(true);
    expect(new VaultActionAuthorization().allows(write)).toBe(false);
  });
});
