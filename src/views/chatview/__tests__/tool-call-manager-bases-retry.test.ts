import { TOOL_LOOP_ERROR_CODE } from "../../../utils/tooling";
import { ToolCallManager } from "../ToolCallManager";

describe("ToolCallManager Bases YAML retry guard", () => {
  function createManager(): ToolCallManager {
    const chatView = {
      plugin: { settings: {} },
      trustedToolNames: new Set<string>(),
    };
    return new ToolCallManager({} as any, chatView);
  }

  it("converts BASE_YAML_INVALID to TOOL_LOOP_ERROR_CODE after 3 attempts for the same .base path", () => {
    const manager = createManager();
    const toolName = "mcp-filesystem_write";
    const args = { path: "Views/Projects.base" };

    const baseFailure = {
      success: false,
      error: { code: "BASE_YAML_INVALID", message: "Invalid YAML" },
    };

    let r1 = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(r1.error.code).toBe("BASE_YAML_INVALID");
    expect(r1.error.message).toContain("attempt 1/3");

    let r2 = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(r2.error.code).toBe("BASE_YAML_INVALID");
    expect(r2.error.message).toContain("attempt 2/3");

    let r3 = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(r3.error.code).toBe(TOOL_LOOP_ERROR_CODE);
  });

  it("clears retry state on success", () => {
    const manager = createManager();
    const toolName = "mcp-filesystem_edit";
    const args = { path: "Views/Projects.base" };

    const baseFailure = {
      success: false,
      error: { code: "BASE_YAML_INVALID", message: "Invalid YAML" },
    };

    const r1 = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(r1.error.message).toContain("attempt 1/3");

    const ok = (manager as any).applyBaseYamlRetryGuard(toolName, args, { success: true, data: {} });
    expect(ok.success).toBe(true);

    const r2 = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(r2.error.message).toContain("attempt 1/3");
  });

  it("ignores non-.base paths", () => {
    const manager = createManager();
    const toolName = "mcp-filesystem_write";
    const args = { path: "Notes/Example.md" };
    const baseFailure = {
      success: false,
      error: { code: "BASE_YAML_INVALID", message: "Invalid YAML" },
    };

    const result = (manager as any).applyBaseYamlRetryGuard(toolName, args, baseFailure);
    expect(result.error.code).toBe("BASE_YAML_INVALID");
    expect(result.error.message).toBe("Invalid YAML");
  });
});

