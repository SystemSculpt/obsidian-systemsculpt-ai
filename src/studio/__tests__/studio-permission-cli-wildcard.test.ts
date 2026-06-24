import { parseStudioPolicy } from "../schema";
import { StudioPermissionManager } from "../StudioPermissionManager";
import { STUDIO_POLICY_SCHEMA_V1 } from "../types";
import type { StudioPermissionPolicyV1 } from "../types";

/**
 * SEC-03 guard: a Studio policy file lives in the vault and can be shared /
 * synced / imported. A bare `"*"` CLI command pattern would grant arbitrary
 * local command execution on project open with no approval. The trust boundary
 * must refuse it both when the policy is parsed and inside the CLI gate
 * (defense-in-depth), while still honoring legitimate per-command patterns such
 * as the ffmpeg/ffprobe defaults (including path-prefix wildcards such as a
 * star-slash-ffmpeg pattern).
 */
describe("Studio CLI wildcard rejection (SEC-03)", () => {
  function policyWithCliPatterns(patterns: string[]): string {
    return JSON.stringify({
      schema: STUDIO_POLICY_SCHEMA_V1,
      version: 1,
      updatedAt: new Date().toISOString(),
      grants: [
        {
          id: "grant_cli",
          capability: "cli",
          scope: { allowedCommandPatterns: patterns },
          grantedAt: new Date().toISOString(),
          grantedByUser: true,
        },
      ],
    });
  }

  describe("parseStudioPolicy", () => {
    it("strips a bare \"*\" command pattern while keeping the rest", () => {
      const parsed = parseStudioPolicy(
        policyWithCliPatterns(["*", "ffmpeg", "*/ffmpeg", "ffprobe", "*/ffprobe"])
      );

      const cliGrant = parsed.grants.find((grant) => grant.capability === "cli");
      expect(cliGrant).toBeDefined();
      const patterns = cliGrant?.scope.allowedCommandPatterns || [];

      // The blanket grant is gone...
      expect(patterns).not.toContain("*");
      // ...but legitimate per-command patterns (incl. path-prefix wildcards) survive.
      expect(patterns).toEqual(["ffmpeg", "*/ffmpeg", "ffprobe", "*/ffprobe"]);
    });

    it("drops a whitespace-padded bare wildcard too", () => {
      const parsed = parseStudioPolicy(policyWithCliPatterns([" * ", "echo"]));
      const cliGrant = parsed.grants.find((grant) => grant.capability === "cli");
      const patterns = cliGrant?.scope.allowedCommandPatterns || [];
      expect(patterns).toEqual(["echo"]);
    });
  });

  describe("assertCliCommand", () => {
    function managerWithCliPatterns(patterns: string[]): StudioPermissionManager {
      const policy: StudioPermissionPolicyV1 = {
        schema: STUDIO_POLICY_SCHEMA_V1,
        version: 1,
        updatedAt: new Date().toISOString(),
        grants: [
          {
            id: "grant_cli",
            capability: "cli",
            scope: { allowedCommandPatterns: patterns },
            grantedAt: new Date().toISOString(),
            grantedByUser: true,
          },
        ],
      };
      return new StudioPermissionManager(policy);
    }

    it("refuses an arbitrary command even when a grant contains \"*\"", () => {
      // Defense-in-depth: a policy that bypassed parsing (e.g. set in-memory)
      // must still not grant everything via a bare wildcard.
      const manager = managerWithCliPatterns(["*"]);
      expect(() => manager.assertCliCommand("rm -rf /")).toThrow(
        "CLI permission denied"
      );
    });

    it("ignores a bare \"*\" but still honors a real pattern in the same grant", () => {
      const manager = managerWithCliPatterns(["*", "ffmpeg"]);
      expect(() => manager.assertCliCommand("rm -rf /")).toThrow(
        "CLI permission denied"
      );
      expect(() => manager.assertCliCommand("ffmpeg")).not.toThrow();
    });

    it("still allows commands matched by a path-prefix wildcard pattern", () => {
      const manager = managerWithCliPatterns(["*/ffmpeg"]);
      expect(() => manager.assertCliCommand("/usr/local/bin/ffmpeg")).not.toThrow();
    });
  });
});
