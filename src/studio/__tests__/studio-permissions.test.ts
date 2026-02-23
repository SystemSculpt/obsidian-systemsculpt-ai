import { StudioPermissionManager } from "../StudioPermissionManager";
import type { StudioPermissionPolicyV1 } from "../types";

function createPolicy(): StudioPermissionPolicyV1 {
  return {
    schema: "studio.policy.v1",
    version: 1,
    updatedAt: new Date().toISOString(),
    grants: [],
  };
}

describe("StudioPermissionManager", () => {
  it("allows filesystem access under granted scope", () => {
    const policy = createPolicy();
    policy.grants.push({
      id: "g1",
      capability: "filesystem",
      scope: {
        allowedPaths: ["SystemSculpt/Studio"],
      },
      grantedAt: new Date().toISOString(),
      grantedByUser: true,
    });

    const manager = new StudioPermissionManager(policy);
    expect(() => manager.assertFilesystemPath("SystemSculpt/Studio/Project/file.md")).not.toThrow();
    expect(() => manager.assertFilesystemPath("Other/file.md")).toThrow("Filesystem permission denied");
  });

  it("matches CLI allowlist wildcard patterns", () => {
    const policy = createPolicy();
    policy.grants.push({
      id: "g2",
      capability: "cli",
      scope: {
        allowedCommandPatterns: ["ffmpeg*", "echo"],
      },
      grantedAt: new Date().toISOString(),
      grantedByUser: true,
    });

    const manager = new StudioPermissionManager(policy);
    expect(() => manager.assertCliCommand("ffmpeg")).not.toThrow();
    expect(() => manager.assertCliCommand("ffprobe")).toThrow("CLI permission denied");
    expect(() => manager.assertCliCommand("echo")).not.toThrow();
  });

  it("enforces https allowlisted network domains", () => {
    const policy = createPolicy();
    policy.grants.push({
      id: "g3",
      capability: "network",
      scope: {
        allowedDomains: ["api.systemsculpt.com"],
      },
      grantedAt: new Date().toISOString(),
      grantedByUser: true,
    });

    const manager = new StudioPermissionManager(policy);
    expect(() => manager.assertNetworkUrl("https://api.systemsculpt.com/api/v1/agent/sessions")).not.toThrow();
    expect(() => manager.assertNetworkUrl("http://api.systemsculpt.com")).toThrow("HTTPS");
    expect(() => manager.assertNetworkUrl("https://example.com")).toThrow("Network permission denied");
  });
});

