/**
 * @jest-environment node
 */
import {
  splitToolName,
  toMcpToolKey,
  getToolApprovalDecision,
  shouldAutoApproveTool,
  isMutatingTool,
  requiresUserApproval,
  extractPrimaryPathArg,
} from "../toolPolicy";

describe("splitToolName", () => {
  it("splits mcp-prefixed tool names correctly", () => {
    const result = splitToolName("mcp-filesystem_read");
    expect(result.serverId).toBe("mcp-filesystem");
    expect(result.actualName).toBe("read");
    expect(result.canonicalName).toBe("read");
  });

  it("handles tool names without mcp prefix", () => {
    const result = splitToolName("search");
    expect(result.serverId).toBeNull();
    expect(result.actualName).toBe("search");
    expect(result.canonicalName).toBe("search");
  });

  it("handles empty string", () => {
    const result = splitToolName("");
    expect(result.serverId).toBeNull();
    expect(result.actualName).toBe("");
    expect(result.canonicalName).toBe("");
  });

  it("handles null/undefined input", () => {
    const result = splitToolName(null as any);
    expect(result.serverId).toBeNull();
    expect(result.actualName).toBe("");
  });

  it("preserves case in actualName but lowercases canonicalName", () => {
    const result = splitToolName("mcp-test_ReadFile");
    expect(result.actualName).toBe("ReadFile");
    expect(result.canonicalName).toBe("readfile");
  });

  it("handles multiple underscores", () => {
    const result = splitToolName("mcp-server_read_file_contents");
    expect(result.serverId).toBe("mcp-server");
    expect(result.actualName).toBe("read_file_contents");
  });

  it("handles tool names starting with mcp but no underscore", () => {
    const result = splitToolName("mcp-nounder");
    expect(result.serverId).toBeNull();
    expect(result.actualName).toBe("mcp-nounder");
  });
});

describe("toMcpToolKey", () => {
  it("converts mcp function name to tool key", () => {
    const result = toMcpToolKey("mcp-filesystem_read");
    expect(result).toBe("mcp-filesystem:read");
  });

  it("returns null for non-mcp tools", () => {
    const result = toMcpToolKey("search");
    expect(result).toBeNull();
  });

  it("lowercases the entire key", () => {
    const result = toMcpToolKey("mcp-FileSystem_ReadFile");
    expect(result).toBe("mcp-filesystem:readfile");
  });

  it("handles empty string", () => {
    const result = toMcpToolKey("");
    expect(result).toBeNull();
  });
});

describe("tool approval policy", () => {
  it("auto-approves non-mutating tools", () => {
    const decision = getToolApprovalDecision("mcp-filesystem_read", []);
    expect(decision.autoApprove).toBe(true);
    expect(decision.reason).toBe("non-mutating");
    expect(shouldAutoApproveTool("search", [])).toBe(true);
  });

  it("requires approval for mutating tools by default", () => {
    const decision = getToolApprovalDecision("mcp-filesystem_write", []);
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toBe("mutating-default");
    expect(shouldAutoApproveTool("write", [])).toBe(false);
  });

  it("allows mutating tools when explicitly allowlisted", () => {
    const decision = getToolApprovalDecision("mcp-filesystem_write", ["mcp-filesystem:write"]);
    expect(decision.autoApprove).toBe(true);
    expect(decision.reason).toBe("allowlisted");
  });

  it("handles invalid tool names", () => {
    const decision = getToolApprovalDecision("", []);
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toBe("invalid");
  });
});

describe("requiresUserApproval", () => {
  it("requires approval for destructive filesystem tools by default", () => {
    expect(requiresUserApproval("mcp-filesystem_write", { trustedToolNames: new Set() })).toBe(true);
    expect(requiresUserApproval("mcp-filesystem_edit", { trustedToolNames: new Set() })).toBe(true);
  });

  it("auto-approves destructive filesystem tools when toggle is disabled", () => {
    expect(
      requiresUserApproval("mcp-filesystem_write", {
        trustedToolNames: new Set(),
        requireDestructiveApproval: false,
      })
    ).toBe(false);
  });

  it("auto-approves allowlisted destructive tools", () => {
    expect(
      requiresUserApproval("mcp-filesystem_write", {
        trustedToolNames: new Set(),
        autoApproveAllowlist: ["mcp-filesystem:write"],
      })
    ).toBe(false);
  });

  it("external tools require approval unless allowlisted", () => {
    expect(
      requiresUserApproval("mcp-shell_run_command", {
        trustedToolNames: new Set(),
      })
    ).toBe(true);
    expect(
      requiresUserApproval("mcp-shell_run_command", {
        trustedToolNames: new Set(),
        autoApproveAllowlist: ["mcp-shell:run_command"],
      })
    ).toBe(false);
  });

  it("respects trusted tool names", () => {
    const trusted = new Set(["mcp-filesystem_write"]);
    expect(requiresUserApproval("mcp-filesystem_write", { trustedToolNames: trusted })).toBe(false);
  });
});

