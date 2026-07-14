/** @jest-environment node */
import {
  extractPrimaryPathArg,
  getToolApprovalDecision,
  isMutatingTool,
  isToolAllowlisted,
  requiresUserApproval,
  splitToolName,
} from "../toolPolicy";

describe("first-party tool policy", () => {
  it("uses canonical names directly", () => {
    expect(splitToolName("read")).toEqual({ actualName: "read", canonicalName: "read" });
  });

  it("normalizes canonical tool identities without aliases", () => {
    expect(splitToolName(" READ ").canonicalName).toBe("read");
    expect(splitToolName("grep").canonicalName).toBe("grep");
    expect(splitToolName("mkdir").canonicalName).toBe("mkdir");
  });

  it("recognizes only the six vault mutation tools", () => {
    for (const name of ["write", "edit", "multi_edit", "create_folders", "move", "trash"]) {
      expect(isMutatingTool(name)).toBe(true);
    }
    for (const name of ["read", "list_items", "find", "search", "open", "context", "unknown"]) {
      expect(isMutatingTool(name)).toBe(false);
    }
  });

  it("auto-approves canonical read-only tools and rejects unknown names", () => {
    expect(getToolApprovalDecision("read")).toEqual({ autoApprove: true, reason: "non-mutating" });
    expect(getToolApprovalDecision("unknown")).toEqual({ autoApprove: false, reason: "invalid" });
    expect(requiresUserApproval("unknown")).toBe(true);
  });

  it("supports canonical allowlist entries", () => {
    expect(isToolAllowlisted("write", ["write"])).toBe(true);
    expect(isToolAllowlisted("write", ["unrelated"])).toBe(false);
    expect(isToolAllowlisted("multi_edit", ["*"])).toBe(true);
  });

  it("keeps remembered Ask Approval choices narrower than Full Access", () => {
    const remembered = ["write", "edit", "multi_edit", "create_folders", "move"];
    for (const name of remembered) {
      expect(requiresUserApproval(name, { autoApproveAllowlist: remembered })).toBe(false);
    }
    expect(requiresUserApproval("trash", {
      autoApproveAllowlist: ["*", "trash"],
      trustedToolNames: new Set(["trash"]),
    })).toBe(true);
    for (const name of [...remembered, "trash"]) {
      expect(requiresUserApproval(name, { requireDestructiveApproval: false })).toBe(false);
    }
  });

  it("retains the explicit private automation override", () => {
    expect(requiresUserApproval("trash", { requireDestructiveApproval: false })).toBe(false);
  });

  it("extracts primary paths from canonical calls", () => {
    expect(extractPrimaryPathArg("read", { paths: ["one.md", "two.md"] })).toBe("one.md");
    expect(extractPrimaryPathArg("write", { path: "new.md" })).toBe("new.md");
    expect(extractPrimaryPathArg("multi_edit", { files: [{ path: "edit.md" }] })).toBe("edit.md");
    expect(extractPrimaryPathArg("move", { items: [{ destination: "moved.md" }] })).toBe("moved.md");
  });
});
