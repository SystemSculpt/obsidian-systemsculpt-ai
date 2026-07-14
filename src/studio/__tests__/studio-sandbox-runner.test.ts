import { EventEmitter } from "node:events";
import { desktopHost } from "../../platform/desktopOnly";
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
        id: "grant_cli_node",
        capability: "cli",
        // Grant the specific command this test spawns. A bare "*" is no longer a
        // valid CLI pattern (SEC-03): it is stripped at policy-parse time and
        // refused inside the CLI gate, so fixtures must name real commands.
        scope: {
          allowedCommandPatterns: ["node"],
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      },
    ],
  };
}

describe("StudioSandboxRunner", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("closes stdin so non-interactive commands can finish immediately", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: jest.Mock<void, []> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: jest.Mock<boolean, [string]>;
    };

    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = jest.fn(() => true);
    child.stdin = {
      end: jest.fn(() => {
        queueMicrotask(() => {
          stdout.emit("data", "0");
          child.emit("close", 0);
        });
      }),
    };

    const spawn = jest.fn(() => child);
    jest.spyOn(desktopHost, "childProcess").mockReturnValue({ spawn } as never);
    jest.spyOn(desktopHost, "path").mockReturnValue({ delimiter: ":" } as never);
    jest.spyOn(desktopHost, "environment").mockReturnValue({ PATH: "/usr/bin" });

    const manager = new StudioPermissionManager(createPolicy());
    const runner = new StudioSandboxRunner(manager);
    const result = await runner.runCli({
      command: "node",
      args: ["read-stdin.mjs"],
      cwd: "/tmp/studio-sandbox-runner",
      timeoutMs: 100,
    });

    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["read-stdin.mjs"],
      expect.objectContaining({
        cwd: "/tmp/studio-sandbox-runner",
        shell: false,
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: 0,
      stdout: "0",
      stderr: "",
      timedOut: false,
    });
  });
});