describe("isMutatingTool", () => {
  describe("exact matches", () => {
    it("detects write operations", () => {
      expect(isMutatingTool("write")).toBe(true);
      expect(isMutatingTool("edit")).toBe(true);
      expect(isMutatingTool("delete")).toBe(true);
      expect(isMutatingTool("rename")).toBe(true);
      expect(isMutatingTool("move")).toBe(true);
      expect(isMutatingTool("trash")).toBe(true);
    });

    it("detects command execution", () => {
      expect(isMutatingTool("run_command")).toBe(true);
      expect(isMutatingTool("execute")).toBe(true);
      expect(isMutatingTool("exec")).toBe(true);
      expect(isMutatingTool("shell")).toBe(true);
      expect(isMutatingTool("spawn")).toBe(true);
    });

    it("detects scripting tools", () => {
      expect(isMutatingTool("bash")).toBe(true);
      expect(isMutatingTool("powershell")).toBe(true);
      expect(isMutatingTool("python")).toBe(true);
      expect(isMutatingTool("node")).toBe(true);
      expect(isMutatingTool("eval")).toBe(true);
    });

    it("detects network operations", () => {
      expect(isMutatingTool("http_request")).toBe(true);
      expect(isMutatingTool("request")).toBe(true);
      expect(isMutatingTool("fetch")).toBe(true);
      expect(isMutatingTool("curl")).toBe(true);
    });
  });

  describe("prefix matching", () => {
    it("matches tools starting with mutation prefixes", () => {
      expect(isMutatingTool("write_file")).toBe(true);
      expect(isMutatingTool("edit_content")).toBe(true);
      expect(isMutatingTool("delete_all")).toBe(true);
      expect(isMutatingTool("create_folder")).toBe(true);
      expect(isMutatingTool("update_settings")).toBe(true);
    });
  });

  describe("suffix matching", () => {
    it("matches tools containing command-related suffixes", () => {
      expect(isMutatingTool("file_execute")).toBe(true);
      expect(isMutatingTool("run_shell")).toBe(true);
      expect(isMutatingTool("run_command")).toBe(true);
    });
  });

  describe("mcp-prefixed tools", () => {
    it("strips mcp prefix and evaluates base name", () => {
      expect(isMutatingTool("mcp-filesystem_write")).toBe(true);
      expect(isMutatingTool("mcp-vault_read")).toBe(false);
      expect(isMutatingTool("mcp-terminal_execute")).toBe(true);
    });
  });

  describe("safe tools", () => {
    it("returns false for read-only operations", () => {
      expect(isMutatingTool("read")).toBe(false);
      expect(isMutatingTool("list")).toBe(false);
      expect(isMutatingTool("find")).toBe(false);
      expect(isMutatingTool("search")).toBe(false);
      expect(isMutatingTool("get")).toBe(false);
    });
  });

  it("handles empty/null input", () => {
    expect(isMutatingTool("")).toBe(false);
    expect(isMutatingTool(null as any)).toBe(false);
  });
});

describe("extractPrimaryPathArg", () => {
  it("extracts path for read tool", () => {
    const result = extractPrimaryPathArg("read", { paths: "/vault/file.md" });
    expect(result).toBe("/vault/file.md");
  });

  it("extracts first path from array for read tool", () => {
    const result = extractPrimaryPathArg("read", { paths: ["/file1.md", "/file2.md"] });
    expect(result).toBe("/file1.md");
  });

  it("extracts path for write tool", () => {
    const result = extractPrimaryPathArg("write", { path: "/vault/output.md" });
    expect(result).toBe("/vault/output.md");
  });

  it("extracts path for edit tool", () => {
    const result = extractPrimaryPathArg("edit", { path: "/vault/file.md" });
    expect(result).toBe("/vault/file.md");
  });

  it("extracts paths for trash tool", () => {
    const result = extractPrimaryPathArg("trash", { paths: ["/vault/delete.md"] });
    expect(result).toBe("/vault/delete.md");
  });

  it("extracts destination for move tool", () => {
    const result = extractPrimaryPathArg("move", {
      items: [{ destination: "/new/path.md" }],
    });
    expect(result).toBe("/new/path.md");
  });

  it("returns null for unknown tools", () => {
    const result = extractPrimaryPathArg("unknown", { path: "/file.md" });
    expect(result).toBeNull();
  });

  it("returns null when expected arg is missing", () => {
    const result = extractPrimaryPathArg("read", {});
    expect(result).toBeNull();
  });

  it("handles mcp-prefixed tool names", () => {
    const result = extractPrimaryPathArg("mcp-filesystem_read", { paths: "/file.md" });
    expect(result).toBe("/file.md");
  });
});
