import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioPermissionManager } from "../StudioPermissionManager";
import { StudioSandboxRunner } from "../StudioSandboxRunner";
import type { StudioPermissionPolicyV1 } from "../types";

function createPolicy(): StudioPermissionPolicyV1 {
  return {
    schema: "studio.policy.v1",
    version: 1,
    updatedAt: new Date().toISOString(),
    grants: [
      {
        id: "grant_fs_all",
        capability: "filesystem",
        scope: {
          allowedPaths: ["*"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      },
      {
        id: "grant_cli_all",
        capability: "cli",
        scope: {
          allowedCommandPatterns: ["*"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      },
    ],
  };
}

describe("StudioSandboxRunner", () => {
  it("closes stdin so commands that read stdin do not hang", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "studio-sandbox-runner-"));
    const scriptPath = join(tempDir, "read-stdin.mjs");

    try {
      await writeFile(
        scriptPath,
        `let data = "";
for await (const chunk of process.stdin) {
  data += chunk;
}
process.stdout.write(String(data.length));
`,
        "utf8"
      );

      const manager = new StudioPermissionManager(createPolicy());
      const runner = new StudioSandboxRunner(manager);

      const result = await runner.runCli({
        command: "node",
        args: [scriptPath],
        cwd: tempDir,
        timeoutMs: 2_000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
