/** @jest-environment node */
import {
  extractPrimaryPathArg,
  isMutatingTool,
  requiresUserApproval,
  splitToolName,
} from "../toolPolicy";

describe("first-party tool policy", () => {
  it.each([
    ['read', false, false, false],
    ['write', false, true, false],
    ['edit', false, true, false],
    ['multi_edit', false, true, false],
    ['create_folders', false, true, false],
    ['move', true, true, false],
    ['trash', true, true, false],
    ['unknown', true, true, true],
  ] as const)('applies Auto, Ask and Full access to %s', (tool, auto, ask, full) => {
    expect(requiresUserApproval(tool, { mode: 'auto' })).toBe(auto);
    expect(requiresUserApproval(tool, { mode: 'ask' })).toBe(ask);
    expect(requiresUserApproval(tool, { mode: 'full-access' })).toBe(full);
  });
  it('keeps moves and trash asking in Auto even with a remembered action', () => {
    for (const tool of ['move', 'trash']) expect(requiresUserApproval(tool, {
      mode: 'auto', trustedToolNames: new Set(['*']), autoApproveAllowlist: ['*'],
    })).toBe(true);
  });
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
    expect(requiresUserApproval("read")).toBe(false);
    expect(requiresUserApproval("unknown")).toBe(true);
  });

  it("supports canonical allowlist entries", () => {
    expect(requiresUserApproval("write", { autoApproveAllowlist: ["write"] })).toBe(false);
    expect(requiresUserApproval("write", { autoApproveAllowlist: ["unrelated"] })).toBe(true);
    expect(requiresUserApproval("multi_edit", { autoApproveAllowlist: ["*"] })).toBe(false);
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

  it("trusts every non-trash mutation for a remembered chat without trusting trash", () => {
    const policy = { trustedToolNames: new Set(["*"]) };
    for (const name of ["write", "edit", "multi_edit", "create_folders", "move"]) {
      expect(requiresUserApproval(name, policy)).toBe(false);
    }
    expect(requiresUserApproval("trash", policy)).toBe(true);
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
